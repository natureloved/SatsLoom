import { describe, expect, it } from "vitest";
import { confirmPayment, createInvoiceAggregate, markQuoted, settleInvoice, selectSettlementRoute } from "./index.js";

const now = Date.parse("2026-01-01T00:00:00.000Z");
const merchant: any = { settlementPolicy: { maxFeeSats: 1_000n, maxSettlementSeconds: 600, feeWeight: .2, latencyWeight: .35, exitRiskWeight: .35, liquidityPenalty: .1 } };
const invoice: any = { id: "invoice-1", amountSats: 50_000n, status: "created", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() };
const quote: any = { invoiceId: invoice.id, quotedAt: new Date(now).toISOString(), quoteExpiresAt: new Date(now + 60_000).toISOString(), routes: [
  { id: "vtxo", source: "vtxo", capacitySats: 100_000n, feeSats: 50n, estimatedSettlementSeconds: 18, expiresAt: new Date(now + 60_000).toISOString(), exitRisk: "none", available: true, requiresCooperativeSigning: true, simulation: true },
  { id: "lp", source: "liquidity_provider", capacitySats: 250_000n, feeSats: 250n, estimatedSettlementSeconds: 45, expiresAt: new Date(now + 60_000).toISOString(), exitRisk: "low", available: true, requiresCooperativeSigning: false, simulation: true },
] };

describe("invoice settlement state machine", () => {
  it("makes payment confirmation idempotent", () => {
    const aggregate = createInvoiceAggregate(invoice);
    markQuoted(aggregate);
    expect(confirmPayment(aggregate, now).idempotent).toBe(false);
    expect(confirmPayment(aggregate, now).idempotent).toBe(true);
  });

  it("records fallback when the selected route becomes unavailable", async () => {
    const fallbackInvoice = { ...invoice, id: "invoice-fallback" };
    const fallbackQuote = { ...quote, invoiceId: fallbackInvoice.id, routes: quote.routes.map((route) => ({ ...route })) };
    const aggregate = createInvoiceAggregate(fallbackInvoice);
    markQuoted(aggregate);
    confirmPayment(aggregate, now);
    selectSettlementRoute(aggregate, fallbackQuote, merchant, now);
    fallbackQuote.routes[0].available = false;
    const result = await settleInvoice(aggregate, fallbackQuote, merchant, async (selected) => ({ simulation: true, txid: `demo-${selected.id}` }), now);
    expect(result.settlement.status).toBe("settled");
    expect(result.settlement.routeId).toBe("lp");
    expect(aggregate.lifecycle).toBe("SETTLED");
    expect(aggregate.fallbackHistory[0].fromRouteId).toBe("vtxo");
  });

  it("does not execute twice after settlement", async () => {
    const idempotentInvoice = { ...invoice, id: "invoice-idempotent" };
    const idempotentQuote = { ...quote, invoiceId: idempotentInvoice.id, routes: quote.routes.map((route) => ({ ...route })) };
    const aggregate = createInvoiceAggregate(idempotentInvoice);
    markQuoted(aggregate); confirmPayment(aggregate, now); selectSettlementRoute(aggregate, idempotentQuote, merchant, now);
    let calls = 0;
    const execute = async () => { calls++; return { simulation: true }; };
    await settleInvoice(aggregate, idempotentQuote, merchant, execute, now);
    const second = await settleInvoice(aggregate, idempotentQuote, merchant, execute, now);
    expect(calls).toBe(1);
    expect(second.idempotent).toBe(true);
  });

  it("rejects payment confirmation after expiry", () => {
    const aggregate = createInvoiceAggregate({ ...invoice, id: "invoice-expired" });
    markQuoted(aggregate);
    expect(() => confirmPayment(aggregate, now + 900_001)).toThrow("Invoice expired");
    expect(aggregate.lifecycle).toBe("QUOTE_EXPIRED");
  });

  it("rejects a quote belonging to another invoice", () => {
    const aggregate = createInvoiceAggregate({ ...invoice, id: "invoice-mismatch" });
    markQuoted(aggregate); confirmPayment(aggregate, now);
    expect(() => selectSettlementRoute(aggregate, quote, merchant, now)).toThrow("No eligible settlement route");
  });
});
