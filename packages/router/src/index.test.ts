import { describe, expect, it } from "vitest";
import {
  DecisionLog,
  chooseRoute,
  eligibleRoutes,
  evaluateRoutes,
  feeBps,
  isQuoteFresh,
  routeIneligibility,
  routesFromDirectory,
  scoreRoute,
} from "./index.js";
import type { Invoice, LiquidityProvider, LiquidityRoute, Merchant, RouteQuote } from "@satsloom/shared";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const merchant: Merchant = {
  id: "m",
  name: "Test",
  settlementPolicy: {
    maxFeeSats: 1000n,
    maxSettlementSeconds: 600,
    feeWeight: 0.2,
    latencyWeight: 0.35,
    exitRiskWeight: 0.35,
    liquidityPenalty: 0.1,
  },
};

const invoice: Invoice = {
  id: "inv-1",
  amountSats: 50_000n,
  status: "created",
  createdAt: iso(NOW),
  expiresAt: iso(NOW + 15 * 60_000),
};

function route(over: Partial<LiquidityRoute> = {}): LiquidityRoute {
  return {
    id: "r",
    source: "vtxo",
    capacitySats: 250_000n,
    feeSats: 50n,
    estimatedSettlementSeconds: 18,
    expiresAt: iso(NOW + 600_000),
    exitRisk: "none",
    available: true,
    requiresCooperativeSigning: true,
    simulation: false,
    ...over,
  };
}

function quote(routes: LiquidityRoute[], over: Partial<RouteQuote> = {}): RouteQuote {
  return { invoiceId: invoice.id, routes, quotedAt: iso(NOW), quoteExpiresAt: iso(NOW + 600_000), ...over };
}

describe("eligibility", () => {
  it("rejects expired quotes outright", () => {
    const q = quote([route()], { quoteExpiresAt: iso(NOW - 1) });
    expect(isQuoteFresh(q, NOW)).toBe(false);
    expect(eligibleRoutes(invoice, q, merchant, NOW)).toHaveLength(0);
  });

  it("rejects insufficient capacity", () => {
    const r = route({ capacitySats: 49_999n });
    expect(routeIneligibility(invoice, r, merchant, NOW)).toBe("insufficient_capacity");
  });

  it("rejects routes that break the fee or latency policy", () => {
    expect(routeIneligibility(invoice, route({ feeSats: 1001n }), merchant, NOW)).toBe("fee_over_policy");
    expect(routeIneligibility(invoice, route({ estimatedSettlementSeconds: 601 }), merchant, NOW)).toBe("latency_over_policy");
  });

  it("rejects a route that would settle after the invoice expires", () => {
    const shortLived: Invoice = { ...invoice, expiresAt: iso(NOW + 30_000) };
    expect(routeIneligibility(shortLived, route({ estimatedSettlementSeconds: 120 }), merchant, NOW)).toBe("would_exceed_expiry");
  });

  it("treats the policy boundary as inclusive", () => {
    expect(routeIneligibility(invoice, route({ feeSats: 1000n }), merchant, NOW)).toBeNull();
    expect(routeIneligibility(invoice, route({ estimatedSettlementSeconds: 600 }), merchant, NOW)).toBeNull();
  });

  it("filters out unavailable routes and expired route entries", () => {
    const q = quote([route({ id: "dead", available: false }), route({ id: "stale", expiresAt: iso(NOW - 5) })]);
    expect(eligibleRoutes(invoice, q, merchant, NOW).map((r) => r.id)).toEqual([]);
  });
});

describe("determinism", () => {
  it("returns the identical decision for identical inputs", () => {
    const q = quote([route({ id: "a" }), route({ id: "b", feeSats: 10n, estimatedSettlementSeconds: 90 })]);
    const first = chooseRoute(invoice, q, merchant, NOW);
    const second = chooseRoute(invoice, q, merchant, NOW);
    expect(second).toEqual(first);
  });

  it("picks the same route under a shuffled route list", () => {
    const a = route({ id: "a" });
    const b = route({ id: "b", feeSats: 10n, estimatedSettlementSeconds: 90 });
    const c = route({ id: "c", feeSats: 900n, estimatedSettlementSeconds: 5 });
    const forward = chooseRoute(invoice, quote([a, b, c]), merchant, NOW).selectedRouteId;
    const reversed = chooseRoute(invoice, quote([c, b, a]), merchant, NOW).selectedRouteId;
    expect(reversed).toBe(forward);
  });

  it("breaks exact score ties by route id so the result never depends on input order", () => {
    const q = quote([route({ id: "zz" }), route({ id: "aa" })]);
    expect(chooseRoute(invoice, q, merchant, NOW).selectedRouteId).toBe("aa");
  });
});

describe("policy weights actually move the decision", () => {
  const fast: LiquidityRoute = route({ id: "fast", feeSats: 900n, estimatedSettlementSeconds: 5, exitRisk: "medium" });
  const cheap: LiquidityRoute = route({ id: "cheap", feeSats: 20n, estimatedSettlementSeconds: 300, exitRisk: "none" });

  it("prefers the cheap route when fee weight dominates", () => {
    const feeLed: Merchant = { ...merchant, settlementPolicy: { ...merchant.settlementPolicy, feeWeight: 0.9, latencyWeight: 0.05, exitRiskWeight: 0.05, liquidityPenalty: 0.0 } };
    expect(chooseRoute(invoice, quote([fast, cheap]), feeLed, NOW).selectedRouteId).toBe("cheap");
  });

  it("prefers the fast route when latency weight dominates", () => {
    const latencyLed: Merchant = { ...merchant, settlementPolicy: { ...merchant.settlementPolicy, feeWeight: 0.0, latencyWeight: 0.9, exitRiskWeight: 0.1, liquidityPenalty: 0.0 } };
    expect(chooseRoute(invoice, quote([fast, cheap]), latencyLed, NOW).selectedRouteId).toBe("fast");
  });

  it("prefers self-custody when exit risk dominates", () => {
    const riskLed: Merchant = { ...merchant, settlementPolicy: { ...merchant.settlementPolicy, feeWeight: 0.0, latencyWeight: 0.0, exitRiskWeight: 1.0, liquidityPenalty: 0.0 } };
    expect(chooseRoute(invoice, quote([fast, cheap]), riskLed, NOW).selectedRouteId).toBe("cheap");
  });

  it("is monotonic in fee: a cheaper identical route always scores better", () => {
    const peers = [route({ id: "x", feeSats: 100n }), route({ id: "y", feeSats: 200n })];
    const sx = scoreRoute(invoice, peers[0], merchant, peers);
    const sy = scoreRoute(invoice, peers[1], merchant, peers);
    expect(sx).toBeLessThan(sy);
  });
});

describe("explanation quality", () => {
  it("publishes a reason that names the trade-off against the runner-up", () => {
    const q = quote([route({ id: "a", feeSats: 50n, estimatedSettlementSeconds: 20 }), route({ id: "b", feeSats: 300n, estimatedSettlementSeconds: 90 })]);
    const decision = chooseRoute(invoice, q, merchant, NOW);
    expect(decision.reason.length).toBeGreaterThan(60);
    expect(decision.reason).toContain("runner-up");
  });

  it("reports why each rejected route was rejected", () => {
    const q = quote([route({ id: "ok" }), route({ id: "toobig", capacitySats: 1n }), route({ id: "off", available: false })]);
    const evaluations = evaluateRoutes(invoice, q, merchant, NOW);
    expect(evaluations.find((e) => e.route.id === "toobig")?.reason).toBe("insufficient_capacity");
    expect(evaluations.find((e) => e.route.id === "off")?.reason).toBe("unavailable");
    expect(evaluations.find((e) => e.route.id === "ok")?.rank).toBe(1);
  });

  it("throws a diagnostically useful error when nothing is eligible", () => {
    const q = quote([route({ id: "dead", available: false })]);
    expect(() => chooseRoute(invoice, q, merchant, NOW)).toThrow(/No eligible settlement route .*dead: unavailable/);
  });

  it("refuses to decide on a stale quote", () => {
    const stale = quote([route()], { quoteExpiresAt: iso(NOW - 1) });
    expect(() => chooseRoute(invoice, stale, merchant, NOW)).toThrow(/Quote expired/);
  });
});

describe("fallback", () => {
  it("re-selects the runner-up once the best route is invalidated", () => {
    const a = route({ id: "best" });
    const b = route({ id: "second", feeSats: 120n, estimatedSettlementSeconds: 40 });
    const q = quote([a, b]);
    expect(chooseRoute(invoice, q, merchant, NOW).selectedRouteId).toBe("best");
    a.available = false;
    expect(chooseRoute(invoice, q, merchant, NOW).selectedRouteId).toBe("second");
  });
});

describe("LP directory", () => {
  const providers: LiquidityProvider[] = [
    { id: "self", name: "Own VTXO", kind: "self_custody", capacitySats: 200_000n, feeSats: 30n, feeBps: 6, latencySeconds: 15, exitRisk: "none", available: true, requiresCooperativeSigning: true, status: "live", lastCheckedAt: iso(NOW) },
    { id: "lp", name: "LP A", kind: "liquidity_provider", capacitySats: 900_000n, feeSats: 200n, feeBps: 40, latencySeconds: 45, exitRisk: "low", available: true, requiresCooperativeSigning: false, status: "live", lastCheckedAt: iso(NOW) },
    { id: "chain", name: "L1 exit", kind: "onchain_redemption", capacitySats: 5_000_000n, feeSats: 800n, feeBps: 160, latencySeconds: 3600, exitRisk: "high", available: false, requiresCooperativeSigning: false, timelockBlocks: 144, status: "unavailable", lastCheckedAt: iso(NOW), detail: "no bitcoind RPC configured" },
  ];

  it("evaluates at least two live sources per invoice", () => {
    const routes = routesFromDirectory(invoice, providers, { quoteExpiresAt: iso(NOW + 600_000), now: NOW });
    const live = eligibleRoutes(invoice, quote(routes), merchant, NOW);
    expect(live.length).toBeGreaterThanOrEqual(2);
  });

  it("carries an unavailable provider's reason through to the route", () => {
    const routes = routesFromDirectory(invoice, providers, { quoteExpiresAt: iso(NOW + 600_000), now: NOW });
    const chain = routes.find((r) => r.id === "chain")!;
    expect(chain.available).toBe(false);
    expect(chain.unavailableReason).toMatch(/bitcoind/);
    expect(chain.timelockBlocks).toBe(144);
  });

  it("computes fee in basis points of the invoice", () => {
    expect(feeBps(50n, 50_000n)).toBe(10);
    expect(feeBps(0n, 0n)).toBe(0);
  });
});

describe("decision log", () => {
  it("records a fallback with both route ids so the switch is auditable", () => {
    const log = new DecisionLog();
    log.record({ invoiceId: "inv-1", kind: "decided", selectedRouteId: "best", reason: "initial" });
    log.record({ invoiceId: "inv-1", kind: "fallback", previousRouteId: "best", selectedRouteId: "second", reason: "best became unavailable" });
    const entries = log.list("inv-1");
    expect(entries[0].kind).toBe("fallback");
    expect(entries[0].previousRouteId).toBe("best");
    expect(entries[0].selectedRouteId).toBe("second");
  });

  it("caps retained entries", () => {
    const log = new DecisionLog(3);
    for (let i = 0; i < 10; i++) log.record({ invoiceId: `i${i}`, kind: "decided", reason: "r" });
    expect(log.list().length).toBe(3);
  });
});
