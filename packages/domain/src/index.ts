import { chooseRoute, eligibleRoutes } from "@satsloom/router";
import type { Invoice, LiquidityRoute, Merchant, RouteDecision, RouteQuote, Settlement } from "@satsloom/shared";

export type InvoiceLifecycle =
  | "CREATED"
  | "QUOTED"
  | "PAYMENT_PENDING"
  | "PAYMENT_CONFIRMED"
  | "ROUTE_SELECTED"
  | "SETTLING"
  | "SETTLED"
  | "QUOTE_EXPIRED"
  | "INSUFFICIENT_LIQUIDITY"
  | "SETTLEMENT_FAILED"
  | "FALLBACK_SELECTED"
  | "REFUND_REQUIRED"
  | "REFUNDED";

export type FallbackEvent = {
  fromRouteId: string;
  toRouteId?: string;
  reason: string;
  occurredAt: string;
};

export type InvoiceAggregate = {
  invoice: Invoice;
  lifecycle: InvoiceLifecycle;
  decision?: RouteDecision;
  executionStarted: boolean;
  settlement?: Settlement;
  fallbackHistory: FallbackEvent[];
  purpose?: "x402-demo";
};

export type SettlementExecution = {
  txid?: string;
  vtxoId?: string;
  explorerUrl?: string;
  simulation: boolean;
};

export function createInvoiceAggregate(invoice: Invoice): InvoiceAggregate {
  return { invoice, lifecycle: "CREATED", executionStarted: false, fallbackHistory: [] };
}

export function markQuoted(aggregate: InvoiceAggregate): InvoiceAggregate {
  if (aggregate.lifecycle !== "CREATED") return aggregate;
  aggregate.lifecycle = "QUOTED";
  aggregate.invoice.status = "pending";
  return aggregate;
}

export function confirmPayment(aggregate: InvoiceAggregate, now = Date.now()): { aggregate: InvoiceAggregate; idempotent: boolean } {
  if (aggregate.invoice.status === "confirmed") return { aggregate, idempotent: true };
  if (aggregate.lifecycle === "SETTLED") return { aggregate, idempotent: true };
  if (aggregate.invoice.status !== "pending") {
    throw new Error(`Cannot confirm an invoice with status ${aggregate.invoice.status}`);
  }
  if (Date.parse(aggregate.invoice.expiresAt) <= now) {
    aggregate.lifecycle = "QUOTE_EXPIRED";
    throw new Error("Invoice expired before payment confirmation");
  }
  aggregate.invoice.status = "confirmed";
  aggregate.lifecycle = "PAYMENT_CONFIRMED";
  return { aggregate, idempotent: false };
}

export function selectSettlementRoute(
  aggregate: InvoiceAggregate,
  quote: RouteQuote,
  merchant: Merchant,
  now = Date.now(),
): RouteDecision {
  if (aggregate.executionStarted && aggregate.decision) return aggregate.decision;
  if (aggregate.lifecycle === "SETTLED" || aggregate.lifecycle === "REFUNDED") {
    throw new Error("Invoice is already in a terminal state; route selection is closed");
  }
  if (aggregate.lifecycle === "SETTLEMENT_FAILED" || aggregate.lifecycle === "REFUND_REQUIRED") {
    throw new Error("Settlement has a terminal failure state; reconcile it before selecting another route");
  }
  if (aggregate.invoice.status !== "confirmed") throw new Error("Payment must be confirmed before route selection");
  const decision = chooseRoute(aggregate.invoice, quote, merchant, now);
  aggregate.decision = decision;
  aggregate.lifecycle = "ROUTE_SELECTED";
  return decision;
}

/** Only use this error when the adapter can guarantee the failed attempt moved no funds. */
export class RetryableSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableSettlementError";
  }
}

export async function settleInvoice(
  aggregate: InvoiceAggregate,
  quote: RouteQuote,
  merchant: Merchant,
  execute: (route: LiquidityRoute) => Promise<SettlementExecution>,
  now = Date.now(),
): Promise<{ settlement: Settlement; idempotent: boolean }> {
  if (aggregate.settlement?.status === "settled") return { settlement: aggregate.settlement, idempotent: true };
  if ((aggregate.lifecycle === "SETTLEMENT_FAILED" || aggregate.lifecycle === "REFUND_REQUIRED") && aggregate.settlement) {
    return { settlement: aggregate.settlement, idempotent: true };
  }
  if (aggregate.executionStarted) throw new Error("Settlement is already in progress");
  if (aggregate.invoice.status !== "confirmed") throw new Error("Payment must be confirmed before settlement");
  if (Date.parse(quote.quoteExpiresAt) <= now) {
    aggregate.lifecycle = "QUOTE_EXPIRED";
    throw new Error("Settlement quote expired before execution");
  }

  const initialDecision = aggregate.decision ?? selectSettlementRoute(aggregate, quote, merchant, now);
  const initialRouteId = initialDecision.selectedRouteId;
  let route = quote.routes.find((candidate) => candidate.id === initialRouteId);
  const stillEligible = eligibleRoutes(aggregate.invoice, quote, merchant, now).some((candidate) => candidate.id === route?.id);

  if (!route || !stillEligible) {
    const alternatives = eligibleRoutes(aggregate.invoice, quote, merchant, now);
    if (alternatives.length === 0) {
      aggregate.lifecycle = "REFUND_REQUIRED";
      aggregate.settlement = {
        id: crypto.randomUUID(), invoiceId: aggregate.invoice.id, routeId: initialRouteId,
        status: "refund_required", error: "No eligible fallback route", simulation: true,
      };
      return { settlement: aggregate.settlement, idempotent: false };
    }
    const decision = chooseRoute(aggregate.invoice, quote, merchant, now);
    route = quote.routes.find((candidate) => candidate.id === decision.selectedRouteId)!;
    aggregate.decision = decision;
    aggregate.lifecycle = "FALLBACK_SELECTED";
    aggregate.fallbackHistory.push({
      fromRouteId: initialRouteId,
      toRouteId: route.id,
      reason: `Preferred route ${initialRouteId} became ineligible before execution; selected ${route.id}. ${decision.reason}`,
      occurredAt: new Date(now).toISOString(),
    });
  }

  const attemptedRouteIds = new Set<string>();
  let nextRoute = route;
  while (nextRoute) {
    attemptedRouteIds.add(nextRoute.id);
    aggregate.executionStarted = true;
    aggregate.lifecycle = "SETTLING";
    aggregate.settlement = {
      id: aggregate.settlement?.id ?? crypto.randomUUID(),
      invoiceId: aggregate.invoice.id,
      routeId: nextRoute.id,
      status: aggregate.fallbackHistory.length ? "fallback" : "pending",
      simulation: nextRoute.simulation,
    };

    try {
      const result = await execute(nextRoute);
      aggregate.settlement = { ...aggregate.settlement, ...result, status: "settled" };
      aggregate.lifecycle = "SETTLED";
      aggregate.executionStarted = false;
      return { settlement: aggregate.settlement, idempotent: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aggregate.settlement.status = "failed";
      aggregate.settlement.error = message;
      aggregate.executionStarted = false;

      if (!(error instanceof RetryableSettlementError)) {
        aggregate.lifecycle = "SETTLEMENT_FAILED";
        return { settlement: aggregate.settlement, idempotent: false };
      }

      // The adapter explicitly guaranteed this route did not move funds, so it is safe to try another.
      nextRoute.available = false;
      const alternatives = eligibleRoutes(aggregate.invoice, quote, merchant, now)
        .filter((candidate) => !attemptedRouteIds.has(candidate.id));
      if (alternatives.length === 0) {
        aggregate.lifecycle = "REFUND_REQUIRED";
        aggregate.settlement.status = "refund_required";
        aggregate.settlement.error = `No eligible fallback route after ${nextRoute.id} failed safely: ${message}`;
        return { settlement: aggregate.settlement, idempotent: false };
      }

      const previousRouteId = nextRoute.id;
      const decision = chooseRoute(aggregate.invoice, { ...quote, routes: alternatives }, merchant, now);
      nextRoute = alternatives.find((candidate) => candidate.id === decision.selectedRouteId)!;
      aggregate.decision = decision;
      aggregate.lifecycle = "FALLBACK_SELECTED";
      aggregate.fallbackHistory.push({
        fromRouteId: previousRouteId,
        toRouteId: nextRoute.id,
        reason: `Route ${previousRouteId} reported a safe retryable failure (${message}); selected ${nextRoute.id}. ${decision.reason}`,
        occurredAt: new Date(now).toISOString(),
      });
    }
  }

  throw new Error("Settlement ended without a route result");
}
