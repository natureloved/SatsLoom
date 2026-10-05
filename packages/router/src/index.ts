import type { Invoice, LiquidityRoute, Merchant, RouteDecision, RouteQuote } from "@satsloom/shared";

export const exitRiskScore: Record<LiquidityRoute["exitRisk"], number> = { none: 0, low: 1, medium: 2, high: 3 };

function isValidRoute(route: LiquidityRoute): boolean {
  return Boolean(route.id) && route.capacitySats >= 0n && route.feeSats >= 0n &&
    Number.isFinite(route.estimatedSettlementSeconds) && route.estimatedSettlementSeconds >= 0 &&
    Number.isFinite(Date.parse(route.expiresAt));
}

export function eligibleRoutes(invoice: Invoice, quote: RouteQuote, merchant: Merchant, now = Date.now()) {
  if (quote.invoiceId !== invoice.id || invoice.amountSats <= 0n || Date.parse(invoice.expiresAt) <= now || Date.parse(quote.quoteExpiresAt) <= now) return [];
  return quote.routes.filter((route) => isValidRoute(route) && route.available &&
    route.capacitySats >= invoice.amountSats && Date.parse(route.expiresAt) > now &&
    route.feeSats <= merchant.settlementPolicy.maxFeeSats &&
    route.estimatedSettlementSeconds <= merchant.settlementPolicy.maxSettlementSeconds);
}

export function routeScore(invoice: Invoice, route: LiquidityRoute, routes: LiquidityRoute[], merchant: Merchant): number {
  const policy = merchant.settlementPolicy;
  const weights = [policy.feeWeight, policy.latencyWeight, policy.exitRiskWeight, policy.liquidityPenalty];
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error("Settlement policy weights must be finite non-negative numbers");
  const maxFee = Math.max(Number(policy.maxFeeSats), 1);
  const maxLatency = Math.max(...routes.map((candidate) => candidate.estimatedSettlementSeconds), 1);
  return policy.feeWeight * Number(route.feeSats) / maxFee +
    policy.latencyWeight * route.estimatedSettlementSeconds / maxLatency +
    policy.exitRiskWeight * exitRiskScore[route.exitRisk] / 3 +
    policy.liquidityPenalty * Number(invoice.amountSats) / Math.max(Number(route.capacitySats), 1);
}

export function chooseRoute(invoice: Invoice, quote: RouteQuote, merchant: Merchant, now = Date.now()): RouteDecision {
  const routes = eligibleRoutes(invoice, quote, merchant, now);
  if (!routes.length) throw new Error("No eligible settlement route");
  const sorted = [...routes].sort((a, b) => routeScore(invoice, a, routes, merchant) - routeScore(invoice, b, routes, merchant) || a.id.localeCompare(b.id));
  const selected = sorted[0];
  const next = sorted[1];
  return {
    invoiceId: invoice.id,
    selectedRouteId: selected.id,
    scoringInputs: {
      feeSats: selected.feeSats,
      settlementSeconds: selected.estimatedSettlementSeconds,
      exitRiskWeight: exitRiskScore[selected.exitRisk],
      liquidityAvailable: selected.capacitySats,
      expirySecondsRemaining: Math.max(0, Math.floor((Date.parse(selected.expiresAt) - now) / 1000)),
    },
    reason: `Selected ${selected.source} route because it was valid, had sufficient capacity, ${selected.exitRisk === "none" ? "zero" : selected.exitRisk} exit risk, and settled ${next ? Math.max(0, next.estimatedSettlementSeconds - selected.estimatedSettlementSeconds) : 0} seconds faster than the next available route.`,
    decidedAt: new Date(now).toISOString(),
  };
}
