import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { confirmPayment, createInvoiceAggregate, markQuoted, selectSettlementRoute, settleInvoice, type InvoiceAggregate } from "@satsloom/domain";
import { TachiSdkAdapter } from "@satsloom/tachi-adapter";
import type { Invoice, Merchant, RouteQuote, Settlement } from "@satsloom/shared";
import { jsonSafe } from "@satsloom/shared";

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

export const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
const adapter = new TachiSdkAdapter();
const mode = "degraded" as const;
const merchant: Merchant = {
  id: "merchant-demo",
  name: "SatsLoom Demo Merchant",
  settlementPolicy: { maxFeeSats: 1_000n, maxSettlementSeconds: 600, feeWeight: 0.2, latencyWeight: 0.35, exitRiskWeight: 0.35, liquidityPenalty: 0.1 },
};

const storeFile = process.env.NODE_ENV === "test" ? undefined : (process.env.SATSLOOM_DATA_FILE ?? "./data/satsloom.json");
const store = new PersistentStore(storeFile);
const loaded = store.load();

const aggregates: Map<string, InvoiceAggregate> = loaded.aggregates;
const quotes: Map<string, RouteQuote> = loaded.quotes;
const transactions: Map<string, Settlement> = loaded.transactions;
const refunds: Map<string, any> = loaded.refunds;
const payouts: Map<string, any> = loaded.payouts;
const webhookUrls = new Map<string, string>();
const webhookLogs: WebhookLog[] = loaded.webhookLogs;
const settlementJobs = new Map<string, Promise<Awaited<ReturnType<typeof settleInvoice>>>>();
const eventClients = new Map<string, Set<any>>();
const liquidity = {
  vtxoSats: 100_000n,
  providerSats: 250_000n,
  onchainSats: 1_000_000n,
  reservedSats: loaded.reservedLiquiditySats,
};

function persist() {
  store.saveDebounced(aggregates, quotes, transactions, refunds, payouts, webhookLogs, liquidity.reservedSats);
}

const envelope = (requestId: string, data: unknown, extra: Record<string, unknown> = {}) => ({
  requestId,
  mode,
  ...extra,
  data: jsonSafe(data),
});
const maximumBitcoinSats = 21_000_000n * 100_000_000n;

function parseSats(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  try {
    const amount = BigInt(value);
    return amount > 0n && amount <= maximumBitcoinSats ? amount : null;
  } catch {
    return null;
  }
}

function allowedBrowserOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const configured = process.env.WEB_ORIGIN;
  if (configured) return origin === configured ? origin : undefined;
  return /^https?:\/\/(localhost|127\.0\.0\.1):(5173|5174)$/.test(origin) ? origin : undefined;
}

function publishInvoiceEvent(invoiceId: string, event: string, data: unknown) {
  const clients = eventClients.get(invoiceId);
  if (clients) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(jsonSafe(data))}\n\n`;
    for (const client of clients) client.write(payload);
  }

  const webhookUrl = webhookUrls.get(invoiceId);
  if (webhookUrl) {
    void dispatchWebhook(invoiceId, webhookUrl, event, data);
  }
}

async function dispatchWebhook(invoiceId: string, url: string, event: string, payload: unknown) {
  const log: WebhookLog = {
    id: crypto.randomUUID(),
    invoiceId,
    event,
    url,
    status: 0,
    payload: jsonSafe(payload),
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-satsloom-event": event,
        "x-satsloom-delivery": log.id,
      },
      body: JSON.stringify({
        id: log.id,
        event,
        invoiceId,
        timestamp: log.timestamp,
        data: jsonSafe(payload),
      }),
      signal: AbortSignal.timeout(4000),
    });
    log.status = response.status;
  } catch (err) {
    log.status = "error";
    log.error = err instanceof Error ? err.message : String(err);
  }

  webhookLogs.push(log);
  persist();
}

app.addHook("onSend", async (request, reply, payload) => {
  const origin = request.headers.origin;
  const allowedOrigin = allowedBrowserOrigin(origin);
  if (allowedOrigin) reply.header("access-control-allow-origin", allowedOrigin);
  reply.header("vary", "Origin");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  reply.header("access-control-allow-headers", "content-type,x-idempotency-key,authorization,x-402-payment,x-payment-invoice");
  reply.header("access-control-expose-headers", "www-authenticate,x-402-invoice-id,x-402-price-sats,x-402-payment-url");
  return payload;
});
app.options("/*", async (_request, reply) => reply.code(204).send());

function aggregateFor(id: string) { return aggregates.get(id); }
function quoteFor(id: string) { return quotes.get(id); }
function invoiceView(aggregate: InvoiceAggregate) {
  return {
    ...aggregate.invoice,
    lifecycle: aggregate.lifecycle,
    decision: aggregate.decision,
    settlement: aggregate.settlement,
    fallbackHistory: aggregate.fallbackHistory,
  };
}

function createDemoQuote(invoice: Invoice): RouteQuote {
  const now = new Date();
  const expiry = new Date(now.getTime() + 10 * 60_000).toISOString();
  return {
    invoiceId: invoice.id,
    quotedAt: now.toISOString(),
    quoteExpiresAt: expiry,
    routes: [
      { id: "vtxo-fast", source: "vtxo", capacitySats: 100_000n, feeSats: 50n, estimatedSettlementSeconds: 18, expiresAt: expiry, exitRisk: "none", available: true, requiresCooperativeSigning: true, simulation: true },
      { id: "lp-standard", source: "liquidity_provider", capacitySats: 250_000n, feeSats: 250n, estimatedSettlementSeconds: 45, expiresAt: expiry, exitRisk: "low", available: true, requiresCooperativeSigning: false, simulation: true },
      { id: "onchain-exit", source: "onchain_redemption", capacitySats: 1_000_000n, feeSats: 500n, estimatedSettlementSeconds: 600, expiresAt: expiry, exitRisk: "high", timelockBlocks: 1008, available: true, requiresCooperativeSigning: false, simulation: true },
    ],
  };
}

app.get("/api/health", async (request) => envelope(request.id, { ok: true, service: "satsloom-api" }));

app.get("/api/tachi/status", async (request) => {
  const [daemon, validators] = await Promise.all([adapter.getStatus(), adapter.getValidators()]);
  return envelope(request.id, {
    daemon,
    validatorCount: validators.length,
    capabilities: {
      vaultCreation: "live",
      vaultVerification: "live",
      deposit: "live",
      vtxoRegistration: "live",
      vtxoQuery: "live",
      userPsbtSigning: "live",
      kdhtCooperativeSigning: "unavailable",
      vtxoTransfer: "unavailable",
      unilateralExitPreparation: "live",
    },
  });
});

app.get("/api/tachi/telemetry", async (request) => {
  const [daemon, validators] = await Promise.all([adapter.getStatus(), adapter.getValidators()]);
  return envelope(request.id, {
    network: daemon.network ?? "regtest",
    daemonUrl: process.env.TACHI_DAEMON_RPC_URL ?? "https://rpc-regtest.tachibtc.com",
    explorerUrl: process.env.TACHI_EXPLORER_URL ?? "https://regtest.tachibtcscan.com",
    timelockBlocks: 1008,
    estimatedTimelockHours: 168,
    validatorCount: validators.length,
    validators,
    primitives: {
      taurusVault: "Native BTC timelocked script tree with cooperative and unilateral exit leaves",
      vtxoExecution: "Virtual UTXO off-chain settlement with Bitcoin anchoring",
      satVM: "Smart contract execution layer compatible with Bitcoin Script and EVM/Wasm",
      x402: "HTTP 402 native-sat machine-to-machine payment rails",
    },
  });
});

app.get("/api/tachi/validators", async (request) => envelope(request.id, await adapter.getValidators()));
app.get("/api/merchant", async (request) => envelope(request.id, merchant));

app.get("/api/overview", async (request) => {
  const all = [...aggregates.values()];
  const settled = all.filter((item) => item.lifecycle === "SETTLED");
  const pending = all.filter((item) => item.lifecycle !== "SETTLED" && item.lifecycle !== "REFUNDED" && (item.invoice.status === "pending" || item.invoice.status === "confirmed"));
  return envelope(request.id, {
    invoiceCount: all.length,
    settledSats: settled.reduce((sum, item) => sum + item.invoice.amountSats, 0n),
    pendingSats: pending.reduce((sum, item) => sum + item.invoice.amountSats, 0n),
    routingLiquiditySats: 1_350_000n,
    reservedLiquiditySats: liquidity.reservedSats,
  });
});

app.get("/api/liquidity", async (request) => envelope(request.id, liquidity, { simulation: true }));
app.get("/api/transactions", async (request) => envelope(request.id, [...transactions.values()], { simulation: true }));
app.get("/api/refunds", async (request) => envelope(request.id, [...refunds.values()], { simulation: true }));
app.get("/api/payouts", async (request) => envelope(request.id, [...payouts.values()], { simulation: true }));
app.get("/api/webhooks", async (request) => envelope(request.id, webhookLogs));

app.post("/api/invoices", async (request: any, reply) => {
  const amountSats = parseSats(request.body?.amountSats);
  if (amountSats === null) return reply.code(400).send(envelope(request.id, null, { error: "amountSats must be a positive integer within the Bitcoin supply" }));
  const memo = typeof request.body?.memo === "string" ? request.body.memo.trim().slice(0, 200) : undefined;
  const webhookUrl = typeof request.body?.webhookUrl === "string" && request.body.webhookUrl.startsWith("http") ? request.body.webhookUrl : undefined;

  const now = new Date();
  const invoice: Invoice = {
    id: crypto.randomUUID(),
    amountSats,
    memo: memo || undefined,
    status: "created",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  };
  const aggregate = markQuoted(createInvoiceAggregate(invoice));
  aggregates.set(invoice.id, aggregate);
  quotes.set(invoice.id, createDemoQuote(invoice));
  if (webhookUrl) webhookUrls.set(invoice.id, webhookUrl);
  persist();
  return envelope(request.id, { ...invoice, lifecycle: aggregate.lifecycle });
});

app.post("/api/checkout/session", async (request: any, reply) => {
  const amountSats = parseSats(request.body?.amountSats);
  if (amountSats === null) return reply.code(400).send(envelope(request.id, null, { error: "amountSats must be a positive integer within the Bitcoin supply" }));
  const now = new Date();
  const requestedMemo = typeof request.body?.memo === "string" ? request.body.memo : `Order ${request.body?.orderId ?? ""}`.trim();
  const webhookUrl = typeof request.body?.webhookUrl === "string" && request.body.webhookUrl.startsWith("http") ? request.body.webhookUrl : undefined;

  const invoice: Invoice = {
    id: crypto.randomUUID(),
    amountSats,
    memo: requestedMemo.trim().slice(0, 200) || undefined,
    status: "created",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  };
  const aggregate = markQuoted(createInvoiceAggregate(invoice));
  aggregates.set(invoice.id, aggregate);
  quotes.set(invoice.id, createDemoQuote(invoice));
  if (webhookUrl) webhookUrls.set(invoice.id, webhookUrl);
  persist();

  const regtestVaultAddress = "bcrt1p4m2ttqsx8veyvh62ezehxf9y2732yyymve4qvr76qw7ue5ttu66qppnr0q";
  const btcAmount = (Number(amountSats) / 100_000_000).toFixed(8);
  const qrPayload = `bitcoin:${regtestVaultAddress}?amount=${btcAmount}&label=${encodeURIComponent(invoice.memo ?? "SatsLoom Invoice")}&message=${invoice.id}`;

  return envelope(
    request.id,
    {
      checkoutSessionId: crypto.randomUUID(),
      invoiceId: invoice.id,
      amountSats: invoice.amountSats.toString(),
      memo: invoice.memo,
      paymentStatus: invoice.status,
      paymentUrl: `/invoices/${invoice.id}`,
      qrPayload,
      invoice,
    },
    { simulation: true },
  );
});

app.get("/api/invoices/:id", async (request: any, reply) => {
  const aggregate = aggregateFor(request.params.id);
  return aggregate ? envelope(request.id, invoiceView(aggregate)) : reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
});

app.post("/api/invoices/:id/simulate-payment", async (request: any, reply) => {
  const aggregate = aggregateFor(request.params.id);
  if (!aggregate) return reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
  try {
    const result = confirmPayment(aggregate);
    if (!result.idempotent) {
      publishInvoiceEvent(aggregate.invoice.id, "payment.confirmed", invoiceView(aggregate));
      persist();
    }
    return envelope(request.id, invoiceView(aggregate), { simulation: true, idempotent: result.idempotent });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message }));
  }
});

app.get("/api/invoices/:id/events", async (request: any, reply: any) => {
  const aggregate = aggregateFor(request.params.id);
  if (!aggregate) return reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
  reply.hijack();
  const response = reply.raw;
  const headers: Record<string, string> = { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };
  const eventOrigin = allowedBrowserOrigin(request.headers.origin);
  if (eventOrigin) headers["access-control-allow-origin"] = eventOrigin;
  response.writeHead(200, headers);
  response.write(`event: snapshot\ndata: ${JSON.stringify(jsonSafe(invoiceView(aggregate)))}\n\n`);
  const clients = eventClients.get(aggregate.invoice.id) ?? new Set<any>();
  clients.add(response);
  eventClients.set(aggregate.invoice.id, clients);
  request.raw.on("close", () => {
    clients.delete(response);
    if (!clients.size) eventClients.delete(aggregate.invoice.id);
  });
});

app.get("/api/invoices/:id/routes", async (request: any, reply) => {
  const quote = quoteFor(request.params.id);
  return quote ? envelope(request.id, quote, { simulation: true }) : reply.code(404).send(envelope(request.id, null, { error: "quote not found" }));
});

app.post("/api/invoices/:id/select-route", async (request: any, reply) => {
  const aggregate = aggregateFor(request.params.id);
  const quote = quoteFor(request.params.id);
  if (!aggregate || !quote) return reply.code(404).send(envelope(request.id, null, { error: "invoice or quote not found" }));
  try {
    const decision = selectSettlementRoute(aggregate, quote, merchant);
    publishInvoiceEvent(aggregate.invoice.id, "route.selected", { aggregate: invoiceView(aggregate), decision });
    persist();
    return envelope(request.id, decision, { simulation: true });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message }));
  }
});

app.post("/api/invoices/:id/invalidate-best-route", async (request: any, reply) => {
  const aggregate = aggregateFor(request.params.id);
  const quote = quoteFor(request.params.id);
  if (!aggregate || !quote) return reply.code(404).send(envelope(request.id, null, { error: "invoice or quote not found" }));
  const routeId = aggregate.decision?.selectedRouteId ?? quote.routes[0]?.id;
  const route = quote.routes.find((candidate) => candidate.id === routeId);
  if (route) route.available = false;
  publishInvoiceEvent(aggregate.invoice.id, "route.invalidated", { routeId, available: false });
  persist();
  return envelope(request.id, { invalidated: routeId, available: false }, { simulation: true });
});

app.post("/api/invoices/:id/settle", async (request: any, reply) => {
  const aggregate = aggregateFor(request.params.id);
  const quote = quoteFor(request.params.id);
  if (!aggregate || !quote) return reply.code(404).send(envelope(request.id, null, { error: "invoice or quote not found" }));
  try {
    let job = settlementJobs.get(aggregate.invoice.id);
    if (!job) {
      job = settleInvoice(aggregate, quote, merchant, async (route) => ({
        simulation: true,
        txid: `sim-${route.id}-${aggregate.invoice.id.slice(0, 8)}`,
      }));
      settlementJobs.set(aggregate.invoice.id, job);
      void job.then(
        () => settlementJobs.delete(aggregate.invoice.id),
        () => settlementJobs.delete(aggregate.invoice.id),
      );
    }
    const result = await job;
    if (result.settlement.txid) transactions.set(result.settlement.txid, result.settlement);
    publishInvoiceEvent(aggregate.invoice.id, "invoice.settled", { settlement: result.settlement, aggregate: invoiceView(aggregate) });
    persist();
    return envelope(request.id, result.settlement, {
      simulation: result.settlement.simulation,
      idempotent: result.idempotent,
      fallbackHistory: aggregate.fallbackHistory,
    });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message }));
  }
});

app.post("/api/invoices/:id/refund", async (request: any, reply) => {
  const aggregate = aggregateFor(request.params.id);
  if (!aggregate) return reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
  const existing = refunds.get(aggregate.invoice.id);
  if (existing) return envelope(request.id, existing, { simulation: true, idempotent: true });
  if (aggregate.lifecycle === "SETTLED") {
    return reply.code(409).send(envelope(request.id, null, { error: "A settled invoice cannot be refunded by this simulation endpoint" }));
  }
  if (aggregate.invoice.status !== "confirmed" && aggregate.lifecycle !== "REFUND_REQUIRED" && aggregate.lifecycle !== "SETTLEMENT_FAILED") {
    return reply.code(409).send(envelope(request.id, null, { error: "Only confirmed or failed invoices can be refunded" }));
  }
  aggregate.invoice.status = "refunded";
  aggregate.lifecycle = "REFUNDED";
  const refund = {
    id: crypto.randomUUID(),
    invoiceId: aggregate.invoice.id,
    amountSats: aggregate.invoice.amountSats,
    status: "refunded",
    reason: request.body?.reason ?? "Merchant requested refund",
    simulation: true,
    createdAt: new Date().toISOString(),
  };
  refunds.set(aggregate.invoice.id, refund);
  publishInvoiceEvent(aggregate.invoice.id, "refund.created", { aggregate: invoiceView(aggregate), refund });
  persist();
  return envelope(request.id, refund, { simulation: true, idempotent: false });
});

app.post("/api/payouts", async (request: any, reply) => {
  const amountSats = parseSats(request.body?.amountSats);
  if (amountSats === null) return reply.code(400).send(envelope(request.id, null, { error: "amountSats must be a positive integer within the Bitcoin supply" }));
  const availableSats = liquidity.vtxoSats + liquidity.providerSats - liquidity.reservedSats;
  if (amountSats > availableSats) return reply.code(409).send(envelope(request.id, null, { error: "Insufficient available routing liquidity" }));
  const destination = typeof request.body?.destination === "string" ? request.body.destination.trim().slice(0, 200) : "merchant-regtest-address";
  if (!destination) return reply.code(400).send(envelope(request.id, null, { error: "destination is required" }));

  const payout = {
    id: crypto.randomUUID(),
    amountSats,
    destination,
    status: "queued",
    simulation: true,
    createdAt: new Date().toISOString(),
  };
  payouts.set(payout.id, payout);
  liquidity.reservedSats += amountSats;
  persist();
  return envelope(request.id, payout, { simulation: true });
});

app.get("/api/invoices/:id/settlement", async (request: any, reply) => {
  const aggregate = aggregateFor(request.params.id);
  return aggregate
    ? envelope(request.id, {
        settlement: aggregate.settlement ?? null,
        lifecycle: aggregate.lifecycle,
        decision: aggregate.decision,
        fallbackHistory: aggregate.fallbackHistory,
      })
    : reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
});

app.get("/api/transactions/:txid", async (request: any, reply) => {
  const settlement = transactions.get(request.params.txid);
  return settlement
    ? envelope(request.id, settlement, { simulation: settlement.simulation })
    : reply.code(404).send(envelope(request.id, null, { error: "transaction not found" }));
});

// x402 Endpoints
app.get("/api/x402/resource", async (request: any, reply) => {
  const authHeader = (request.headers["authorization"] ?? "") as string;
  const paymentHeader = (request.headers["x-payment-invoice"] ?? request.headers["x-402-payment"] ?? "") as string;

  let invoiceId = "";
  if (paymentHeader) {
    invoiceId = paymentHeader.trim();
  } else if (authHeader.startsWith("L402 ")) {
    const token = authHeader.slice(5).trim();
    invoiceId = token.split(":")[0];
  }

  if (invoiceId) {
    const aggregate = aggregates.get(invoiceId);
    if (aggregate && (aggregate.invoice.status === "confirmed" || aggregate.lifecycle === "SETTLED")) {
      return envelope(request.id, {
        unlocked: true,
        protocol: "x402",
        invoiceId,
        service: "Tachi Bitcoin Agentic Execution Layer - Autonomous Compute Feed",
        data: {
          prediction: "BTC/USDT Bullish divergence anchored at Taproot height 840,000",
          recommendedAction: "VTXO Liquidity Rebalance",
          confidenceScore: 0.942,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  const now = new Date();
  const invoice: Invoice = {
    id: crypto.randomUUID(),
    amountSats: 50n,
    memo: "x402 Autonomous Agent Compute Access (50 sats)",
    status: "created",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  };
  const aggregate = markQuoted(createInvoiceAggregate(invoice));
  aggregates.set(invoice.id, aggregate);
  quotes.set(invoice.id, createDemoQuote(invoice));
  persist();

  reply
    .code(402)
    .header("www-authenticate", `L402 invoice="${invoice.id}", price="50", currency="SAT"`)
    .header("x-402-invoice-id", invoice.id)
    .header("x-402-price-sats", "50")
    .header("x-402-payment-url", `/api/invoices/${invoice.id}`)
    .send(
      envelope(
        request.id,
        {
          error: "Payment Required",
          status: 402,
          invoiceId: invoice.id,
          amountSats: "50",
          memo: invoice.memo,
          message: "Provide 'X-Payment-Invoice: <id>' or 'Authorization: L402 <id>' after settlement.",
        },
        { simulation: true },
      ),
    );
});

app.post("/api/x402/agent-pay", async (request: any, reply) => {
  const invoiceId = request.body?.invoiceId;
  const aggregate = aggregates.get(invoiceId);
  const quote = quotes.get(invoiceId);
  if (!aggregate || !quote) return reply.code(404).send(envelope(request.id, null, { error: "Invoice not found" }));

  try {
    confirmPayment(aggregate);
    selectSettlementRoute(aggregate, quote, merchant);
    const result = await settleInvoice(aggregate, quote, merchant, async (route) => ({
      simulation: true,
      txid: `x402-${route.id}-${invoiceId.slice(0, 8)}`,
    }));
    if (result.settlement.txid) transactions.set(result.settlement.txid, result.settlement);
    publishInvoiceEvent(invoiceId, "invoice.settled", { settlement: result.settlement, aggregate: invoiceView(aggregate) });
    persist();
    return envelope(request.id, {
      invoiceId,
      status: "settled",
      proofToken: `L402 ${invoiceId}:simulated-preimage`,
      settlement: result.settlement,
    });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message }));
  }
});

if (process.env.NODE_ENV !== "test") {
  app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
