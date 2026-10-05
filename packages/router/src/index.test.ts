import { describe, expect, it } from "vitest";
import { chooseRoute, eligibleRoutes, routeScore } from "./index.js";

const now = Date.parse("2026-01-01T00:00:00.000Z");
const merchant: any = { settlementPolicy: { maxFeeSats: 1_000n, maxSettlementSeconds: 600, feeWeight: .2, latencyWeight: .35, exitRiskWeight: .35, liquidityPenalty: .1 } };
const route = (overrides: any = {}) => ({ id: "vtxo", source: "vtxo", capacitySats: 100_000n, feeSats: 50n, estimatedSettlementSeconds: 18, expiresAt: new Date(now + 60_000).toISOString(), exitRisk: "none", available: true, requiresCooperativeSigning: true, simulation: true, ...overrides });
const invoice: any = { id: "invoice-1", amountSats: 50_000n, status: "confirmed", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() };
const quote = (routes: any[], quoteExpiresAt = new Date(now + 60_000).toISOString()) => ({ invoiceId: invoice.id, quoteExpiresAt, routes });

describe("routing invariants", () => {
  it("rejects expired quotes and insufficient capacity", () => {
    expect(eligibleRoutes(invoice, quote([route()], new Date(now - 1).toISOString()) as any, merchant, now)).toHaveLength(0);
    expect(eligibleRoutes(invoice, quote([route({ capacitySats: 49_999n })]) as any, merchant, now)).toHaveLength(0);
  });

  it("rejects malformed routes", () => {
    expect(eligibleRoutes(invoice, quote([route({ id: "", feeSats: -1n })]) as any, merchant, now)).toHaveLength(0);
  });

  it("prefers low exit risk and selects deterministically", () => {
    const routes = [route({ id: "slow-safe", estimatedSettlementSeconds: 45 }), route({ id: "fast-risky", source: "onchain_redemption", exitRisk: "high", estimatedSettlementSeconds: 10, feeSats: 1n })];
    const routeQuote: any = quote(routes);
    expect(chooseRoute(invoice, routeQuote, merchant, now).selectedRouteId).toBe("slow-safe");
    expect(chooseRoute(invoice, routeQuote, merchant, now).selectedRouteId).toBe("slow-safe");
    expect(routeScore(invoice, routes[0], routes, merchant)).toBeTypeOf("number");
  });
});
