import { afterAll, describe, expect, it } from "vitest";
import { app } from "./server.js";

afterAll(async () => app.close());

describe("invoice API workflow", () => {
  it("keeps one invoice id through confirmation and fallback settlement", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      payload: { amountSats: "50000", memo: "API workflow test" },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json();
    const invoiceId = createdBody.data.id;
    expect(invoiceId).toBeTypeOf("string");

    const fetched = await app.inject({ method: "GET", url: `/api/invoices/${invoiceId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().data.id).toBe(invoiceId);

    const confirmed = await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/simulate-payment`, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data).toMatchObject({ id: invoiceId, status: "confirmed", lifecycle: "PAYMENT_CONFIRMED" });

    expect((await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/select-route`, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/invalidate-best-route`, payload: {} })).statusCode).toBe(200);
    const settled = await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/settle`, payload: {} });
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toMatchObject({ simulation: true, data: { invoiceId, routeId: "lp-standard", status: "settled" } });
    expect((await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/select-route`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/invalidate-best-route`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/api/invoices/${invoiceId}` })).json().data.lifecycle).toBe("SETTLED");
  });

  it("rejects invalid amounts and prevents payout over-reservation", async () => {
    const invalid = await app.inject({ method: "POST", url: "/api/invoices", payload: { amountSats: "1.5" } });
    expect(invalid.statusCode).toBe(400);

    const first = await app.inject({ method: "POST", url: "/api/payouts", payload: { amountSats: "300000", destination: "regtest-a" } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/payouts", payload: { amountSats: "100000", destination: "regtest-b" } });
    expect(second.statusCode).toBe(409);
  });

  it("does not refund an already settled invoice", async () => {
    const created = await app.inject({ method: "POST", url: "/api/invoices", payload: { amountSats: "1000" } });
    const invoiceId = created.json().data.id;
    await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/simulate-payment`, payload: {} });
    await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/settle`, payload: {} });
    const refund = await app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/refund`, payload: {} });
    expect(refund.statusCode).toBe(409);
  });

  it("creates a real SPA checkout link without exposing a fake payment address", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout/session",
      payload: { amountSats: "25000", orderId: "ord-999", memo: "Hardware Key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.checkoutSessionId).toBeDefined();
    expect(body.paymentUrl).toBe(`/#checkout/${body.invoiceId}`);
    expect(body.qrPayload).toBeNull();
    expect(body.simulation).toBe(true);
    expect(body.amountSats).toBe("25000");
  });

  it("supports x402 payment challenge and agent unlock", async () => {
    // 1. Initial request without payment returns 402
    const unauth = await app.inject({ method: "GET", url: "/api/x402/resource" });
    expect(unauth.statusCode).toBe(402);
    expect(unauth.headers["www-authenticate"]).toContain("SatsLoom-Demo");
    const invoiceId = unauth.headers["x-402-invoice-id"] as string;
    expect(invoiceId).toBeDefined();

    // 2. Pay via agent payment helper
    const agentPay = await app.inject({
      method: "POST",
      url: "/api/x402/agent-pay",
      payload: { invoiceId },
    });
    expect(agentPay.statusCode).toBe(200);
    const proofToken = agentPay.json().data.proofToken as string;
    expect(agentPay.json()).toMatchObject({ simulation: true, data: { status: "simulated", settlement: { status: "settled", simulation: true } } });
    expect(proofToken).toContain("SatsLoom-Demo ");
    const agentPayRetry = await app.inject({ method: "POST", url: "/api/x402/agent-pay", payload: { invoiceId } });
    expect(agentPayRetry.statusCode).toBe(200);
    expect(agentPayRetry.json()).toMatchObject({ simulation: true, idempotent: true, data: { status: "simulated" } });

    // An invoice ID by itself is not a payment proof.
    const invoiceOnly = await app.inject({
      method: "GET",
      url: "/api/x402/resource",
      headers: { "x-payment-invoice": invoiceId },
    });
    expect(invoiceOnly.statusCode).toBe(402);

    // A valid signed receipt unlocks only the matching, simulated x402 invoice.
    const unlocked = await app.inject({
      method: "GET",
      url: "/api/x402/resource",
      headers: { authorization: proofToken },
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({ simulation: true, proof: "signed-demo-receipt-not-payment-proof", data: { unlocked: true, invoiceId } });

    const tampered = await app.inject({
      method: "GET",
      url: "/api/x402/resource",
      headers: { authorization: `${proofToken}x` },
    });
    expect(tampered.statusCode).toBe(402);

    const concurrentChallenge = await app.inject({ method: "GET", url: "/api/x402/resource" });
    const concurrentInvoiceId = concurrentChallenge.headers["x-402-invoice-id"] as string;
    const [concurrentPayA, concurrentPayB] = await Promise.all([
      app.inject({ method: "POST", url: "/api/x402/agent-pay", payload: { invoiceId: concurrentInvoiceId } }),
      app.inject({ method: "POST", url: "/api/x402/agent-pay", payload: { invoiceId: concurrentInvoiceId } }),
    ]);
    expect(concurrentPayA.statusCode).toBe(200);
    expect(concurrentPayB.statusCode).toBe(200);
    expect(concurrentPayA.json().data.settlement.txid).toBe(concurrentPayB.json().data.settlement.txid);
  });

  it("replays idempotent creates and rejects key reuse with a different payload", async () => {
    const headers = { "idempotency-key": "test-invoice-001" };
    const first = await app.inject({ method: "POST", url: "/api/invoices", headers, payload: { amountSats: "1234", memo: "stable" } });
    const replay = await app.inject({ method: "POST", url: "/api/invoices", headers, payload: { amountSats: "1234", memo: "stable" } });
    const conflict = await app.inject({ method: "POST", url: "/api/invoices", headers, payload: { amountSats: "4321", memo: "different" } });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(conflict.statusCode).toBe(409);
  });

  it("rejects arbitrary webhook targets before any network request", async () => {
    const result = await app.inject({
      method: "POST",
      url: "/api/invoices",
      payload: { amountSats: "1000", webhookUrl: "http://127.0.0.1:3001/internal" },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain("SATSLOOM_WEBHOOK_ALLOWED_ORIGINS");
  });

  it("rejects loopback webhook origins even if an operator allow-lists them", async () => {
    const previousOrigins = process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS;
    const previousSecret = process.env.SATSLOOM_WEBHOOK_SECRET;
    process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS = "https://127.0.0.1";
    process.env.SATSLOOM_WEBHOOK_SECRET = "test-webhook-secret";
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/invoices",
        payload: { amountSats: "1000", webhookUrl: "https://127.0.0.1/internal" },
      });
      expect(result.statusCode).toBe(400);
    } finally {
      if (previousOrigins === undefined) delete process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS;
      else process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS = previousOrigins;
      if (previousSecret === undefined) delete process.env.SATSLOOM_WEBHOOK_SECRET;
      else process.env.SATSLOOM_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("rejects webhook query strings so URL credentials cannot enter logs or storage", async () => {
    const previousOrigins = process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS;
    const previousSecret = process.env.SATSLOOM_WEBHOOK_SECRET;
    process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS = "https://merchant.example";
    process.env.SATSLOOM_WEBHOOK_SECRET = "test-webhook-secret";
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/invoices",
        payload: { amountSats: "1000", webhookUrl: "https://merchant.example/hooks?token=secret" },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error).toContain("Webhook URL requires HTTPS");
    } finally {
      if (previousOrigins === undefined) delete process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS;
      else process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS = previousOrigins;
      if (previousSecret === undefined) delete process.env.SATSLOOM_WEBHOOK_SECRET;
      else process.env.SATSLOOM_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("stops a request when the per-process route limit is exceeded", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const first = await app.inject({ method: "GET", url: "/api/health" });
      expect(first.statusCode).toBe(200);
      let last = first;
      for (let index = 1; index < 121; index += 1) {
        last = await app.inject({ method: "GET", url: "/api/health" });
      }
      expect(last.statusCode).toBe(429);
      expect(last.json().error).toContain("Rate limit exceeded");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("provides Tachi telemetry and webhooks endpoints", async () => {
    const telemetry = await app.inject({ method: "GET", url: "/api/tachi/telemetry" });
    expect(telemetry.statusCode).toBe(200);
    expect(telemetry.json().data.timelockBlocks).toBeNull();
    expect(telemetry.json().data.daemon.checked).toBe(false);

    const webhooks = await app.inject({ method: "GET", url: "/api/webhooks" });
    expect(webhooks.statusCode).toBe(200);
    expect(Array.isArray(webhooks.json().data)).toBe(true);
  });

  it("guards live payout endpoint when no live node is configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/live/payouts",
      payload: { invoice: "lnbcrt100n1p..." },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("A configured and reachable Lightning node is required");
  });
});
