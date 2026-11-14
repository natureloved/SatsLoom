import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ensureMerchantVault,
  getMerchantVault,
  getMerchantVaultRuntime,
  isDepositConsumed,
  markDepositConsumed,
} from "./tachi-merchant-vault.ts";
import type { TachiAdapter } from "@satsloom/tachi-adapter";

/**
 * Pay-to-vault invoice settlement: a customer pays an invoice by depositing
 * L1 BTC (signet) straight into the merchant's Tachi vault, and this module
 * watches the vault address, registers the deposit as a VTXO (TxVaultOpen),
 * and marks the invoice paid.
 *
 * This is the alternative to a cooperative Tachi transfer, which needs 5-of-7
 * quorum cosignatures the SDK does not expose: a deposit is a plain Bitcoin
 * transaction the customer's wallet signs alone, so no cosign is involved at
 * any step. The honest claim is "payment settles into the merchant's Tachi
 * vault" — never a Tachi transfer to a third party, and the cosign problem is
 * not solved by this flow.
 *
 * How a payment is recognised, exactly:
 * - The watcher scans the merchant vault's P2TR address for confirmed
 *   unspent outputs (the daemon's `scantxoutset`, retried on the shared
 *   scan lock, like the fund flow).
 * - A deposit matches only when its amount equals the invoice amount
 *   *exactly* and its txid has not already been settled. An over- or
 *   under-payment is not silently accepted as a different amount, and a
 *   deposit's L1 output stays unspent after registration, so the consumed
 *   list is what stops a second invoice of the same amount re-matching it.
 * - Registration uses the adapter's `registerDeposit`, which returns an
 *   already-registered VTXO (empty broadcast hash) when one exists for the
 *   amount. That early return is load-bearing for crash recovery — a restart
 *   between broadcast and persist must find the same VTXO — but it cannot
 *   tell a fresh registration from an older payment's VTXO. So the runner
 *   snapshots the unspent VTXO ids for this amount *before* registering: an
 *   empty-hash result whose VTXO was already there belongs to an earlier
 *   payment and fails the run with a clear error instead of misattributing
 *   it; an empty-hash result whose VTXO is new is the crash-recovery case
 *   and is accepted. A non-empty hash is always a fresh registration.
 *
 * Same-amount limitation, stated plainly: two invoices for the same amount
 * cannot both be settled through one merchant vault unless the first payment's
 * VTXO is spent first, because `registerDeposit` is keyed by amount and the
 * VTXO record carries no deposit txid to disambiguate with. The runner fails
 * the second payment loudly rather than crediting the wrong VTXO. Distinct
 * invoice amounts settle fine, one after another.
 *
 * Persistence mirrors the fund jobs: every payment is written to a mode-600
 * file under `apps/api/.data/tachi-payments/<paymentId>.json` the moment it is
 * created, and re-written after every stage transition, so a restart resumes
 * an unfinished payment from its recorded stage. Payment records hold no
 * mnemonic — the merchant vault file holds that. The settlement callback
 * (`onSettled`) is owned by the server (it confirms the invoice and records
 * the settlement); it cannot be persisted, so restores re-attach the server's
 * callback when they resume a payment.
 *
 * Failures are recorded verbatim and the payment stops — nothing is ever
 * faked, and a failed stage is never retried into looking like a success. A
 * failed payment can be retried explicitly (POST …/retry), which resumes from
 * its recorded stage.
 */

export const TACHI_PAY_VAULT_POLL_MS_ENV = "SATSLOOM_TACHI_PAY_VAULT_POLL_MS";
export const TACHI_PAY_VAULT_DEADLINE_MS_ENV = "SATSLOOM_TACHI_PAY_VAULT_DEADLINE_MS";
/** How long the watcher waits for the deposit before giving up. */
export const DEFAULT_PAY_VAULT_DEADLINE_MS = 90 * 60_000;
/** Poll interval while waiting for the deposit to confirm. */
export const DEFAULT_PAY_VAULT_POLL_MS = 60_000;

export function tachiPayVaultPollMs(): number {
  const raw = Number(process.env[TACHI_PAY_VAULT_POLL_MS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PAY_VAULT_POLL_MS;
}

export function tachiPayVaultDeadlineMs(): number {
  const raw = Number(process.env[TACHI_PAY_VAULT_DEADLINE_MS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PAY_VAULT_DEADLINE_MS;
}

export type TachiPayVaultStage = "awaiting-payment" | "deposit-found" | "registering" | "paid";

export type TachiPayVaultTxRecord = {
  txid: string;
  /** Tachi explorer link (https://signet.tachibtcscan.com/tx/<hash>). */
  explorerUrl: string;
  /** Bitcoin-layer explorer link, for L1 transactions (the deposit). */
  bitcoinExplorerUrl?: string;
  amountSats?: string;
};

export type TachiPayVaultPayment = {
  id: string;
  invoiceId: string;
  merchantId: string;
  amountSats: string;
  vaultAddress: string;
  status: "watching" | "paid" | "failed";
  stage: TachiPayVaultStage;
  network: string;
  explorerUrl: string;
  deposit: TachiPayVaultTxRecord | null;
  registration: { broadcastHash: string; explorerUrl: string; vtxoId: string; feeSats: string } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Everything the API returns for a payment. No internal bookkeeping. */
export function publicTachiPayVaultPayment(payment: TachiPayVaultPayment): TachiPayVaultPayment {
  return { ...payment };
}

/** Called by the server when a payment settles: confirm the invoice, record the settlement. */
export type TachiPayVaultSettledHandler = (payment: TachiPayVaultPayment) => Promise<void> | void;

type PaymentEntry = {
  payment: TachiPayVaultPayment;
  /** Unspent VTXO ids for this amount seen before registering (attribution check). */
  priorVtxoIds: string[] | null;
  onSettled: TachiPayVaultSettledHandler | null;
};

const payments = new Map<string, PaymentEntry>();

/** Env override for the payments directory (tests point it at a temp dir). */
export const TACHI_PAY_VAULT_PAYMENTS_DIR_ENV = "SATSLOOM_TACHI_PAY_VAULT_PAYMENTS_DIR";

export function tachiPayVaultPaymentsDir(): string {
  return process.env[TACHI_PAY_VAULT_PAYMENTS_DIR_ENV] ?? resolve(process.cwd(), ".data", "tachi-payments");
}

type PersistedPayVaultPayment = { version: 1; payment: TachiPayVaultPayment; priorVtxoIds: string[] | null };

function paymentFilePath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function persistEntry(entry: PaymentEntry, required: boolean): void {
  const record: PersistedPayVaultPayment = {
    version: 1,
    payment: entry.payment,
    priorVtxoIds: entry.priorVtxoIds,
  };
  try {
    const dir = tachiPayVaultPaymentsDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const tmp = `${paymentFilePath(dir, entry.payment.id)}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    chmodSync(tmp, 0o600);
    renameSync(tmp, paymentFilePath(dir, entry.payment.id));
  } catch (error) {
    if (required) throw error;
    console.error(`[tachi-pay-vault] failed to persist payment ${entry.payment.id}:`, error instanceof Error ? error.message : String(error));
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function touch(payment: TachiPayVaultPayment): void {
  payment.updatedAt = new Date().toISOString();
  const entry = [...payments.values()].find((candidate) => candidate.payment === payment);
  if (entry) persistEntry(entry, false);
}

/** Test hook: drop every in-memory payment without touching the persisted files. */
export function clearTachiPayVaultPayments(): void {
  payments.clear();
}

export function listTachiPayVaultPayments(): TachiPayVaultPayment[] {
  return [...payments.values()].map(({ payment }) => publicTachiPayVaultPayment(payment));
}

export function getTachiPayVaultPayment(id: string): TachiPayVaultPayment | null {
  const entry = payments.get(id);
  return entry ? publicTachiPayVaultPayment(entry.payment) : null;
}

function bitcoinExplorerUrl(txid: string, network: string): string {
  const host = network === "regtest" ? "mempool.space/regtest" : "mempool.space/signet";
  return `https://${host}/tx/${encodeURIComponent(txid)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True while this runner is still the payment's live runner. A simulated (or
 * real) restart drops the in-memory map and restores a fresh entry; the old
 * runner must then stop quietly instead of racing the resumed one to settle
 * the same deposit.
 */
function isCurrent(entry: PaymentEntry): boolean {
  return payments.get(entry.payment.id) === entry;
}

/**
 * Runs the payment to paid (or failed). Callers must not await this: it blocks
 * for however long signet takes to confirm the deposit. Errors are recorded
 * on the payment verbatim, never thrown to the caller.
 */
async function runTachiPayVaultPayment(entry: PaymentEntry, resumeStage?: TachiPayVaultStage): Promise<void> {
  const { payment } = entry;
  try {
    const runtime = getMerchantVaultRuntime();
    if (!runtime) throw new Error("No merchant vault exists; create one first (POST /api/tachi/merchant-vault)");
    const { adapter, vaultId } = runtime;

    if (!resumeStage || resumeStage === "awaiting-payment") {
      payment.stage = "awaiting-payment";
      payment.status = "watching";
      touch(payment);
      // The daemon's scantxoutset cannot see the mempool, so the deposit is
      // invisible until a block confirms it. Poll the vault address (daemon
      // RPC only — no mempool.space dependency).
      const deadline = Date.now() + tachiPayVaultDeadlineMs();
      for (;;) {
        if (!isCurrent(entry)) return;
        const deposits = await adapter.listConfirmedVaultDeposits(vaultId);
        const match = deposits.find(
          (deposit) => deposit.amountSats === BigInt(payment.amountSats) && !isDepositConsumed(deposit.txid),
        );
        if (match) {
          payment.deposit = {
            txid: match.txid,
            // The deposit is an L1 Bitcoin transaction: the Tachi explorer
            // does not index L1 txs, so its link renders an empty page. The
            // mempool.space link is the verifiable one; both are recorded.
            explorerUrl: adapter.getExplorerUrl(match.txid),
            bitcoinExplorerUrl: bitcoinExplorerUrl(match.txid, payment.network),
            amountSats: match.amountSats.toString(),
          };
          payment.stage = "deposit-found";
          touch(payment);
          break;
        }
        if (Date.now() >= deadline) {
          const deadlineMs = tachiPayVaultDeadlineMs();
          const deadlineText = deadlineMs >= 60_000 ? `${Math.round(deadlineMs / 60_000)} minutes` : `${Math.round(deadlineMs / 1000)} seconds`;
          throw new Error(
            `No ${payment.amountSats}-sat deposit reached the merchant vault within ${deadlineText} ` +
              `(vault ${payment.vaultAddress}). Signet blocks average ~10 minutes; pay exactly ${payment.amountSats} sats to the vault address and retry.`,
          );
        }
        await sleep(tachiPayVaultPollMs());
      }
    }

    if (!isCurrent(entry)) return;
    if (!resumeStage || resumeStage === "deposit-found" || resumeStage === "awaiting-payment") {
      // Snapshot the VTXOs already registered for this amount, before this
      // deposit's registration. The attribution check below needs this list.
      const unspent = await adapter.listUnspentVtxos(vaultId);
      entry.priorVtxoIds = unspent
        .filter((vtxo) => vtxo.amountSats === BigInt(payment.amountSats))
        .map((vtxo) => vtxo.id);
      persistEntry(entry, false);
    }

    if (!payment.deposit) throw new Error("Payment has no recorded deposit; it cannot be registered");
    if (!isCurrent(entry)) return;
    payment.stage = "registering";
    touch(payment);
    const registered = await adapter.registerDeposit(vaultId, BigInt(payment.amountSats));
    if (!registered.broadcastHash) {
      // The adapter found an already-registered VTXO for this amount. Accept
      // it only when it was not there before this deposit (a previous attempt
      // registered it and the record was lost to a restart); when it was
      // already there, it belongs to an earlier payment and must not be
      // attributed to this one.
      const prior = entry.priorVtxoIds;
      if (prior === null) {
        throw new Error(
          `Registration returned an already-registered VTXO (${registered.vtxoId}) with no broadcast hash, and the pre-registration snapshot is missing, so this deposit cannot be attributed to it. Retry the payment.`,
        );
      }
      if (prior.includes(registered.vtxoId)) {
        throw new Error(
          `A VTXO for ${payment.amountSats} sats is already registered in the merchant vault (${registered.vtxoId}); the new deposit cannot be attributed to a fresh registration. Settle the next invoice for a distinct amount, or spend the existing VTXO first.`,
        );
      }
    }
    payment.registration = {
      broadcastHash: registered.broadcastHash,
      explorerUrl: adapter.getExplorerUrl(registered.broadcastHash),
      vtxoId: registered.vtxoId,
      feeSats: registered.feeSats.toString(),
    };
    // The deposit is settled: mark it consumed before anything else, so a
    // restart from here cannot credit the same deposit twice.
    markDepositConsumed(payment.deposit.txid);
    payment.stage = "paid";
    payment.status = "paid";
    touch(payment);

    // The money moved; the server now confirms the invoice and records the
    // settlement. If that bookkeeping throws, the payment stays paid (the
    // VTXO is real) and the error is recorded on it for the operator.
    if (isCurrent(entry) && entry.onSettled) {
      try {
        await entry.onSettled(publicTachiPayVaultPayment(payment));
      } catch (error) {
        payment.error = `Invoice bookkeeping failed after settlement: ${describeError(error)}`;
        touch(payment);
        console.error(`[tachi-pay-vault] payment ${payment.id} settled on-chain but the invoice was not confirmed:`, describeError(error));
      }
    }
  } catch (error) {
    // A daemon failure is recorded verbatim; the payment stops here so a
    // caller can see exactly what failed instead of a faked success. The
    // stage is left where it failed (not overwritten with "failed"), so a
    // retry knows where to resume from.
    payment.status = "failed";
    payment.error = describeError(error);
    touch(payment);
  }
}

/**
 * Starts a pay-vault payment for an invoice and returns it immediately; the
 * watcher proceeds in the background. The merchant vault must already exist.
 */
export function startTachiPayVaultPayment(
  invoiceId: string,
  amountSats: bigint,
  onSettled: TachiPayVaultSettledHandler | null,
): TachiPayVaultPayment {
  const vault = getMerchantVault();
  if (!vault) throw new Error("No merchant vault exists; create one first (POST /api/tachi/merchant-vault)");
  const now = new Date().toISOString();
  const payment: TachiPayVaultPayment = {
    id: randomUUID(),
    invoiceId,
    merchantId: vault.merchantId,
    amountSats: amountSats.toString(),
    vaultAddress: vault.vaultAddress,
    status: "watching",
    stage: "awaiting-payment",
    network: vault.network,
    explorerUrl: "https://signet.tachibtcscan.com",
    deposit: null,
    registration: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  const entry: PaymentEntry = { payment, priorVtxoIds: null, onSettled };
  payments.set(payment.id, entry);
  try {
    // Fail fast if the record cannot be written: a payment that starts
    // without a persisted record is exactly the unrecoverable run this file
    // prevents.
    persistEntry(entry, true);
  } catch (error) {
    payments.delete(payment.id);
    throw error;
  }
  void runTachiPayVaultPayment(entry);
  return publicTachiPayVaultPayment(payment);
}

/**
 * Retries a failed payment, resuming from its recorded stage. Only valid from
 * `failed`; anything else is a caller error, not a retry.
 */
export function retryTachiPayVaultPayment(id: string, onSettled: TachiPayVaultSettledHandler | null): TachiPayVaultPayment | null {
  const entry = payments.get(id);
  if (!entry) return null;
  if (entry.payment.status !== "failed") {
    throw new Error(`Payment ${id} is ${entry.payment.status} (stage ${entry.payment.stage}); only a failed payment can be retried`);
  }
  entry.payment.error = null;
  if (onSettled) entry.onSettled = onSettled;
  touch(entry.payment);
  // The stage was left where the run failed, so resume from exactly there.
  const resumeStage: TachiPayVaultStage =
    entry.payment.stage === "deposit-found" || entry.payment.stage === "registering" ? entry.payment.stage : "awaiting-payment";
  void runTachiPayVaultPayment(entry, resumeStage);
  return publicTachiPayVaultPayment(entry.payment);
}

/**
 * Restores unfinished payments from their persisted files after a restart,
 * and resumes any that were mid-run from their recorded stage. The server's
 * settlement callback is re-attached, so a resumed payment can still confirm
 * its invoice. Returns the restored public payments.
 */
export function restoreTachiPayVaultPayments(onSettled: TachiPayVaultSettledHandler | null): TachiPayVaultPayment[] {
  const dir = tachiPayVaultPaymentsDir();
  if (!existsSync(dir)) return [];
  const restored: TachiPayVaultPayment[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    let record: PersistedPayVaultPayment;
    try {
      record = JSON.parse(readFileSync(join(dir, file), "utf8")) as PersistedPayVaultPayment;
    } catch (error) {
      console.error(`[tachi-pay-vault] skipping unreadable payment file ${file}:`, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!record?.payment?.id || payments.has(record.payment.id)) continue;
    const entry: PaymentEntry = { payment: record.payment, priorVtxoIds: record.priorVtxoIds ?? null, onSettled };
    payments.set(record.payment.id, entry);
    restored.push(publicTachiPayVaultPayment(record.payment));
    if (record.payment.status !== "watching") continue;
    const resumeStage: TachiPayVaultStage =
      record.payment.stage === "deposit-found" || record.payment.stage === "registering" ? record.payment.stage : "awaiting-payment";
    void runTachiPayVaultPayment(entry, resumeStage);
  }
  return restored;
}

// Re-exported so the server can ensure the vault before starting a payment.
export { ensureMerchantVault };
