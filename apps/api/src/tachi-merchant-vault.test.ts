import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMerchantVault,
  ensureMerchantVault,
  getMerchantVault,
  isDepositConsumed,
  markDepositConsumed,
  restoreMerchantVault,
  setTachiMerchantVaultAdapterFactory,
  tachiMerchantVaultFile,
  type TachiAdapter,
} from "./tachi-merchant-vault.ts";

let vaultDir: string;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "satsloom-merchant-vault-"));
  process.env.SATSLOOM_TACHI_MERCHANT_VAULT_FILE = join(vaultDir, "merchant-vault.json");
  clearMerchantVault();
});

afterEach(() => {
  setTachiMerchantVaultAdapterFactory(null);
  delete process.env.SATSLOOM_TACHI_MERCHANT_VAULT_FILE;
  clearMerchantVault();
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
});

function stubAdapter(): TachiAdapter {
  const calls: string[] = [];
  const stub = {
    network: "signet",
    calls,
    getExplorerUrl: (txid: string) => `https://signet.tachibtcscan.com/tx/${txid}`,
    createVault: async () => {
      calls.push("createVault");
      return { id: "tb1p_stub_merchant_vault", address: "tb1p_stub_merchant_vault", csvDelay: 1008 };
    },
    getFundingAddress: () => "tb1q_stub_merchant_funding",
  };
  return stub as unknown as TachiAdapter;
}

describe("merchant Tachi vault", () => {
  it("creates the vault once and returns the same one on the second call", async () => {
    const adapter = stubAdapter();
    setTachiMerchantVaultAdapterFactory(() => adapter);
    const first = await ensureMerchantVault();
    expect(first.merchantId).toBe("merchant-demo");
    expect(first.vaultAddress).toBe("tb1p_stub_merchant_vault");
    expect(first.network).toBe("signet");
    const second = await ensureMerchantVault();
    expect(second.vaultAddress).toBe(first.vaultAddress);
    expect((adapter as unknown as { calls: string[] }).calls).toEqual(["createVault"]);
    expect(getMerchantVault()?.vaultAddress).toBe(first.vaultAddress);
  });

  it("persists the mnemonic to a locked file and never exposes it in the public record", async () => {
    setTachiMerchantVaultAdapterFactory(() => stubAdapter());
    const vault = await ensureMerchantVault();
    const file = tachiMerchantVaultFile();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(file, "utf8")) as { mnemonic: unknown; vault: unknown };
    expect(typeof record.mnemonic).toBe("string");
    // generateMnemonic from the Tachi wallet aggregator yields a 24-word phrase.
    expect((record.mnemonic as string).split(" ").length).toBe(24);
    expect(JSON.stringify(vault)).not.toContain(record.mnemonic as string);
    expect(JSON.stringify(getMerchantVault())).not.toContain(record.mnemonic as string);
  });

  it("restores the vault after a simulated restart and keeps the consumed list", async () => {
    setTachiMerchantVaultAdapterFactory(() => stubAdapter());
    const created = await ensureMerchantVault();
    markDepositConsumed("a".repeat(64));
    expect(isDepositConsumed("a".repeat(64))).toBe(true);
    expect(isDepositConsumed("b".repeat(64))).toBe(false);

    clearMerchantVault();
    expect(getMerchantVault()).toBeNull();
    const restored = await restoreMerchantVault();
    expect(restored?.vaultAddress).toBe(created.vaultAddress);
    expect(isDepositConsumed("A".repeat(64))).toBe(true); // txids match case-insensitively
    expect(isDepositConsumed("b".repeat(64))).toBe(false);
  });

  it("returns null when no merchant vault was ever created", async () => {
    setTachiMerchantVaultAdapterFactory(() => stubAdapter());
    expect(await restoreMerchantVault()).toBeNull();
    expect(getMerchantVault()).toBeNull();
  });
});
