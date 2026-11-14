import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateMnemonic } from "@tachibtc/taurus-wallet-aggregator";
import { TachiSdkAdapter, type TachiAdapter } from "@satsloom/tachi-adapter";

/**
 * Opt-in "Fund Tachi vault" flow.
 *
 * One job = one fresh disposable vault: create it, fund its P2WPKH wallet from
 * the public signet faucet, wait for a real block, deposit into the vault P2TR,
 * register the ledger VTXO. Every stage records the real transaction ids and
 * explorer links; a failure records the daemon/faucet error verbatim and the
 * job stops — nothing is ever faked, and a failed stage is never retried into
 * looking like a success.
 *
 * The flow is deliberately asynchronous: signet blocks average ~10 minutes, so
 * no HTTP request can wait for the whole run. POST starts the job and returns
 * 202; the caller polls GET until the job is complete, failed, or waiting for
 * manual funding. The job only progresses while this API process lives — a
 * serverless deployment that freezes between requests stalls the job, and the
 * status endpoint says so rather than pretending otherwise.
 *
 * Restart resilience: every job is persisted to a mode-600 file under
 * `apps/api/.data/tachi-fund-jobs/<jobId>.json` (gitignored, never committed)
 * the moment it is created, and re-written after every stage transition. The
 * file holds the mnemonic, so a server restart restores the job instead of
 * killing it: on start the server re-reads unfinished jobs and resumes them
 * from their recorded stage. The mnemonic never appears in logs, API
 * responses, or the public job record — only in that locked file. This is the
 * same trade-off as the DrawBound operator vault (mnemonic in a mode-600 file
 * instead of process memory only): anyone with read access to this machine can
 * read the file, so it is only acceptable for disposable signet-only vaults,
 * never for mainnet funds. A crash in the milliseconds between a transaction
 * being broadcast and its txid being persisted could still cause a repeated
 * deposit on resume; the persist is synchronous and happens immediately after
 * each txid is recorded, so that window is as small as this design allows.
 *
 * Merchant settlement is out of scope here on purpose: a Tachi-settled payment
 * to a third-party merchant needs 5-of-7 quorum cosignatures and the SDK only
 * exposes cosignRefund, so this flow covers vault funding / deposit / register
 * / exit only. No code path here claims a Tachi merchant transfer. Merchant
 * settlement lives in `tachi-pay-vault.ts` instead: the customer deposits L1
 * BTC into the merchant's persistent vault, which needs no cosign at all.
 */

export const TACHI_FUND_ENABLED_ENV = "SATSLOOM_TACHI_FUND_ENABLED";
export const TACHI_FUND_DEPOSIT_SATS_ENV = "SATSLOOM_TACHI_FUND_DEPOSIT_SATS";
export const DEFAULT_FUND_DEPOSIT_SATS = 100_000n;
/** Faucet claim asks for the deposit plus this reserve, mirroring the spike. */
const FAUCET_RESERVE_SATS = 25_000n;
/** A funding wallet below this cannot fund a deposit worth registering. */
const MIN_FUNDING_SATS = 1_000n;
/** How long the wait-for-confirmation stage polls before giving up. */
const CONFIRMATION_DEADLINE_MS = 90 * 60_000;
/** Poll interval while waiting for the faucet transaction to confirm. */
const CONFIRMATION_POLL_MS = 60_000;

export function isTachiFundEnabled(): boolean {
  return process.env[TACHI_FUND_ENABLED_ENV] === "true";
}

export function parseFundDepositSats(value: unknown): bigint {
  if (value === undefined || value === null || value === "") return DEFAULT_FUND_DEPOSIT_SATS;
  const parsed = typeof value === "bigint" ? value : BigInt(String(value));
  if (parsed <= 0n) throw new Error("depositSats must be a positive number of satoshis");
  return parsed;
}

export type TachiFundStage =
  | "creating-vault"
  | "claiming-faucet"
  | "awaiting-manual-funding"
  | "waiting-confirmation"
  | "depositing"
  | "registering"
  | "complete"
  | "failed";

export type TachiFundTxRecord = {
  txid: string;
  /** Tachi explorer link (https://signet.tachibtcscan.com/tx/<hash>). */
  explorerUrl: string;
  /** Bitcoin-layer explorer link, for L1 transactions (faucet claim, deposit). */
  bitcoinExplorerUrl?: string;
  sats?: string;
};

export type TachiFundJob = {
  id: string;
  status: "running" | "awaiting-manual-funding" | "complete" | "failed";
  stage: TachiFundStage;
  network: string;
  explorerUrl: string;
  vaultAddress: string | null;
  fundingAddress: string | null;
  depositRequestedSats: string;
  faucet: TachiFundTxRecord | null;
  deposit: (TachiFundTxRecord & { amountSats?: string }) | null;
  registration: { broadcastHash: string; explorerUrl: string; vtxoId: string; feeSats: string } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Everything the API returns for a job. No mnemonic, seed or key ever leaves this module. */
export function publicTachiFundJob(job: TachiFundJob): TachiFundJob {
  return { ...job };
}

type JobRuntime = { adapter: TachiAdapter; vaultId: string; mnemonic: string };

type JobEntry = { job: TachiFundJob; runtime: JobRuntime | null; mnemonic: string | null };

const jobs = new Map<string, JobEntry>();

/** Env override for the jobs directory (tests point it at a temp dir). */
export const TACHI_FUND_JOBS_DIR_ENV = "SATSLOOM_TACHI_FUND_JOBS_DIR";

/**
 * Where job records live. The server is started from apps/api, so the
 * default is apps/api/.data/tachi-fund-jobs; the env override exists for
 * tests and for runs started from elsewhere.
 */
export function tachiFundJobsDir(): string {
  return process.env[TACHI_FUND_JOBS_DIR_ENV] ?? resolve(process.cwd(), ".data", "tachi-fund-jobs");
}

type PersistedFundJob = { version: 1; job: TachiFundJob; mnemonic: string | null; vaultId: string | null };

function jobFilePath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * Writes the job record (including its mnemonic) to a mode-600 file.
 * `required: true` throws on failure — used when the record must exist before
 * the run can safely proceed (job creation, vault creation). Stage updates
 * are best-effort: the mnemonic is already on disk from vault creation, so a
 * failed stage write leaves a recoverable, merely stale record.
 */
function persistEntry(entry: JobEntry, required: boolean): void {
  const record: PersistedFundJob = {
    version: 1,
    job: entry.job,
    mnemonic: entry.mnemonic,
    vaultId: entry.runtime?.vaultId ?? null,
  };
  try {
    const dir = tachiFundJobsDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const tmp = `${jobFilePath(dir, entry.job.id)}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    chmodSync(tmp, 0o600);
    renameSync(tmp, jobFilePath(dir, entry.job.id));
  } catch (error) {
    if (required) throw error;
    console.error(`[tachi-fund] failed to persist job ${entry.job.id}:`, error instanceof Error ? error.message : String(error));
  }
}

export function listTachiFundJobs(): TachiFundJob[] {
  return [...jobs.values()].map(({ job }) => publicTachiFundJob(job));
}

export function getTachiFundJob(id: string): TachiFundJob | null {
  const entry = jobs.get(id);
  return entry ? publicTachiFundJob(entry.job) : null;
}

type AdapterFactory = () => TachiAdapter;
let adapterFactory: AdapterFactory = () => new TachiSdkAdapter();

/** Test hook: swap the adapter factory so the runner can be driven without a daemon. */
export function setTachiFundAdapterFactory(factory: AdapterFactory | null): void {
  adapterFactory = factory ?? (() => new TachiSdkAdapter());
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function touch(job: TachiFundJob): void {
  job.updatedAt = new Date().toISOString();
  // Best-effort: the mnemonic is already on disk from vault creation, so a
  // failed stage write leaves a recoverable, merely stale record.
  const entry = [...jobs.values()].find((candidate) => candidate.job === job);
  if (entry) persistEntry(entry, false);
}

/** Test hook: drop every in-memory job without touching the persisted files. */
export function clearTachiFundJobs(): void {
  jobs.clear();
}

function resumeStageFor(job: TachiFundJob): TachiFundStage | null {
  switch (job.stage) {
    case "creating-vault":
      // The vault was created (its mnemonic is on disk) but the faucet claim
      // never started; resume there. A record with no mnemonic at all is
      // restarted from scratch by the caller instead.
      return "claiming-faucet";
    case "claiming-faucet":
      return job.faucet ? "waiting-confirmation" : "claiming-faucet";
    case "waiting-confirmation":
      return "waiting-confirmation";
    case "depositing":
      return job.deposit ? "registering" : "depositing";
    case "registering":
      return "registering";
    default:
      // complete, failed, awaiting-manual-funding: nothing to resume.
      return null;
  }
}

/**
 * Restores unfinished jobs from their persisted files after a restart, and
 * resumes any that were mid-run from their recorded stage. A job waiting for
 * manual funding is restored but not resumed — it still needs its continue
 * call. Returns the restored public jobs. Corrupt files are logged and
 * skipped, never fatal: one bad record must not block the rest.
 */
export function restoreTachiFundJobs(): TachiFundJob[] {
  const dir = tachiFundJobsDir();
  if (!existsSync(dir)) return [];
  const restored: TachiFundJob[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    let record: PersistedFundJob;
    try {
      record = JSON.parse(readFileSync(join(dir, file), "utf8")) as PersistedFundJob;
    } catch (error) {
      console.error(`[tachi-fund] skipping unreadable job file ${file}:`, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!record?.job?.id || jobs.has(record.job.id)) continue;
    const entry: JobEntry = { job: record.job, runtime: null, mnemonic: record.mnemonic ?? null };
    jobs.set(record.job.id, entry);
    restored.push(publicTachiFundJob(record.job));
    if (record.job.status !== "running") continue;
    if (!entry.mnemonic) {
      // No vault was ever persisted for this job: restart it from scratch
      // with a fresh vault rather than resuming a run that has no keys.
      entry.job.stage = "creating-vault";
      entry.job.error = null;
      void runTachiFundJob(entry);
      continue;
    }
    const resumeStage = resumeStageFor(record.job);
    if (resumeStage) void runTachiFundJob(entry, resumeStage);
  }
  return restored;
}

function bitcoinExplorerUrl(txid: string, network: string): string {
  const host = network === "regtest" ? "mempool.space/regtest" : "mempool.space/signet";
  return `https://${host}/tx/${encodeURIComponent(txid)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the job to completion (or to awaiting-manual-funding / failed). Callers
 * must not await this: it blocks for however long signet takes. Errors are
 * recorded on the job verbatim, never thrown to the caller.
 */
async function runTachiFundJob(entry: JobEntry, resumeStage?: TachiFundStage): Promise<void> {
  const { job } = entry;
  try {
    if (!resumeStage) {
      job.stage = "creating-vault";
      touch(job);
      const adapter = adapterFactory();
      const mnemonic = generateMnemonic();
      const vault = await adapter.createVault({ mnemonic });
      entry.runtime = { adapter, vaultId: vault.id, mnemonic };
      entry.mnemonic = mnemonic;
      job.vaultAddress = vault.address;
      job.network = adapter.network;
      job.fundingAddress = adapter.getFundingAddress(vault.id);
      touch(job);
      // The mnemonic must be on disk before any funds can arrive: a crash
      // after this point must not strand the vault. Fail the job outright if
      // the record cannot be written.
      persistEntry(entry, true);
    }
    if (!entry.runtime) {
      // Restored job: re-derive the vault from the stored mnemonic. The
      // derivation is deterministic (same mnemonic + same quorum = same P2TR),
      // so a mismatch means the record does not belong to this vault.
      if (!entry.mnemonic) throw new Error("Fund job has no adapter instance or stored mnemonic; it cannot resume");
      const adapter = adapterFactory();
      const vault = await adapter.createVault({ mnemonic: entry.mnemonic });
      if (job.vaultAddress && vault.address !== job.vaultAddress) {
        throw new Error(`Restored vault address mismatch: derived ${vault.address}, expected ${job.vaultAddress}`);
      }
      entry.runtime = { adapter, vaultId: vault.id, mnemonic: entry.mnemonic };
    }
    const runtime = entry.runtime;
    if (!runtime) throw new Error("Fund job has no adapter instance; it cannot resume");
    const { adapter, vaultId } = runtime;

    if (!resumeStage || resumeStage === "claiming-faucet") {
      job.stage = "claiming-faucet";
      job.status = "running";
      touch(job);
      const amountBtc = Number(BigInt(job.depositRequestedSats) + FAUCET_RESERVE_SATS) / 100_000_000;
      let claim: { txid: string; sats: bigint } | null;
      try {
        claim = await adapter.claimFaucetFunds(vaultId, amountBtc);
      } catch (error) {
        // The faucet hung or errored: the operator can still fund the wallet
        // from a browser and continue — record the failure verbatim and wait.
        job.stage = "awaiting-manual-funding";
        job.status = "awaiting-manual-funding";
        job.error = describeError(error);
        touch(job);
        return;
      }
      if (!claim) {
        job.stage = "awaiting-manual-funding";
        job.status = "awaiting-manual-funding";
        job.error =
          "The public faucet declined the claim (no transaction id returned — declined or rate-limited). " +
          `Fund ${job.fundingAddress} from a signet faucet and continue.`;
        touch(job);
        return;
      }
      job.faucet = {
        txid: claim.txid,
        explorerUrl: adapter.getExplorerUrl(claim.txid),
        bitcoinExplorerUrl: bitcoinExplorerUrl(claim.txid, job.network),
        sats: claim.sats.toString(),
      };
      touch(job);
    }

    if (!resumeStage || resumeStage === "waiting-confirmation" || resumeStage === "claiming-faucet") {
      job.stage = "waiting-confirmation";
      job.status = "running";
      job.error = null;
      touch(job);
      // The daemon's scantxoutset cannot see the mempool, so the faucet UTXO
      // is invisible until a block confirms it. Poll the funding wallet's
      // confirmed balance (daemon RPC only — no mempool.space dependency).
      const deadline = Date.now() + CONFIRMATION_DEADLINE_MS;
      for (;;) {
        const balance = await adapter.getFundingWalletBalance(vaultId);
        if (balance >= MIN_FUNDING_SATS) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `No confirmed funds reached the funding wallet within 90 minutes ` +
              `(last confirmed balance: ${balance} sats). Signet blocks average ~10 minutes; ` +
              `check the faucet transaction ${job.faucet?.txid ?? "(none)"} and continue.`,
          );
        }
        await sleep(CONFIRMATION_POLL_MS);
      }
    }

    if (!resumeStage || resumeStage === "depositing" || resumeStage === "waiting-confirmation" || resumeStage === "claiming-faucet") {
      job.stage = "depositing";
      touch(job);
      const result = await adapter.depositToVault(vaultId, BigInt(job.depositRequestedSats));
      job.deposit = {
        txid: result.txid,
        explorerUrl: adapter.getExplorerUrl(result.txid),
        bitcoinExplorerUrl: bitcoinExplorerUrl(result.txid, job.network),
        amountSats: result.amountSats.toString(),
      };
      touch(job);
    }

    job.stage = "registering";
    touch(job);
    const depositSats = BigInt(job.deposit?.amountSats ?? job.depositRequestedSats);
    const registered = await adapter.registerDeposit(vaultId, depositSats);
    job.registration = {
      broadcastHash: registered.broadcastHash,
      explorerUrl: adapter.getExplorerUrl(registered.broadcastHash),
      vtxoId: registered.vtxoId,
      feeSats: registered.feeSats.toString(),
    };
    job.stage = "complete";
    job.status = "complete";
    touch(job);
  } catch (error) {
    // A daemon failure is recorded verbatim; the job stops here so a caller
    // can see exactly what failed instead of a faked success.
    job.stage = "failed";
    job.status = "failed";
    job.error = describeError(error);
    touch(job);
  }
}

/** Starts a fund job and returns it immediately; the runner proceeds in the background. */
export function startTachiFundJob(depositRequestedSats: bigint): TachiFundJob {
  const now = new Date().toISOString();
  const job: TachiFundJob = {
    id: randomUUID(),
    status: "running",
    stage: "creating-vault",
    network: "signet",
    explorerUrl: "https://signet.tachibtcscan.com",
    vaultAddress: null,
    fundingAddress: null,
    depositRequestedSats: depositRequestedSats.toString(),
    faucet: null,
    deposit: null,
    registration: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  const entry: JobEntry = { job, runtime: null, mnemonic: null };
  jobs.set(job.id, entry);
  try {
    // Fail fast if the record cannot be written: a job that starts without a
    // persisted record is exactly the unrecoverable run this file prevents.
    persistEntry(entry, true);
  } catch (error) {
    jobs.delete(job.id);
    throw error;
  }
  void runTachiFundJob(entry);
  return publicTachiFundJob(job);
}

/**
 * Resumes a job that is waiting for manual funding. Only valid from
 * `awaiting-manual-funding`; anything else is a caller error, not a retry.
 */
export function continueTachiFundJob(id: string): TachiFundJob | null {
  const entry = jobs.get(id);
  if (!entry) return null;
  if (entry.job.status !== "awaiting-manual-funding") {
    throw new Error(`Fund job ${id} is ${entry.job.status} (stage ${entry.job.stage}); only a job awaiting manual funding can be continued`);
  }
  entry.job.error = null;
  touch(entry.job);
  void runTachiFundJob(entry, "waiting-confirmation");
  return publicTachiFundJob(entry.job);
}
