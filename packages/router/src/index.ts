/**
 * SatsLoom's deterministic settlement router.
 *
 * Bounty #10 asks for a routing marketplace with routing logic, a published reason, and a
 * fallback demo. This module is that logic, and it is deliberately pure: given the same
 * invoice, quote, policy and clock it always returns the same decision, so "same weights +
 * same quote = same route" is a property that can be asserted in a test rather than a claim
 * in a README.
 */
import type {
  Invoice,
  LiquidityProvider,
  LiquidityRoute,
  Merchant,
  RouteDecision,
  RouteQuote,
} from "@satsloom/shared";

const RISK_SCORE: Record<LiquidityRoute["exitRisk"], number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Why a route was excluded from selection. Surfaced in the UI instead of silently filtering. */
export type IneligibleReason =
  | "quote_expired"
  | "unavailable"
  | "insufficient_capacity"
  | "route_expired"
  | "fee_over_policy"
  | "latency_over_policy"
  | "would_exceed_expiry";

export type RouteEvaluation = {
  route: LiquidityRoute;
  score: number | null;
  rank: number | null;
  eligible: boolean;
  reason?: IneligibleReason;
  explanation: string;
};

export function routeIneligibility(
  invoice: Invoice,
  route: LiquidityRoute,
  merchant: Merchant,
  now = Date.now(),
): IneligibleReason | null {
  if (!route.available) return "unavailable";
  if (Date.parse(route.expiresAt) <= now) return "route_expired";
  if (route.capacitySats < invoice.amountSats) return "insufficient_capacity";
  if (route.feeSats > merchant.settlementPolicy.maxFeeSats) return "fee_over_policy";
  if (route.estimatedSettlementSeconds > merchant.settlementPolicy.maxSettlementSeconds) return "latency_over_policy";
  // A route that cannot settle before the invoice expires is not a route, however cheap it is.
  const invoiceExpiry = Date.parse(invoice.expiresAt);
  if (Number.isFinite(invoiceExpiry) && now + route.estimatedSettlementSeconds * 1000 > invoiceExpiry) {
    return "would_exceed_expiry";
  }
  return null;
}

export function eligibleRoutes(
  invoice: Invoice,
  quote: RouteQuote,
  merchant: Merchant,
  now = Date.now(),
): LiquidityRoute[] {
  if (Date.parse(quote.quoteExpiresAt) <= now) return [];
  return quote.routes.filter((route) => routeIneligibility(invoice, route, merchant, now) === null);
}

/** True while a quote may still be acted on. The API re-quotes instead of settling on a stale one. */
export function isQuoteFresh(quote: RouteQuote, now = Date.now()): boolean {
  return Date.parse(quote.quoteExpiresAt) > now;
}

/**
 * The scoring function. Lower is better.
 *
 * Each term is normalised into 0..1 so the policy weights are directly comparable, and the
 * total is rounded to 6 decimals so floating-point noise can never reorder two routes that
 * are equal on the policy's own terms.
 */
export function scoreRoute(
  invoice: Invoice,
  route: LiquidityRoute,
  merchant: Merchant,
  peers: LiquidityRoute[],
): number {
  const policy = merchant.settlementPolicy;
  const maxFee = Number(policy.maxFeeSats || 1n);
  const maxLatency = Math.max(...peers.map((r) => r.estimatedSettlementSeconds), 1);
  const raw =
    policy.feeWeight * (Number(route.feeSats) / maxFee) +
    policy.latencyWeight * (route.estimatedSettlementSeconds / maxLatency) +
    policy.exitRiskWeight * (RISK_SCORE[route.exitRisk] / 3) +
    policy.liquidityPenalty * (Number(invoice.amountSats) / Number(route.capacitySats));
  return Math.round(raw * 1e6) / 1e6;
}

/** Every route with its verdict, ordered best-first. This is what the transparency page renders. */
export function evaluateRoutes(
  invoice: Invoice,
  quote: RouteQuote,
  merchant: Merchant,
  now = Date.now(),
): RouteEvaluation[] {
  const quoteExpired = Date.parse(quote.quoteExpiresAt) <= now;
  const evaluations = quote.routes.map((route) => {
    const reason = quoteExpired ? ("quote_expired" as const) : routeIneligibility(invoice, route, merchant, now);
    const score = reason ? null : scoreRoute(invoice, route, merchant, quote.routes);
    return {
      route,
      score,
      rank: null as number | null,
      eligible: reason === null,
      reason: reason ?? undefined,
      explanation: reason ? explainIneligible(reason, invoice, route) : "",
    };
  });

  // Rank first, then explain: the published reason for the winner names the runner-up, so the
  // runner-up has to exist before the winner's explanation is written.
  const ranked = evaluations
    .filter((e) => e.eligible)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.route.id.localeCompare(b.route.id));
  ranked.forEach((e, index) => {
    e.rank = index + 1;
  });
  ranked.forEach((e, index) => {
    e.explanation = explainEligible(invoice, e.route, merchant, ranked[index + 1]);
  });

  return evaluations;
}

function explainIneligible(reason: IneligibleReason, invoice: Invoice, route: LiquidityRoute): string {
  switch (reason) {
    case "quote_expired":
      return "The quote this route came from has expired; a fresh quote is required before settling.";
    case "unavailable":
      return "Route is marked unavailable (its source stopped responding or was invalidated).";
    case "insufficient_capacity":
      return `Capacity ${route.capacitySats} sats is below the invoice amount ${invoice.amountSats} sats.`;
    case "route_expired":
      return "The route's own expiry passed.";
    case "fee_over_policy":
      return "Fee exceeds the merchant's maxFeeSats policy.";
    case "latency_over_policy":
      return "Estimated settlement time exceeds the merchant's maxSettlementSeconds policy.";
    case "would_exceed_expiry":
      return "The route would not settle before the invoice expires.";
  }
}

function explainEligible(
  invoice: Invoice,
  route: LiquidityRoute,
  merchant: Merchant,
  nextBest?: RouteEvaluation,
): string {
  const faster = nextBest ? nextBest.route.estimatedSettlementSeconds - route.estimatedSettlementSeconds : 0;
  const cheaper = nextBest ? Number(nextBest.route.feeSats) - Number(route.feeSats) : 0;
  const parts = [
    `Selected the ${route.provider ?? route.source} route: ${route.feeSats} sats fee, ${route.estimatedSettlementSeconds}s estimated settlement, ${route.exitRisk} exit risk, ${route.capacitySats} sats capacity.`,
    `It is valid under policy (max ${merchant.settlementPolicy.maxFeeSats} sats / ${merchant.settlementPolicy.maxSettlementSeconds}s) and covers the ${invoice.amountSats} sat invoice.`,
  ];
  if (nextBest && (faster > 0 || cheaper > 0)) {
    const deltas = [
      faster > 0 ? `${faster}s faster` : null,
      cheaper > 0 ? `${cheaper} sats cheaper` : null,
    ].filter(Boolean);
    parts.push(`Against the runner-up (${nextBest.route.id}) it is ${deltas.join(" and ")}.`);
  } else if (nextBest) {
    parts.push(`Runner-up ${nextBest.route.id} scored within a rounding error on the same inputs.`);
  }
  return parts.join(" ");
}

export function chooseRoute(
  invoice: Invoice,
  quote: RouteQuote,
  merchant: Merchant,
  now = Date.now(),
): RouteDecision {
  if (!isQuoteFresh(quote, now)) throw new Error("Quote expired — request a fresh quote before selecting a route");
  const evaluations = evaluateRoutes(invoice, quote, merchant, now);
  const best = evaluations.find((e) => e.rank === 1);
  if (!best || best.score === null) {
    const reasons = evaluations.map((e) => `${e.route.id}: ${e.reason}`).join("; ");
    throw new Error(`No eligible settlement route (${reasons})`);
  }
  return {
    invoiceId: invoice.id,
    selectedRouteId: best.route.id,
    scoringInputs: {
      feeSats: best.route.feeSats,
      settlementSeconds: best.route.estimatedSettlementSeconds,
      exitRiskWeight: RISK_SCORE[best.route.exitRisk],
      liquidityAvailable: best.route.capacitySats,
      expirySecondsRemaining: Math.max(0, Math.floor((Date.parse(best.route.expiresAt) - now) / 1000)),
    },
    reason: best.explanation,
    decidedAt: new Date(now).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * LP directory                                                       *
 * ------------------------------------------------------------------ */

/**
 * Turn the liquidity directory into routes for one invoice.
 *
 * This is where "≥2 live-evaluated sources" comes from: the directory is refreshed from the
 * daemon (self-custody VTXOs, on-chain redemption) and each provider is evaluated per invoice
 * rather than being hardcoded into a quote.
 */
export function routesFromDirectory(
  invoice: Invoice,
  providers: LiquidityProvider[],
  opts: { quoteExpiresAt: string; now?: number } = { quoteExpiresAt: "" },
): LiquidityRoute[] {
  const now = opts.now ?? Date.now();
  return providers.map((provider): LiquidityRoute => ({
    id: provider.id,
    source:
      provider.kind === "onchain_redemption"
        ? "onchain_redemption"
        : provider.kind === "self_custody"
          ? "vtxo"
          : "liquidity_provider",
    provider: provider.name,
    capacitySats: provider.capacitySats,
    feeSats: provider.feeSats,
    estimatedSettlementSeconds: provider.latencySeconds,
    expiresAt: opts.quoteExpiresAt,
    exitRisk: provider.exitRisk,
    timelockBlocks: provider.timelockBlocks,
    available: provider.available && provider.status !== "unavailable",
    requiresCooperativeSigning: provider.requiresCooperativeSigning,
    simulation: provider.status === "unavailable" ? false : false,
    unavailableReason: provider.available ? undefined : provider.detail ?? "provider reports unavailable",
  })).map((route) => ({ ...route, expiresAt: route.expiresAt || new Date(now).toISOString() }));
}

/** Fee in basis points of the invoice amount — how an LP actually prices, shown next to the flat fee. */
export function feeBps(feeSats: bigint, amountSats: bigint): number {
  if (amountSats <= 0n) return 0;
  return Math.round((Number(feeSats) / Number(amountSats)) * 10_000);
}

/* ------------------------------------------------------------------ *
 * Decision log                                                       *
 * ------------------------------------------------------------------ */

export type DecisionLogEntry = {
  at: string;
  invoiceId: string;
  kind: "decided" | "fallback" | "settled" | "invalidated" | "requoted";
  decision?: RouteDecision;
  previousRouteId?: string;
  selectedRouteId?: string;
  reason: string;
};

/**
 * Append-only decision journal. The fallback story needs to be auditable after the fact —
 * "the best route died at 12:04:07 and the router picked X because Y" — so every state
 * transition through the router lands here and is replayable in the UI.
 */
export class DecisionLog {
  private entries: DecisionLogEntry[] = [];
  constructor(private readonly limit = 500) {}

  record(entry: Omit<DecisionLogEntry, "at"> & { at?: string }): DecisionLogEntry {
    const full: DecisionLogEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
    this.entries.push(full);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return full;
  }

  list(invoiceId?: string, limit = 50): DecisionLogEntry[] {
    const filtered = invoiceId ? this.entries.filter((e) => e.invoiceId === invoiceId) : this.entries;
    return filtered.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
  }
}
