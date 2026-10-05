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

  it("generates checkout session with QR payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout/session",
      payload: { amountSats: "25000", orderId: "ord-999", memo: "Hardware Key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.checkoutSessionId).toBeDefined();
    expect(body.qrPayload).toContain("bitcoin:bcrt1p");
    expect(body.amountSats).toBe("25000");
  });

  it("supports x402 payment challenge and agent unlock", async () => {
    // 1. Initial request without payment returns 402
    const unauth = await app.inject({ method: "GET", url: "/api/x402/resource" });
    expect(unauth.statusCode).toBe(402);
    expect(unauth.headers["www-authenticate"]).toContain("L402");
    const invoiceId = unauth.headers["x-402-invoice-id"] as string;
    expect(invoiceId).toBeDefined();

    // 2. Pay via agent payment helper
    const agentPay = await app.inject({
      method: "POST",
      url: "/api/x402/agent-pay",
      payload: { invoiceId },
    });
    expect(agentPay.statusCode).toBe(200);
    expect(agentPay.json().data.status).toBe("settled");

    // 3. Repeat request with X-Payment-Invoice header -> unlocked 200
    const unlocked = await app.inject({
      method: "GET",
      url: "/api/x402/resource",
      headers: { "x-payment-invoice": invoiceId },
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json().data.unlocked).toBe(true);
  });

  it("provides Tachi telemetry and webhooks endpoints", async () => {
    const telemetry = await app.inject({ method: "GET", url: "/api/tachi/telemetry" });
    expect(telemetry.statusCode).toBe(200);
    expect(telemetry.json().data.timelockBlocks).toBe(1008);

    const webhooks = await app.inject({ method: "GET", url: "/api/webhooks" });
    expect(webhooks.statusCode).toBe(200);
    expect(Array.isArray(webhooks.json().data)).toBe(true);
  });
});
