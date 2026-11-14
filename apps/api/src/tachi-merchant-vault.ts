import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateMnemonic } from "@tachibtc/taurus-wallet-aggregator";
import { TachiSdkAdapter, type TachiAdapter } from "@satsloom/tachi-adapter";

/**
 * The merchant's Tachi vault: one persistent vault for the demo merchant
 * (`merchant-demo`), created once from the live quorum and reused for every
 * pay-to-vault invoice.
 *
 * This is the other half of the pay-to-vault model. A customer pays an invoice
 * by depositing L1 BTC (signet) straight into this vault's P2TR address — a
 * plain Bitcoin transaction the customer's wallet signs alone, so no 5-of-7
 * quorum cosign is involved — and the API watches the address, registers the
 * deposit as a VTXO (TxVaultOpen), and marks the invoice paid. The merchant's
 * funds live in Tachi as VTXOs; they can be exited unilaterally later.
 *
 * What this is NOT: a Tachi transfer to a third party. Nothing here moves a
 * VTXO between owners, and the cosign problem is not solved — a cooperative
 * transfer still needs 5-of-7 validator signatures and the SDK exposes only
 * `cosignRefund`. The payment settles *into* the merchant's vault; that is the
 * whole claim, and the copy everywhere must say exactly that.
 *
 * Persistence mirrors the fund jobs: the record (including its mnemonic) is
 * written to a mode-600 file the moment the vault is created, and re-read on
 * server start, so a restart resumes the merchant instead of stranding its
 * vault. Same trade-off as the fund jobs (recoverability over memory-only
 * secrecy), only acceptable for disposable signet-only vaults, never for
 * mainnet funds. The mnemonic never appears in logs, API responses, or the
 * public vault record — only in that locked file.
 *
 * The record also tracks which deposit txids have already been settled
 * (`consumedDepositTxids`). A deposit's L1 output stays unspent after
 * registration, so without this list a later invoice of the same amount would
 * re-match the same deposit and be credited twice.
 */

export const MERCHANT_ID = "merchant-demo";

/** Env override for the vault file (tests point it at a temp dir). */
export const TACHI_MERCHANT_VAULT_FILE_ENV = "SATSLOOM_TACHI_MERCHANT_VAULT_FILE";

export function tachiMerchantVaultFile(): string {
  return process.env[TACHI_MERCHANT_VAULT_FILE_ENV] ?? resolve(process.cwd(), ".data", "tachi-merchant-vault.json");
}

export type MerchantVault = {
  merchantId: string;
  vaultAddress: string;
  /** The vault's own P2WPKH funding wallet. Unused for receiving: deposits go to the P2TR. */
  fundingAddress: string | null;
  network: string;
  explorerUrl: string;
  createdAt: string;
  updatedAt: string;
};

/** Everything the API returns for the merchant vault. No mnemonic, ever. */
export function publicMerchantVault(vault: MerchantVault): MerchantVault {
  return { ...vault };
}

type PersistedMerchantVault = {
  version: 1;
  vault: MerchantVault;
  mnemonic: string | null;
  vaultId: string | null;
  consumedDepositTxids: string[];
};

type AdapterFactory = () => TachiAdapter;
let adapterFactory: AdapterFactory = () => new TachiSdkAdapter();

/** Test hook: swap the adapter factory so the vault can be created without a daemon. */
export function setTachiMerchantVaultAdapterFactory(factory: AdapterFactory | null): void {
  adapterFactory = factory ?? (() => new TachiSdkAdapter());
}

type VaultRuntime = { adapter: TachiAdapter; vaultId: string; mnemonic: string };

let entry: { vault: MerchantVault; runtime: VaultRuntime | null; mnemonic: string | null; consumedDepositTxids: string[] } | null = null;

function persist(required: boolean): void {
  if (!entry) return;
  const record: PersistedMerchantVault = {
    version: 1,
    vault: entry.vault,
    mnemonic: entry.mnemonic,
    vaultId: entry.runtime?.vaultId ?? null,
    consumedDepositTxids: entry.consumedDepositTxids,
  };
  const file = tachiMerchantVaultFile();
  try {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    if (required) throw error;
    console.error("[tachi-merchant-vault] failed to persist merchant vault:", error instanceof Error ? error.message : String(error));
  }
}

/** Test hook: drop the in-memory vault without touching the persisted file. */
export function clearMerchantVault(): void {
  entry = null;
}

export function getMerchantVault(): MerchantVault | null {
  return entry ? publicMerchantVault(entry.vault) : null;
}

/** Adapter + vault id the pay-to-vault runner needs. Null until the vault exists. */
export function getMerchantVaultRuntime(): { adapter: TachiAdapter; vaultId: string } | null {
  return entry?.runtime ? { adapter: entry.runtime.adapter, vaultId: entry.runtime.vaultId } : null;
}

export function isDepositConsumed(txid: string): boolean {
  return entry?.consumedDepositTxids.includes(txid.toLowerCase()) ?? false;
}

/**
 * Marks a deposit txid as settled, so a later invoice of the same amount
 * cannot re-match it. Persisted immediately: the L1 output stays unspent
 * after registration, so this list is the only thing stopping a double credit.
 */
export function markDepositConsumed(txid: string): void {
  if (!entry) return;
  const normalized = txid.toLowerCase();
  if (!entry.consumedDepositTxids.includes(normalized)) {
    entry.consumedDepositTxids.push(normalized);
    entry.vault.updatedAt = new Date().toISOString();
    persist(false);
  }
}

/**
 * Creates the merchant vault if it does not exist yet, and returns it. The
 * mnemonic must be on disk before the address is ever shown: a crash after
 * this point must not strand the vault. Fail outright if the record cannot
 * be written.
 */
export async function ensureMerchantVault(): Promise<MerchantVault> {
  if (entry) return publicMerchantVault(entry.vault);
  const adapter = adapterFactory();
  const mnemonic = generateMnemonic();
  const vault = await adapter.createVault({ mnemonic });
  const now = new Date().toISOString();
  entry = {
    vault: {
      merchantId: MERCHANT_ID,
      vaultAddress: vault.address,
      fundingAddress: adapter.getFundingAddress(vault.id),
      network: adapter.network,
      explorerUrl: "https://signet.tachibtcscan.com",
      createdAt: now,
      updatedAt: now,
    },
    runtime: { adapter, vaultId: vault.id, mnemonic },
    mnemonic,
    consumedDepositTxids: [],
  };
  persist(true);
  return publicMerchantVault(entry.vault);
}

/**
 * Restores the merchant vault from its persisted file after a restart, and
 * re-derives the vault from the stored mnemonic so the adapter can scan and
 * register against it. The derivation is deterministic (same mnemonic + same
 * quorum = same P2TR), so a mismatch means the record does not belong to this
 * vault. Returns the public vault, or null when no vault was ever created.
 */
export async function restoreMerchantVault(): Promise<MerchantVault | null> {
  const file = tachiMerchantVaultFile();
  if (!existsSync(file)) return null;
  let record: PersistedMerchantVault;
  try {
    record = JSON.parse(readFileSync(file, "utf8")) as PersistedMerchantVault;
  } catch (error) {
    console.error("[tachi-merchant-vault] skipping unreadable merchant vault file:", error instanceof Error ? error.message : String(error));
    return null;
  }
  if (!record?.vault?.vaultAddress || !record.mnemonic) return null;
  const adapter = adapterFactory();
  const vault = await adapter.createVault({ mnemonic: record.mnemonic });
  if (vault.address !== record.vault.vaultAddress) {
    throw new Error(`Restored merchant vault address mismatch: derived ${vault.address}, expected ${record.vault.vaultAddress}`);
  }
  entry = {
    vault: record.vault,
    runtime: { adapter, vaultId: vault.id, mnemonic: record.mnemonic },
    mnemonic: record.mnemonic,
    consumedDepositTxids: record.consumedDepositTxids ?? [],
  };
  return publicMerchantVault(entry.vault);
}
