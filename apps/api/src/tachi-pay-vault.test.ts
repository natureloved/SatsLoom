import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "./server.js";
import {
  clearMerchantVault,
  ensureMerchantVault,
  setTachiMerchantVaultAdapterFactory,
  type TachiAdapter,
} from "./tachi-merchant-vault.ts";
import {
  clearTachiPayVaultPayments,
  getTachiPayVaultPayment,
  restoreTachiPayVaultPayments,
  retryTachiPayVaultPayment,
  startTachiPayVaultPayment,
  tachiPayVaultPaymentsDir,
  type TachiPayVaultPayment,
} from "./tachi-pay-vault.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "satsloom-pay-vault-"));
  process.env.SATSLOOM_TACHI_FUND_ENABLED = "true";
  process.env.SATSLOOM_TACHI_MERCHANT_VAULT_FILE = join(tmpDir, "merchant-vault.json");
  process.env.SATSLOOM_TACHI_PAY_VAULT_PAYMENTS_DIR = join(tmpDir, "payments");
  process.env.SATSLOOM_TACHI_PAY_VAULT_POLL_MS = "10";
  process.env.SATSLOOM_TACHI_PAY_VAULT_DEADLINE_MS = "1500";
  clearMerchantVault();
  clearTachiPayVaultPayments();
});

afterEach(() => {
  setTachiMerchantVaultAdapterFactory(null);
  delete process.env.SATSLOOM_TACHI_FUND_ENABLED;
  delete process.env.SATSLOOM_TACHI_MERCHANT_VAULT_FILE;
  delete process.env.SATSLOOM_TACHI_PAY_VAULT_PAYMENTS_DIR;
  delete process.env.SATSLOOM_TACHI_PAY_VAULT_POLL_MS;
  delete process.env.SATSLOOM_TACHI_PAY_VAULT_DEADLINE_MS;
  clearMerchantVault();
  clearTachiPayVaultPayments();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Waits until the payment reaches a terminal status, then returns it. */
async function waitForPayment(id: string, timeoutMs = 5_000): Promise<TachiPayVaultPayment> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payment = getTachiPayVaultPayment(id);
    if (!payment) throw new Error(`payment ${id} disappeared`);
    if (payment.status === "paid" || payment.status === "failed") return payment;
    if (Date.now() >= deadline) throw new Error(`payment ${id} did not finish in ${timeoutMs}ms (stage ${payment.stage})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type StubOptions = {
  deposits?: Array<{ txid: string; amountSats: bigint }>;
  unspentVtxos?: Array<{ id: string; amountSats: bigint }>;
  register?: { broadcastHash: string; vtxoId: string; feeSats: bigint };
};

function stubAdapter(options: StubOptions = {}): { stub: TachiAdapter; state: { calls: string[]; deposits: StubOptions["deposits"] } } {
  const state = {
    calls: [] as string[],
    deposits: options.deposits ?? [{ txid: "b".repeat(64), amountSats: 10_000n }],
  };
  const stub = {
    network: "signet",
    getExplorerUrl: (txid: string) => `https://signet.tachibtcscan.com/tx/${txid}`,
    createVault: async () => {
      state.calls.push("createVault");
      return { id: "tb1p_stub_merchant_vault", address: "tb1p_stub_merchant_vault", csvDelay: 1008 };
    },
    getFundingAddress: () => "tb1q_stub_merchant_funding",
    listConfirmedVaultDeposits: async () => {
      state.calls.push("listConfirmedVaultDeposits");
      return state.deposits ?? [];
    },
    listUnspentVtxos: async () => {
      state.calls.push("listUnspentVtxos");
      return options.unspentVtxos ?? [];
    },
    registerDeposit: async () => {
      state.calls.push("registerDeposit");
      const reg = options.register ?? { broadcastHash: "c".repeat(64), vtxoId: "d".repeat(64), feeSats: 1n };
      return { broadcastHash: reg.broadcastHash, vtxoId: reg.vtxoId, vtxo: { id: reg.vtxoId }, feeSats: reg.feeSats };
    },
  };
  return { stub: stub as unknown as TachiAdapter, state };
}

async function createInvoice(amountSats = 10_000): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/invoices", payload: { amountSats } });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

describe("pay-to-vault merchant settlement", () => {
  it("watches for the exact-amount deposit, registers it, and settles with explorer links routed by layer", async () => {
    const { stub } = stubAdapter();
    setTachiMerchantVaultAdapterFactory(() => stub);
    await ensureMerchantVault();
    const settled: TachiPayVaultPayment[] = [];
    const payment = startTachiPayVaultPayment("invoice-1", 10_000n, async (paid) => { settled.push(paid); });
    const done = await waitForPayment(payment.id);
    expect(done.status).toBe("paid");
    expect(done.stage).toBe("paid");
    expect(done.deposit?.txid).toBe("b".repeat(64));
    // The deposit is an L1 Bitcoin transaction: the mempool.space link is the
    // verifiable one (the Tachi explorer does not index L1 txs).
    expect(done.deposit?.bitcoinExplorerUrl).toBe(`https://mempool.space/signet/tx/${"b".repeat(64)}`);
    expect(done.registration?.broadcastHash).toBe("c".repeat(64));
    expect(done.registration?.vtxoId).toBe("d".repeat(64));
    expect(done.registration?.explorerUrl).toBe(`https://signet.tachibtcscan.com/tx/${"c".repeat(64)}`);
    expect(done.error).toBeNull();
    expect(settled).toHaveLength(1);
    expect(settled[0].id).toBe(payment.id);
    // The deposit is consumed, so a second invoice for the same amount cannot re-match it.
    const second = startTachiPayVaultPayment("invoice-2", 10_000n, null);
    const failed = await waitForPayment(second.id, 10_000);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("No 10000-sat deposit reached the merchant vault");
  });

  it("refuses to start when no merchant vault exists", () => {
    expect(() => startTachiPayVaultPayment("invoice-1", 10_000n, null)).toThrow(/No merchant vault exists/);
  });

  it("fails verbatim when no deposit arrives within the deadline", async () => {
    const { stub } = stubAdapter({ deposits: [] });
    setTachiMerchantVaultAdapterFactory(() => stub);
    await ensureMerchantVault();
    const payment = startTachiPayVaultPayment("invoice-1", 10_000n, null);
    const done = await waitForPayment(payment.id, 10_000);
    expect(done.status).toBe("failed");
    expect(done.stage).toBe("awaiting-payment");
    expect(done.error).toContain("No 10000-sat deposit reached the merchant vault");
    expect(done.registration).toBeNull();
  });

  it("ignores a deposit of the wrong amount and an over-payment", async () => {
    const { stub } = stubAdapter({ deposits: [
      { txid: "e".repeat(64), amountSats: 9_999n },
      { txid: "f".repeat(64), amountSats: 10_001n },
    ] });
    setTachiMerchantVaultAdapterFactory(() => stub);
    await ensureMerchantVault();
    const payment = startTachiPayVaultPayment("invoice-1", 10_000n, null);
    const done = await waitForPayment(payment.id, 10_000);
    expect(done.status).toBe("failed");
    expect(done.deposit).toBeNull();
  });

  it("fails loudly when the registration would attribute an older payment's VTXO", async () => {
    const { stub } = stubAdapter({
      unspentVtxos: [{ id: "d".repeat(64), amountSats: 10_000n }],
      // Empty broadcast hash: the adapter found an already-registered VTXO.
      register: { broadcastHash: "", vtxoId: "d".repeat(64), feeSats: 0n },
    });
    setTachiMerchantVaultAdapterFactory(() => stub);
    await ensureMerchantVault();
    const settled: TachiPayVaultPayment[] = [];
    const payment = startTachiPayVaultPayment("invoice-1", 10_000n, async (paid) => { settled.push(paid); });
    const done = await waitForPayment(payment.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("already registered in the merchant vault");
    expect(done.registration).toBeNull();
    expect(settled).toHaveLength(0);
  });

  it("accepts an empty-hash registration when the VTXO is new (crash-recovery case)", async () => {
    const { stub } = stubAdapter({
      unspentVtxos: [],
      register: { broadcastHash: "", vtxoId: "d".repeat(64), feeSats: 0n },
    });
    setTachiMerchantVaultAdapterFactory(() => stub);
    await ensureMerchantVault();
    const payment = startTachiPayVaultPayment("invoice-1", 10_000n, null);
    const done = await waitForPayment(payment.id);
    expect(done.status).toBe("paid");
    expect(done.registration?.vtxoId).toBe("d".repeat(64));
  });

  it("persists the payment and resumes it after a simulated restart", async () => {
    const { stub, state } = stubAdapter({ deposits: [] });
    setTachiMerchantVaultAdapterFactory(() => stub);
    await ensureMerchantVault();
    const settled: TachiPayVaultPayment[] = [];
    const payment = startTachiPayVaultPayment("invoice-1", 10_000n, async (paid) => { settled.push(paid); });
    // The record is on disk, locked down, and holds no mnemonic.
    const dir = tachiPayVaultPaymentsDir();
    expect(readdirSync(dir)).toEqual([`${payment.id}.json`]);
    const file = join(dir, `${payment.id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("payment.id", payment.id);

    // Simulate a restart: drop the in-memory map, restore from disk.
    clearTachiPayVaultPayments();
    clearMerchantVault();
    expect(getTachiPayVaultPayment(payment.id)).toBeNull();
    await ensureMerchantVault();
    const restored = restoreTachiPayVaultPayments(async (paid) => { settled.push(paid); });
    expect(restored.map((item) => item.id)).toContain(payment.id);
    const revived = getTachiPayVaultPayment(payment.id);
    expect(revived?.status).toBe("watching");
    expect(revived?.stage).toBe("awaiting-payment");

    // The deposit arrives after the restart; the resumed watcher settles it.
    state.deposits = [{ txid: "b".repeat(64), amountSats: 10_000n }];
    const done = await waitForPayment(payment.id);
    expect(done.status).toBe("paid");
    expect(settled).toHaveLength(1);
  });

  it("retries a failed payment from the stage it failed at", async () => {
    const { stub, state } = stubAdapter({ deposits: [] });
    setTachiMerchantVaultAdapterFactory(() => stub);
    await ensureMerchantVault();
    const payment = startTachiPayVaultPayment("invoice-1", 10_000n, null);
    const failed = await waitForPayment(payment.id, 10_000);
    expect(failed.status).toBe("failed");
    state.deposits = [{ txid: "b".repeat(64), amountSats: 10_000n }];
    const retried = retryTachiPayVaultPayment(payment.id, null);
    expect(retried?.status).toBe("watching");
    const done = await waitForPayment(payment.id);
    expect(done.status).toBe("paid");
    expect(() => retryTachiPayVaultPayment(payment.id, null)).toThrow(/only a failed payment can be retried/);
  });

  it("exposes the flow over HTTP and confirms the invoice on settlement", async () => {
    const { stub } = stubAdapter();
    setTachiMerchantVaultAdapterFactory(() => stub);
    const noVault = await app.inject({ method: "POST", url: "/api/tachi/invoices/no-such/pay-vault", payload: {} });
    expect(noVault.statusCode).toBe(404);

    const vaultRes = await app.inject({ method: "POST", url: "/api/tachi/merchant-vault", payload: {} });
    expect(vaultRes.statusCode).toBe(200);
    expect(vaultRes.json().data.vaultAddress).toBe("tb1p_stub_merchant_vault");

    const invoiceId = await createInvoice(10_000);
    const started = await app.inject({ method: "POST", url: `/api/tachi/invoices/${invoiceId}/pay-vault`, payload: {} });
    expect(started.statusCode).toBe(202);
    const paymentId = started.json().data.id as string;
    expect(started.json().data.vaultAddress).toBe("tb1p_stub_merchant_vault");

    const unknown = await app.inject({ method: "GET", url: `/api/tachi/invoices/${invoiceId}/pay-vault/no-such` });
    expect(unknown.statusCode).toBe(404);
    const done = await waitForPayment(paymentId);
    expect(done.status).toBe("paid");
    const polled = await app.inject({ method: "GET", url: `/api/tachi/invoices/${invoiceId}/pay-vault/${paymentId}` });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().data.status).toBe("paid");

    // The invoice itself is confirmed, with the registration as its settlement.
    const invoice = await app.inject({ method: "GET", url: `/api/invoices/${invoiceId}` });
    expect(invoice.json().data.status).toBe("confirmed");
    expect(invoice.json().data.lifecycle).toBe("PAYMENT_CONFIRMED");
    expect(invoice.json().data.settlement.routeId).toBe("tachi-pay-vault");
    expect(invoice.json().data.settlement.status).toBe("settled");
    expect(invoice.json().data.settlement.txid).toBe("c".repeat(64));
    expect(invoice.json().data.settlement.vtxoId).toBe("d".repeat(64));
    expect(invoice.json().data.settlement.simulation).toBe(false);

    // A settled invoice cannot be paid again through the vault.
    const again = await app.inject({ method: "POST", url: `/api/tachi/invoices/${invoiceId}/pay-vault`, payload: {} });
    expect(again.statusCode).toBe(409);
  });

  it("refuses the pay-vault routes when the flow is not enabled", async () => {
    delete process.env.SATSLOOM_TACHI_FUND_ENABLED;
    const res = await app.inject({ method: "POST", url: "/api/tachi/merchant-vault", payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("SATSLOOM_TACHI_FUND_ENABLED=true");
  });
});
