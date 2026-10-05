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
  if (aggregate.invoice.status !== "confirmed") throw new Error("Payment must be confirmed before route selection");
  const decision = chooseRoute(aggregate.invoice, quote, merchant, now);
  aggregate.decision = decision;
  aggregate.lifecycle = "ROUTE_SELECTED";
  return decision;
}

export async function settleInvoice(
  aggregate: InvoiceAggregate,
  quote: RouteQuote,
  merchant: Merchant,
  execute: (route: LiquidityRoute) => Promise<SettlementExecution>,
  now = Date.now(),
): Promise<{ settlement: Settlement; idempotent: boolean }> {
  if (aggregate.settlement?.status === "settled") return { settlement: aggregate.settlement, idempotent: true };
  if (aggregate.executionStarted) throw new Error("Settlement is already in progress");
  if (aggregate.invoice.status !== "confirmed") throw new Error("Payment must be confirmed before settlement");
  if (Date.parse(quote.quoteExpiresAt) <= now) {
    aggregate.lifecycle = "QUOTE_EXPIRED";
    throw new Error("Settlement quote expired before execution");
  }

  let decision = aggregate.decision ?? selectSettlementRoute(aggregate, quote, merchant, now);
  const previousRouteId = decision.selectedRouteId;
  let route = quote.routes.find((candidate) => candidate.id === previousRouteId);
  const stillEligible = eligibleRoutes(aggregate.invoice, quote, merchant, now).some((candidate) => candidate.id === route?.id);

  if (!route || !stillEligible) {
    const alternatives = eligibleRoutes(aggregate.invoice, quote, merchant, now);
    if (alternatives.length === 0) {
      aggregate.lifecycle = "REFUND_REQUIRED";
      aggregate.settlement = {
        id: crypto.randomUUID(), invoiceId: aggregate.invoice.id, routeId: previousRouteId,
        status: "refund_required", error: "No eligible fallback route", simulation: true,
      };
      return { settlement: aggregate.settlement, idempotent: false };
    }
    decision = chooseRoute(aggregate.invoice, quote, merchant, now);
    route = quote.routes.find((candidate) => candidate.id === decision.selectedRouteId)!;
    aggregate.decision = decision;
    aggregate.lifecycle = "FALLBACK_SELECTED";
    aggregate.fallbackHistory.push({
      fromRouteId: previousRouteId,
      toRouteId: route.id,
      reason: `Preferred route ${previousRouteId} became ineligible; selected ${route.id}. ${decision.reason}`,
      occurredAt: new Date(now).toISOString(),
    });
  }

  aggregate.executionStarted = true;
  aggregate.lifecycle = "SETTLING";
  aggregate.settlement = {
    id: aggregate.settlement?.id ?? crypto.randomUUID(),
    invoiceId: aggregate.invoice.id,
    routeId: route.id,
    status: aggregate.fallbackHistory.length ? "fallback" : "pending",
    simulation: route.simulation,
  };
  try {
    const result = await execute(route);
    aggregate.settlement = { ...aggregate.settlement, ...result, status: "settled" };
    aggregate.lifecycle = "SETTLED";
    return { settlement: aggregate.settlement, idempotent: false };
  } catch (error) {
    aggregate.settlement.status = "failed";
    aggregate.settlement.error = error instanceof Error ? error.message : String(error);
    aggregate.lifecycle = "SETTLEMENT_FAILED";
    aggregate.executionStarted = false;
    return { settlement: aggregate.settlement, idempotent: false };
  }
}
