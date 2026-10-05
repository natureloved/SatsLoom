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

export type StoreData = {
  aggregates: Record<string, any>;
  quotes: Record<string, any>;
  transactions: Record<string, any>;
  refunds: Record<string, any>;
  payouts: Record<string, any>;
  webhookLogs: WebhookLog[];
  reservedLiquiditySats: string;
};

export class PersistentStore {
  private filePath: string | null = null;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  load(): {
    aggregates: Map<string, InvoiceAggregate>;
    quotes: Map<string, RouteQuote>;
    transactions: Map<string, Settlement>;
    refunds: Map<string, any>;
    payouts: Map<string, any>;
    webhookLogs: WebhookLog[];
    reservedLiquiditySats: bigint;
  } {
    const aggregates = new Map<string, InvoiceAggregate>();
    const quotes = new Map<string, RouteQuote>();
    const transactions = new Map<string, Settlement>();
    const refunds = new Map<string, any>();
    const payouts = new Map<string, any>();
    let webhookLogs: WebhookLog[] = [];
    let reservedLiquiditySats = 0n;

    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return { aggregates, quotes, transactions, refunds, payouts, webhookLogs, reservedLiquiditySats };
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data: StoreData = JSON.parse(raw);

      if (data.aggregates) {
        for (const [id, agg] of Object.entries(data.aggregates)) {
          if (agg.invoice?.amountSats) {
            agg.invoice.amountSats = BigInt(agg.invoice.amountSats);
          }
          if (agg.decision?.scoringInputs?.feeSats) {
            agg.decision.scoringInputs.feeSats = BigInt(agg.decision.scoringInputs.feeSats);
          }
          if (agg.decision?.scoringInputs?.liquidityAvailable) {
            agg.decision.scoringInputs.liquidityAvailable = BigInt(agg.decision.scoringInputs.liquidityAvailable);
          }
          aggregates.set(id, agg);
        }
      }

      if (data.quotes) {
        for (const [id, q] of Object.entries(data.quotes)) {
          if (Array.isArray(q.routes)) {
            for (const r of q.routes) {
              if (r.capacitySats !== undefined) r.capacitySats = BigInt(r.capacitySats);
              if (r.feeSats !== undefined) r.feeSats = BigInt(r.feeSats);
            }
          }
          quotes.set(id, q);
        }
      }

      if (data.transactions) {
        for (const [txid, t] of Object.entries(data.transactions)) {
          transactions.set(txid, t);
        }
      }

      if (data.refunds) {
        for (const [id, r] of Object.entries(data.refunds)) {
          if (r.amountSats !== undefined) r.amountSats = BigInt(r.amountSats);
          refunds.set(id, r);
        }
      }

      if (data.payouts) {
        for (const [id, p] of Object.entries(data.payouts)) {
          if (p.amountSats !== undefined) p.amountSats = BigInt(p.amountSats);
          payouts.set(id, p);
        }
      }

      if (Array.isArray(data.webhookLogs)) {
        webhookLogs = data.webhookLogs;
      }

      if (data.reservedLiquiditySats) {
        reservedLiquiditySats = BigInt(data.reservedLiquiditySats);
      }
    } catch (err) {
      console.error("[Storage] Failed to read store file, starting fresh:", err);
    }

    return { aggregates, quotes, transactions, refunds, payouts, webhookLogs, reservedLiquiditySats };
  }

  saveDebounced(
    aggregates: Map<string, InvoiceAggregate>,
    quotes: Map<string, RouteQuote>,
    transactions: Map<string, Settlement>,
    refunds: Map<string, any>,
    payouts: Map<string, any>,
    webhookLogs: WebhookLog[],
    reservedLiquiditySats: bigint,
  ) {
    if (!this.filePath) return;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveSync(aggregates, quotes, transactions, refunds, payouts, webhookLogs, reservedLiquiditySats);
    }, 150);
  }

  saveSync(
    aggregates: Map<string, InvoiceAggregate>,
    quotes: Map<string, RouteQuote>,
    transactions: Map<string, Settlement>,
    refunds: Map<string, any>,
    payouts: Map<string, any>,
    webhookLogs: WebhookLog[],
    reservedLiquiditySats: bigint,
  ) {
    if (!this.filePath) return;
    try {
      const data: StoreData = {
        aggregates: Object.fromEntries(aggregates),
        quotes: Object.fromEntries(quotes),
        transactions: Object.fromEntries(transactions),
        refunds: Object.fromEntries(refunds),
        payouts: Object.fromEntries(payouts),
        webhookLogs: webhookLogs.slice(-100),
        reservedLiquiditySats: reservedLiquiditySats.toString(),
      };
      const json = JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
      fs.writeFileSync(this.filePath, json, "utf-8");
    } catch (err) {
      console.error("[Storage] Failed to persist data to disk:", err);
    }
  }
}
