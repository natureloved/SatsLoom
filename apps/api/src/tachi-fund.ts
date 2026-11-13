import { randomUUID } from "node:crypto";
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
 * Merchant settlement is out of scope here on purpose: a Tachi-settled payment
 * to a third-party merchant needs 5-of-7 quorum cosignatures and the SDK only
 * exposes cosignRefund, so this flow covers vault funding / deposit / register
 * / exit only. No code path here claims a Tachi merchant transfer.
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

type JobRuntime = { adapter: TachiAdapter; vaultId: string };

const jobs = new Map<string, { job: TachiFundJob; runtime: JobRuntime | null }>();

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
async function runTachiFundJob(entry: { job: TachiFundJob; runtime: JobRuntime | null }, resumeStage?: TachiFundStage): Promise<void> {
  const { job } = entry;
  try {
    if (!resumeStage) {
      job.stage = "creating-vault";
      touch(job);
      const adapter = adapterFactory();
      const mnemonic = generateMnemonic();
      const vault = await adapter.createVault({ mnemonic });
      entry.runtime = { adapter, vaultId: vault.id };
      job.vaultAddress = vault.address;
      job.network = adapter.network;
      job.fundingAddress = adapter.getFundingAddress(vault.id);
      touch(job);
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
  const entry = { job, runtime: null as JobRuntime | null };
  jobs.set(job.id, entry);
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
  void runTachiFundJob(entry, "waiting-confirmation");
  return publicTachiFundJob(entry.job);
}
