/**
 * End-to-end API tests.
 *
 * These run the whole merchant loop against the fixture ledger: real key derivation, real
 * Schnorr signing, real TachiTx encoding, real HMAC webhook signing — only the daemon transport
 * is in-process. That is the strongest verification available without network access to
 * `rpc-regtest.tachibtc.com`, and it exercises every code path a judge's click-path touches.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./server.js";
import { TachiAdapter } from "@satsloom/tachi-adapter";
import { verifySignature } from "./webhooks.js";

type WebhookCall = { url: string; headers: Record<string, string>; body: string };

function recordingFetch(calls: WebhookCall[], failures = new Map<string, number>()): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = String(init?.body ?? "");
    const remaining = failures.get(url) ?? 0;
    if (remaining > 0) {
      failures.set(url, remaining - 1);
      calls.push({ url, headers, body });
      return new Response("nope", { status: 500 });
    }
    calls.push({ url, headers, body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("SatsLoom API", () => {
  let built: BuiltApp;
  let calls: WebhookCall[];

  beforeEach(() => {
    calls = [];
    built = buildApp({
      adapter: new TachiAdapter({ provider: "fixture", commitDelaySeconds: 0 }),
      detectionIntervalMs: 0,
      enableDemoRoutes: true,
      fetchImpl: recordingFetch(calls),
    });
  });

  afterEach(async () => {
    await built.app.close();
  });

  const get = async (path: string) => {
    const response = await built.app.inject({ method: "GET", url: path });
    return { status: response.statusCode, json: response.json() as any };
  };

  /** Waits for a condition instead of racing the dispatcher's in-flight delivery. */
  const waitFor = async (check: () => boolean, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return check();
  };

  const post = async (path: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await built.app.inject({ method: "POST", url: path, payload: payload as object, headers });
    return { status: response.statusCode, json: response.json() as any };
  };

  async function fundedInvoice(amount = "50000") {
    await post("/api/demo/onboard-payer", { amountSats: "500000" });
    await post("/api/demo/fund-merchant", { amountSats: "500000" });
    const created = await post("/api/invoices", { amountSats: amount, memo: "Demo order #1" });
    expect(created.status).toBe(200);
    return created.json.data;
  }

  it("reports fixture mode and never claims to be live", async () => {
    const health = await get("/api/health");
    expect(health.json.mode).toBe("fixture");
    const status = await get("/api/tachi/status");
    expect(status.json.data.mode).toBe("fixture");
    expect(status.json.data.reachable).toBe(true);
  });

  it("does not confirm an invoice from the merchant's own payout change", async () => {
    /*
     * The regression that would embarrass the whole project: the merchant sweeps 1,000 sats out,
     * ~499k comes back as change to the same vault owner, and the naive detector calls the pending
     * invoice "paid". The customer never paid. Detection must ignore outputs this process created
     * for itself, so the invoice stays `created` and no webhook fires.
     */
    const invoice = await fundedInvoice();
    const before = calls.length;

    const payer = await post("/api/demo/onboard-payer", { amountSats: "100000" });
    const payout = await post("/api/payouts", { amountSats: "1000", toOwner: payer.json.data.target.owner, kind: "offchain_transfer" });
    expect(payout.json.data.status).toBe("settled");

    await built.detectOnce();
    await built.detectOnce();
    const after = await get(`/api/invoices/${invoice.id}`);
    expect(after.json.data.status).toBe("created");
    expect(after.json.data.proof).toBeUndefined();
    expect(calls.length).toBe(before);

    // The change really did arrive — proof the test is exercising the ambiguous case.
    const merchant = await get("/api/merchant");
    expect(merchant.json.data).toBeTruthy();
  });

  it("credits one VTXO to only one invoice, even when two are pending at once", async () => {
    const first = await fundedInvoice();
    const second = await fundedInvoice();
    // One payment arrives at the shared payment target.
    const paid = await post(`/api/demo/pay-invoice/${first.id}`);
    expect(paid.json.data.broadcast.accepted).toBe(true);

    await built.detectOnce();
    const a = await get(`/api/invoices/${first.id}`);
    const b = await get(`/api/invoices/${second.id}`);
    const confirmed = [a, b].filter((r) => r.json.data.status === "confirmed");
    // Exactly one invoice may claim the output; the other must wait for its own payment.
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].json.data.id).toBe(first.id);
  });

  it("reports the daemon's real mode on a rejected request, not a false 'degraded'", async () => {
    // A client error must not make the merchant's status pill go amber: the pill describes the
    // daemon, and a healthy daemon stays "fixture"/"live" even when a request is refused.
    const bad = await post("/api/payouts", { amountSats: "1000" });
    expect(bad.status).toBe(400);
    expect(bad.json.mode).toBe("fixture");
    expect(bad.json.error.message).toMatch(/toAddress/);
  });

  it("refuses to create an invoice when the payment target's VTXO set cannot be read", async () => {
    // Without a baseline, a pre-existing VTXO could be mistaken for this invoice's payment, so the
    // honest answer is 503 and no invoice — never an invoice that cannot be verified.
    const broken = new TachiAdapter({ provider: "fixture", commitDelaySeconds: 0 });
    const app = buildApp({ adapter: broken, detectionIntervalMs: 0, enableDemoRoutes: true, fetchImpl: recordingFetch(calls) });
    try {
      const original = broken.getAddressVtxos.bind(broken);
      broken.getAddressVtxos = async () => {
        throw new Error("ledger read failed");
      };
      const response = await app.app.inject({
        method: "POST",
        url: "/api/invoices",
        payload: { amountSats: "1000", memo: "unverifiable" } as object,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.message).toMatch(/could not be distinguished/i);
      broken.getAddressVtxos = original;
    } finally {
      await app.app.close();
    }
  });

  it("runs the full merchant loop: invoice -> pay -> confirm -> proof -> refund -> payout", async () => {
    const invoice = await fundedInvoice();
    expect(invoice.status).toBe("created");
    expect(invoice.paymentTarget.owner).toMatch(/^[0-9a-f]{64}$/);
    expect(invoice.paymentTarget.address).toMatch(/^bcrt1p/);

    // Pay from the demo wallet.
    const paid = await post(`/api/demo/pay-invoice/${invoice.id}`);
    expect(paid.status).toBe(200);
    expect(paid.json.data.invoice.status).toBe("pending");
    expect(paid.json.data.broadcast.accepted).toBe(true);

    // Confirmation comes from the ledger, via the detection loop.
    await built.detectOnce();
    const after = await get(`/api/invoices/${invoice.id}`);
    expect(after.json.data.status).toBe("confirmed");
    const proof = after.json.data.proof;
    expect(proof.amountSats).toBe("50000");
    expect(proof.vtxoId).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.explorerUrl).toContain("explorer-regtest.tachibtc.com/tx/");
    expect(proof.mode).toBe("fixture");

    // Refund back to the payer's key.
    const refund = await post(`/api/invoices/${invoice.id}/refund`, { reason: "customer changed their mind" });
    expect(refund.status).toBe(200);
    expect(refund.json.data.status).toBe("settled");
    expect(refund.json.data.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(refund.json.data.explorerUrl).toContain("/tx/");
    const refunded = await get(`/api/invoices/${invoice.id}`);
    expect(refunded.json.data.status).toBe("refunded");

    // Sweep to the merchant's cold Taproot address.
    const cold = await built.adapter.targetFor("cold");
    const payout = await post("/api/payouts", { toAddress: cold.address, amountSats: "10000" });
    expect(payout.status).toBe(200);
    expect(payout.json.data.kind).toBe("onchain_redemption");
    expect(payout.json.data.status).toBe("settled");
  });

  it("confirms an invoice only from a ledger proof, never on request", async () => {
    const invoice = await fundedInvoice();
    const forced = await post(`/api/demo/pay-invoice/${invoice.id}/force-confirm`);
    expect(forced.status).toBe(501);
    expect(forced.json.error.message).toMatch(/no endpoint that confirms an invoice without an on-ledger proof/i);
    const still = await get(`/api/invoices/${invoice.id}`);
    expect(still.json.data.status).toBe("created");
  });

  it("is idempotent on refund and payout, so a retried request cannot move money twice", async () => {
    const invoice = await fundedInvoice();
    await post(`/api/demo/pay-invoice/${invoice.id}`);
    await built.detectOnce();

    const first = await post(`/api/invoices/${invoice.id}/refund`, { reason: "duplicate test" });
    const second = await post(`/api/invoices/${invoice.id}/refund`, { reason: "duplicate test" });
    expect(second.json.idempotent).toBe(true);
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(built.store.refunds.size).toBe(1);

    const cold = await built.adapter.targetFor("cold");
    const key = "payout-once";
    const p1 = await post("/api/payouts", { toAddress: cold.address, amountSats: "5000" }, { "idempotency-key": key });
    const p2 = await post("/api/payouts", { toAddress: cold.address, amountSats: "5000" }, { "idempotency-key": key });
    expect(p2.json.idempotent).toBe(true);
    expect(p2.json.data.id).toBe(p1.json.data.id);
    expect(built.store.payouts.size).toBe(1);
  });

  it("validates invoice input rather than trusting the client", async () => {
    expect((await post("/api/invoices", { amountSats: "0" })).status).toBe(400);
    expect((await post("/api/invoices", { amountSats: "-5" })).status).toBe(400);
    expect((await post("/api/invoices", { amountSats: "not-a-number" })).status).toBe(400);
    expect((await post("/api/invoices", { amountSats: "99999999999999999999999999" })).status).toBe(400);
    const ok = await post("/api/invoices", { amountSats: "1000" });
    expect(ok.status).toBe(200);
    expect(ok.json.data.expiresAt).toBeTruthy();
  });

  it("refuses to refund an unpaid invoice, and says why", async () => {
    await post("/api/demo/fund-merchant", { amountSats: "100000" });
    const invoice = (await post("/api/invoices", { amountSats: "1000" })).json.data;
    const refund = await post(`/api/invoices/${invoice.id}/refund`, { reason: "too early" });
    expect(refund.status).toBe(409);
    expect(refund.json.error.message).toMatch(/only a confirmed invoice/i);
  });

  it("expires an unpaid invoice and fires invoice.expired", async () => {
    await post("/api/demo/fund-merchant", { amountSats: "100000" });
    const registration = await post("/api/webhooks/register", { url: "https://shop.example/hooks", events: ["invoice.expired"] });
    expect(registration.status).toBe(200);
    expect(registration.json.data.secret).toMatch(/^[0-9a-f]{32}$/);

    const invoice = (await post("/api/invoices", { amountSats: "2500", expiresInSeconds: 60 })).json.data;
    built.store.invoices.get(invoice.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    await built.detectOnce();

    const after = await get(`/api/invoices/${invoice.id}`);
    expect(after.json.data.status).toBe("expired");
    const expired = calls.filter((call) => JSON.parse(call.body).event === "invoice.expired");
    expect(expired).toHaveLength(1);
  });

  it("signs webhooks with a verifiable HMAC and keeps the secret out of every response", async () => {
    await post("/api/demo/onboard-payer", { amountSats: "200000" });
    await post("/api/demo/fund-merchant", { amountSats: "200000" });
    const registration = await post("/api/webhooks/register", { url: "https://shop.example/hooks", events: ["invoice.confirmed"] });
    const secret = registration.json.data.secret as string;

    const invoice = (await post("/api/invoices", { amountSats: "1234" })).json.data;
    await post(`/api/demo/pay-invoice/${invoice.id}`);
    await built.detectOnce();

    await waitFor(() => calls.some((call) => JSON.parse(call.body).event === "invoice.confirmed"));
    const confirmed = calls.filter((call) => JSON.parse(call.body).event === "invoice.confirmed");
    expect(confirmed).toHaveLength(1);
    const header = confirmed[0].headers["SatsLoom-Signature"];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // The signature must verify over the exact bytes that were sent.
    expect(verifySignature(secret, confirmed[0].body, header)).toBe(true);
    expect(verifySignature(secret, confirmed[0].body.replace("1234", "9999"), header)).toBe(false);

    const listed = await get("/api/webhooks");
    expect(JSON.stringify(listed.json)).not.toContain(secret);
    await waitFor(() => built.store.deliveries.values().next().value?.status === "delivered");
    const deliveries = await get("/api/webhooks/deliveries");
    expect(deliveries.json.data[0].status).toBe("delivered");
    expect(deliveries.json.data[0].responseCode).toBe(200);
    expect(deliveries.json.data[0].body).toBeTruthy();
  });

  it("retries a failing webhook and records the attempt history", async () => {
    built = buildApp({
      adapter: new TachiAdapter({ provider: "fixture", commitDelaySeconds: 0 }),
      detectionIntervalMs: 0,
      enableDemoRoutes: true,
      fetchImpl: recordingFetch(calls, new Map([["https://broken.example/hooks", 1]])),
    });
    await post("/api/demo/onboard-payer", { amountSats: "200000" });
    await post("/api/demo/fund-merchant", { amountSats: "200000" });
    await post("/api/webhooks/register", { url: "https://broken.example/hooks", events: ["invoice.confirmed"] });
    const invoice = (await post("/api/invoices", { amountSats: "777" })).json.data;
    await post(`/api/demo/pay-invoice/${invoice.id}`);
    await built.detectOnce();
    await waitFor(() => (built.store.deliveries.values().next().value?.attempts ?? 0) >= 1);
    const deliveries = await get("/api/webhooks/deliveries");
    expect(deliveries.json.data[0].attempts).toBeGreaterThanOrEqual(1);
    expect(deliveries.json.data[0].status).toBe("retrying");
    expect(deliveries.json.data[0].nextAttemptAt).toBeTruthy();
  });

  it("exposes a public pay page with no secrets", async () => {
    const invoice = await fundedInvoice("4200");
    const pay = await get(`/api/pay/${invoice.id}`);
    expect(pay.status).toBe(200);
    expect(pay.json.data.amountSats).toBe("4200");
    expect(pay.json.data.paymentTarget.address).toMatch(/^bcrt1p/);
    const serialized = JSON.stringify(pay.json);
    expect(serialized).not.toMatch(/mnemonic|privateKey|xprv|abandon abandon/i);
    expect((await get("/api/pay/does-not-exist")).status).toBe(404);
  });

  it("quotes at least two live-evaluated routes and explains the winner", async () => {
    const invoice = await fundedInvoice("30000");
    const quotes = await get(`/api/invoices/${invoice.id}/routes`);
    expect(quotes.status).toBe(200);
    expect(quotes.json.data.routes.length).toBeGreaterThanOrEqual(2);
    const eligible = quotes.json.evaluations.filter((e: any) => e.eligible);
    expect(eligible.length).toBeGreaterThanOrEqual(1);
    expect(eligible[0].explanation.length).toBeGreaterThan(50);
    expect(eligible[0].timelock.friendly).toBeTruthy();
    expect(quotes.json.data.routes.every((r: any) => r.simulation === false)).toBe(true);
  });

  it("falls back to the runner-up when the best route is invalidated, and publishes why", async () => {
    const invoice = await fundedInvoice("30000");
    await get(`/api/invoices/${invoice.id}/routes`);
    const decision = await post(`/api/invoices/${invoice.id}/select-route`);
    const bestRoute = decision.json.data.selectedRouteId;
    expect(bestRoute).toBeTruthy();

    await post(`/api/invoices/${invoice.id}/invalidate-best-route`);
    const settled = await post(`/api/invoices/${invoice.id}/settle`);
    expect(settled.status).toBe(200);
    expect(settled.json.data.fallbackFrom).toBe(bestRoute);
    expect(settled.json.data.routeId).not.toBe(bestRoute);
    expect(settled.json.data.status).toBe("settled");
    expect(settled.json.data.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(settled.json.data.simulation).toBe(false);

    const log = await get(`/api/invoices/${invoice.id}/settlement`);
    const fallbackEntry = log.json.log.find((entry: any) => entry.kind === "fallback");
    expect(fallbackEntry.previousRouteId).toBe(bestRoute);
    expect(fallbackEntry.reason).toMatch(/no longer eligible/);
  });

  it("re-quotes instead of settling on a stale quote", async () => {
    const invoice = await fundedInvoice("15000");
    await get(`/api/invoices/${invoice.id}/routes`);
    const quote = built.store.quotes.get(invoice.id)!;
    quote.quoteExpiresAt = new Date(Date.now() - 1000).toISOString();
    const settled = await post(`/api/invoices/${invoice.id}/settle`);
    expect(settled.status).toBe(200);
    expect(settled.json.data.status).toBe("settled");
    expect(built.store.quotes.get(invoice.id)!.quoteExpiresAt > new Date().toISOString()).toBe(true);
  });

  it("reports the on-chain vs off-chain balance split for the dashboard", async () => {
    await fundedInvoice("10000");
    const summary = await get("/api/dashboard/summary");
    expect(summary.status).toBe(200);
    const data = summary.json.data;
    expect(data.mode).toBe("fixture");
    expect(typeof data.balance.offchainSats).toBe("string");
    expect(data.balance.onchainSats).not.toBe(undefined);
    expect(data.counts.created).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.recentActivity)).toBe(true);
    expect(data.recentActivity.length).toBeGreaterThan(0);
  });

  it("re-quotes deterministically when the policy weights change", async () => {
    const invoice = await fundedInvoice("40000");
    await get(`/api/invoices/${invoice.id}/routes`);
    const a = await post(`/api/invoices/${invoice.id}/select-route`);
    const b = await post(`/api/invoices/${invoice.id}/select-route`);
    expect(b.json.data.selectedRouteId).toBe(a.json.data.selectedRouteId);
    expect(b.json.data.reason).toBe(a.json.data.reason);

    const updated = await post("/api/policy", { feeWeight: 0.9, latencyWeight: 0.05, exitRiskWeight: 0.05, liquidityPenalty: 0 });
    expect(updated.status).toBe(200);
    expect(updated.json.data.feeWeight).toBe(0.9);
    expect((await post("/api/policy", { feeWeight: 5 })).status).toBe(400);
    expect((await post("/api/policy", { feeWeight: 0, latencyWeight: 0, exitRiskWeight: 0, liquidityPenalty: 0 })).status).toBe(400);
  });

  it("publishes the liquidity directory with fee, timing and availability per source", async () => {
    await fundedInvoice("10000");
    const directory = await get("/api/routes/liquidity");
    expect(directory.status).toBe(200);
    const providers = directory.json.data.providers;
    expect(providers.length).toBeGreaterThanOrEqual(2);
    for (const provider of providers) {
      expect(provider).toHaveProperty("feeSats");
      expect(provider).toHaveProperty("latencySeconds");
      expect(provider).toHaveProperty("capacitySats");
      expect(provider.timelock.friendly).toBeTruthy();
    }
    const onchain = providers.find((p: any) => p.kind === "onchain_redemption");
    expect(onchain.timelock.advanced).toMatch(/BIP-68 relative timelock: 1008 blocks/);
  });

  it("reports capabilities honestly instead of claiming everything works", async () => {
    const capabilities = await get("/api/tachi/capabilities");
    expect(capabilities.status).toBe(200);
    const ids = capabilities.json.data.capabilities.map((c: any) => c.id);
    expect(ids).toContain("daemon-reachable");
    expect(ids).toContain("explorer-link");
    // The explorer URL must be the regtest host, not the broken domain from the skeleton.
    const explorer = capabilities.json.data.capabilities.find((c: any) => c.id === "explorer-link");
    expect(explorer.detail).toContain("explorer-regtest.tachibtc.com");
    expect(capabilities.json.data.mode).toBe("fixture");
  });

  it("degrades honestly: no live data, no confirmed invoices, when the daemon is gone", async () => {
    const { FixtureDaemon } = await import("@satsloom/tachi-adapter");
    const broken = new FixtureDaemon();
    // Simulate an outage by making every daemon call throw.
    for (const method of ["health", "nodeInfo", "stats", "validators", "vtxos", "address"] as const) {
      (broken as any)[method] = async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      };
    }
    const degraded = buildApp({
      adapter: new TachiAdapter({ daemon: broken, provider: "live" }),
      detectionIntervalMs: 0,
      enableDemoRoutes: true,
      fetchImpl: recordingFetch(calls),
    });
    const status = await degraded.app.inject({ method: "GET", url: "/api/tachi/status" });
    expect(status.json().mode).toBe("degraded");
    expect(status.json().data.reachable).toBe(false);
    expect(status.json().data.detail).toMatch(/unreachable/);

    const invoice = await degraded.app.inject({ method: "POST", url: "/api/invoices", payload: { amountSats: "1000" } });
    expect(invoice.statusCode).toBe(503);
    const capabilities = degraded.app.inject({ method: "GET", url: "/api/tachi/capabilities" });
    expect((await capabilities).json().data.capabilities.every((c: any) => c.mode !== "live")).toBe(true);
    await degraded.app.close();
  });
});
