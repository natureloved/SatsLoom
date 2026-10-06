import fs from "node:fs";
import path from "node:path";
import type { InvoiceAggregate } from "@satsloom/domain";
import type { RouteQuote, Settlement } from "@satsloom/shared";

export type WebhookLog = {
  id: string;
  invoiceId: string;
  event: string;
  url: string;
  status: number | "error";
  payload: unknown;
  timestamp: string;
  error?: string;
};

export type IdempotencyRecord = {
  scope: string;
  requestHash?: string;
  response: unknown;
  createdAt: string;
};

export type StoreData = {
  aggregates: Record<string, any>;
  quotes: Record<string, any>;
  transactions: Record<string, any>;
  refunds: Record<string, any>;
  payouts: Record<string, any>;
  webhookLogs: WebhookLog[];
  webhookUrls: Record<string, string>;
  idempotencyRecords: Record<string, IdempotencyRecord>;
  reservedLiquiditySats: string;
};

export type LoadedStoreData = {
  aggregates: Map<string, InvoiceAggregate>;
  quotes: Map<string, RouteQuote>;
  transactions: Map<string, Settlement>;
  refunds: Map<string, any>;
  payouts: Map<string, any>;
  webhookLogs: WebhookLog[];
  webhookUrls: Map<string, string>;
  idempotencyRecords: Map<string, IdempotencyRecord>;
  reservedLiquiditySats: bigint;
};

/**
 * Single-process JSON persistence for the self-hosted demo. This is not a
 * multi-instance or serverless database; production deployments that need
 * durable/shared state should use a transactional database.
 */
export class PersistentStore {
  private readonly filePath: string | null;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
    if (this.filePath) fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load(): LoadedStoreData {
    const aggregates = new Map<string, InvoiceAggregate>();
    const quotes = new Map<string, RouteQuote>();
    const transactions = new Map<string, Settlement>();
    const refunds = new Map<string, any>();
    const payouts = new Map<string, any>();
    const webhookUrls = new Map<string, string>();
    const idempotencyRecords = new Map<string, IdempotencyRecord>();
    let webhookLogs: WebhookLog[] = [];
    let reservedLiquiditySats = 0n;

    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return { aggregates, quotes, transactions, refunds, payouts, webhookLogs, webhookUrls, idempotencyRecords, reservedLiquiditySats };
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoreData>;

      for (const [id, aggregate] of Object.entries(data.aggregates ?? {})) {
        if (aggregate.invoice?.amountSats !== undefined) aggregate.invoice.amountSats = BigInt(aggregate.invoice.amountSats);
        if (aggregate.decision?.scoringInputs?.feeSats !== undefined) {
          aggregate.decision.scoringInputs.feeSats = BigInt(aggregate.decision.scoringInputs.feeSats);
        }
        if (aggregate.decision?.scoringInputs?.liquidityAvailable !== undefined) {
          aggregate.decision.scoringInputs.liquidityAvailable = BigInt(aggregate.decision.scoringInputs.liquidityAvailable);
        }
        aggregates.set(id, aggregate);
      }

      for (const [id, quote] of Object.entries(data.quotes ?? {})) {
        for (const route of quote.routes ?? []) {
          if (route.capacitySats !== undefined) route.capacitySats = BigInt(route.capacitySats);
          if (route.feeSats !== undefined) route.feeSats = BigInt(route.feeSats);
        }
        quotes.set(id, quote);
      }

      for (const [id, transaction] of Object.entries(data.transactions ?? {})) transactions.set(id, transaction);
      for (const [id, refund] of Object.entries(data.refunds ?? {})) {
        if (refund.amountSats !== undefined) refund.amountSats = BigInt(refund.amountSats);
        refunds.set(id, refund);
      }
      for (const [id, payout] of Object.entries(data.payouts ?? {})) {
        if (payout.amountSats !== undefined) payout.amountSats = BigInt(payout.amountSats);
        payouts.set(id, payout);
      }
      for (const [id, url] of Object.entries(data.webhookUrls ?? {})) webhookUrls.set(id, url);
      for (const [key, record] of Object.entries(data.idempotencyRecords ?? {})) idempotencyRecords.set(key, record);
      if (Array.isArray(data.webhookLogs)) webhookLogs = data.webhookLogs;
      if (data.reservedLiquiditySats !== undefined) reservedLiquiditySats = BigInt(data.reservedLiquiditySats);
    } catch (error) {
      console.error("[Storage] Failed to read store file; starting with empty demo state:", error);
    }

    return { aggregates, quotes, transactions, refunds, payouts, webhookLogs, webhookUrls, idempotencyRecords, reservedLiquiditySats };
  }

  saveDebounced(
    aggregates: Map<string, InvoiceAggregate>,
    quotes: Map<string, RouteQuote>,
    transactions: Map<string, Settlement>,
    refunds: Map<string, any>,
    payouts: Map<string, any>,
    webhookLogs: WebhookLog[],
    webhookUrls: Map<string, string>,
    idempotencyRecords: Map<string, IdempotencyRecord>,
    reservedLiquiditySats: bigint,
  ) {
    if (!this.filePath) return;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveSync(aggregates, quotes, transactions, refunds, payouts, webhookLogs, webhookUrls, idempotencyRecords, reservedLiquiditySats);
    }, 150);
  }

  flush(
    aggregates: Map<string, InvoiceAggregate>,
    quotes: Map<string, RouteQuote>,
    transactions: Map<string, Settlement>,
    refunds: Map<string, any>,
    payouts: Map<string, any>,
    webhookLogs: WebhookLog[],
    webhookUrls: Map<string, string>,
    idempotencyRecords: Map<string, IdempotencyRecord>,
    reservedLiquiditySats: bigint,
  ) {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.saveSync(aggregates, quotes, transactions, refunds, payouts, webhookLogs, webhookUrls, idempotencyRecords, reservedLiquiditySats);
  }

  private saveSync(
    aggregates: Map<string, InvoiceAggregate>,
    quotes: Map<string, RouteQuote>,
    transactions: Map<string, Settlement>,
    refunds: Map<string, any>,
    payouts: Map<string, any>,
    webhookLogs: WebhookLog[],
    webhookUrls: Map<string, string>,
    idempotencyRecords: Map<string, IdempotencyRecord>,
    reservedLiquiditySats: bigint,
  ) {
    if (!this.filePath) return;
    const data: StoreData = {
      aggregates: Object.fromEntries(aggregates),
      quotes: Object.fromEntries(quotes),
      transactions: Object.fromEntries(transactions),
      refunds: Object.fromEntries(refunds),
      payouts: Object.fromEntries(payouts),
      webhookLogs: webhookLogs.slice(-500),
      webhookUrls: Object.fromEntries(webhookUrls),
      idempotencyRecords: Object.fromEntries(idempotencyRecords),
      reservedLiquiditySats: reservedLiquiditySats.toString(),
    };
    const json = JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
      fs.writeFileSync(temporaryPath, json, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best-effort cleanup */ }
      console.error("[Storage] Failed to atomically persist demo state:", error);
    }
  }
}
