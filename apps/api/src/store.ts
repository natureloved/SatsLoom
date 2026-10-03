/**
 * In-memory state.
 *
 * SatsLoom is a single-merchant router on regtest, so a process-local store is the honest
 * choice at this size — and it is written behind an interface so swapping in SQLite/Postgres is
 * a file, not a refactor. What matters for the bounty is not durability but *idempotency*: a
 * settle/refund/payout retried by a flaky client must not move money twice, so every money
 * operation records an idempotency key and replays the recorded result.
 */
import type {
  ActivityEvent,
  Invoice,
  InvoiceStatus,
  Mode,
  PaymentProof,
  Payout,
  Refund,
  RouteDecision,
  RouteQuote,
  Settlement,
  WebhookDelivery,
  WebhookEvent,
  WebhookRegistration,
} from "@satsloom/shared";

export type SettlementRecord = Settlement & { idempotencyKey?: string };
export type RefundRecord = Refund & { idempotencyKey?: string };

export type InvoiceRecord = Invoice & {
  proof?: PaymentProof;
  /** Ledger owner key that paid this invoice, when known. Needed to refund back to the payer. */
  paidFromOwner?: string;
  paymentTarget: NonNullable<Invoice["paymentTarget"]>;
  baselineVtxoIds: string[];
  orderId?: string;
  settledAt?: string;
};

export class Store {
  readonly invoices = new Map<string, InvoiceRecord>();
  readonly quotes = new Map<string, RouteQuote>();
  readonly decisions = new Map<string, RouteDecision>();
  readonly settlements = new Map<string, SettlementRecord>();
  /**
   * Which invoice has claimed which VTXO. A ledger output can only be spent once, so it can only
   * pay for one invoice; without this the same payment could confirm two pending invoices.
   */
  readonly creditedVtxoIds = new Map<string, string>();
  readonly refunds = new Map<string, RefundRecord>();
  readonly payouts = new Map<string, Payout>();
  readonly webhooks = new Map<string, WebhookRegistration>();
  readonly deliveries = new Map<string, WebhookDelivery>();
  readonly activity: ActivityEvent[] = [];
  /** Idempotency keys already applied, mapped to what they produced. */
  private readonly idempotency = new Map<string, { kind: string; id: string }>();

  private readonly activityLimit = 200;

  addActivity(event: Omit<ActivityEvent, "id" | "at"> & { at?: string }): ActivityEvent {
    const full: ActivityEvent = {
      id: crypto.randomUUID(),
      at: event.at ?? new Date().toISOString(),
      ...event,
    } as ActivityEvent;
    this.activity.push(full);
    if (this.activity.length > this.activityLimit) this.activity.splice(0, this.activity.length - this.activityLimit);
    return full;
  }

  recentActivity(limit = 40): ActivityEvent[] {
    return this.activity.slice(-limit).reverse();
  }

  /** Replay a previously-applied idempotent operation. */
  recall<T>(key: string | undefined): T | null {
    if (!key) return null;
    const hit = this.idempotency.get(key);
    if (!hit) return null;
    const source =
      hit.kind === "settlement"
        ? this.settlements.get(hit.id)
        : hit.kind === "refund"
          ? this.refunds.get(hit.id)
          : hit.kind === "payout"
            ? this.payouts.get(hit.id)
            : null;
    return (source as T) ?? null;
  }

  remember(key: string | undefined, kind: string, id: string): void {
    if (!key) return;
    this.idempotency.set(key, { kind, id });
  }

  invoiceByOrderId(orderId: string): InvoiceRecord | undefined {
    for (const invoice of this.invoices.values()) if (invoice.orderId === orderId) return invoice;
    return undefined;
  }

  invoiceStatusCounts(): Record<InvoiceStatus, number> {
    const counts: Record<InvoiceStatus, number> = { created: 0, pending: 0, confirmed: 0, expired: 0, refunded: 0, failed: 0 };
    for (const invoice of this.invoices.values()) counts[invoice.status] += 1;
    return counts;
  }

  /** Delivered-or-retrying webhook headroom, so a slow subscriber cannot grow memory without bound. */
  pruneDeliveries(limit = 500): void {
    if (this.deliveries.size <= limit) return;
    const sorted = [...this.deliveries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const delivery of sorted.slice(0, this.deliveries.size - limit)) this.deliveries.delete(delivery.id);
  }
}

export type EmitOptions = { mode: Mode; webhookEvents: WebhookEvent[]; payload: unknown; invoiceId?: string; txid?: string; explorerUrl?: string };
