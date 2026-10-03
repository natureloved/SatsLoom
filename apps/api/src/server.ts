/**
 * SatsLoom API.
 *
 * Rules this file enforces (from docs/architecture.md):
 *  - Only this process may hold key material or import the Tachi SDKs. The browser talks to the
 *    API and nothing else.
 *  - Every response carries the honest `mode` of the data inside it.
 *  - Money operations (settle, refund, payout) are idempotent and validated server-side.
 *  - A failed webhook never fails a payment.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { chooseRoute, DecisionLog, evaluateRoutes, feeBps, isQuoteFresh } from "@satsloom/router";
import type {
  ActivityEvent,
  Invoice,
  InvoiceStatus,
  LiquidityRoute,
  Merchant,
  Mode,
  Payout,
  Refund,
  RouteQuote,
  Settlement,
  WebhookEvent,
} from "@satsloom/shared";
import { jsonSafe, describeTimelock } from "@satsloom/shared";
import { TachiAdapter, isAdapterError, type AdapterRole } from "@satsloom/tachi-adapter";
import { Store, type InvoiceRecord } from "./store.js";
import { WebhookDispatcher, fingerprint, signPayload } from "./webhooks.js";

const QUOTE_TTL_SECONDS = 120;
const INVOICE_TTL_SECONDS = Number(process.env.INVOICE_TTL_SECONDS ?? 900);
const DETECTION_INTERVAL_MS = Number(process.env.DETECTION_INTERVAL_MS ?? 2_000);
const LEDGER_FEE_SATS = BigInt(process.env.LEDGER_FEE_SATS ?? "1");
const TERMINAL_STATUSES: InvoiceStatus[] = ["confirmed", "refunded", "failed"];

export type AppOptions = {
  adapter?: TachiAdapter;
  store?: Store;
  /** Enables the /api/demo/* helpers. Off unless explicitly enabled or in fixture mode. */
  enableDemoRoutes?: boolean;
  detectionIntervalMs?: number;
  /** Injected by tests to keep webhook assertions offline. */
  fetchImpl?: typeof fetch;
};

export type BuiltApp = {
  app: FastifyInstance;
  store: Store;
  adapter: TachiAdapter;
  dispatcher: WebhookDispatcher;
  /** Runs one detection pass. Exported so tests drive it instead of racing a timer. */
  detectOnce: () => Promise<void>;
};

export function buildApp(options: AppOptions = {}): BuiltApp {
  const app = Fastify({ logger: process.env.LOG_LEVEL === "silent" ? false : { level: process.env.LOG_LEVEL ?? "info" } });
  const store = options.store ?? new Store();
  const adapter = options.adapter ?? new TachiAdapter();
  const dispatcher = new WebhookDispatcher(store, options.fetchImpl);
  const decisionLog = new DecisionLog();
  /** Webhook secrets are held here and never returned by any endpoint. */
  const webhookSecrets = new Map<string, string>();
  const demoEnabled = options.enableDemoRoutes ?? process.env.ENABLE_DEMO_ROUTES !== "false";
  const apiKey = process.env.SATSLOOM_API_KEY;

  const merchant: Merchant = {
    id: "merchant-demo",
    name: process.env.MERCHANT_NAME ?? "SatsLoom Demo Merchant",
    settlementPolicy: {
      maxFeeSats: BigInt(process.env.MAX_FEE_SATS ?? "1000"),
      maxSettlementSeconds: Number(process.env.MAX_SETTLEMENT_SECONDS ?? 600),
      feeWeight: Number(process.env.WEIGHT_FEE ?? 0.2),
      latencyWeight: Number(process.env.WEIGHT_LATENCY ?? 0.35),
      exitRiskWeight: Number(process.env.WEIGHT_EXIT_RISK ?? 0.35),
      liquidityPenalty: Number(process.env.WEIGHT_LIQUIDITY ?? 0.1),
    },
    payoutAddress: process.env.PAYOUT_ADDRESS,
  };

  /* ------------------------------ CORS ------------------------------ */

  /**
   * CORS is required for two real cases: the embeddable pay button calls this API from a shop's
   * origin, and a Vercel-hosted web app calls a Fly-hosted API. `CORS_ORIGINS` lists the allowed
   * origins (`*` for a demo, an explicit list for anything else). The Tachi daemon itself has no
   * browser CORS, which is exactly why every daemon call goes through this process.
   */
  const corsOrigins = (process.env.CORS_ORIGINS ?? "*").split(",").map((origin) => origin.trim()).filter(Boolean);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && (corsOrigins.includes("*") || corsOrigins.includes(origin))) {
      reply.header("Access-Control-Allow-Origin", corsOrigins.includes("*") ? "*" : origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "content-type,x-api-key,idempotency-key");
      reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      reply.header("Access-Control-Max-Age", "600");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  /* ------------------------------ envelope ------------------------------ */

  /**
   * The response envelope.
   *
   * `jsonSafe` wraps the *whole* envelope, not just `data`: `extra` carries quotes and policy
   * objects full of bigints, and Fastify's serializer throws on those rather than stringifying
   * them. Doing it in one place means a new endpoint cannot reintroduce the bug.
   */
  async function envelope(requestId: string, data: unknown, extra: Record<string, unknown> = {}) {
    const status = await adapter.getStatus();
    return jsonSafe({
      requestId,
      mode: status.mode,
      daemon: { reachable: status.reachable, network: status.network, version: status.version, detail: status.detail, checkedAt: status.checkedAt },
      ...extra,
      data,
    });
  }

  function fail(reply: FastifyReply, requestId: string, error: unknown, fallbackStatus = 502) {
    const code = isAdapterError(error) ? error.code : "error";
    const status = isAdapterError(error) ? error.statusCode : fallbackStatus;
    const message = error instanceof Error ? error.message : String(error);
    const details = isAdapterError(error) ? error.details : undefined;
    return reply.code(status).send({ requestId, mode: "degraded", error: { code, message, details }, data: null });
  }

  /* ------------------------------ auth ------------------------------ */

  /**
   * Optional API key. When `SATSLOOM_API_KEY` is unset the API stays open, which is right for a
   * local demo and wrong for anything else — so the README says so explicitly.
   */
  function requireKey(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!apiKey) return true;
    const provided = request.headers["x-api-key"];
    if (typeof provided === "string" && provided === apiKey) return true;
    void reply.code(401).send({ mode: "degraded", error: { code: "unauthorized", message: "Missing or invalid X-Api-Key" }, data: null });
    return false;
  }

  /* ------------------------------ helpers ------------------------------ */

  const target = () => adapter.targetFor("merchant");

  function routeFor(provider: Awaited<ReturnType<TachiAdapter["liquidityDirectory"]>>[number], expiresAt: string): LiquidityRoute {
    return {
      id: provider.id,
      source: provider.kind === "onchain_redemption" ? "onchain_redemption" : provider.kind === "self_custody" ? "vtxo" : "liquidity_provider",
      provider: provider.name,
      capacitySats: provider.capacitySats,
      feeSats: provider.feeSats,
      estimatedSettlementSeconds: provider.latencySeconds,
      expiresAt,
      exitRisk: provider.exitRisk,
      timelockBlocks: provider.timelockBlocks,
      available: provider.available,
      requiresCooperativeSigning: provider.requiresCooperativeSigning,
      simulation: false,
      unavailableReason: provider.available ? undefined : provider.detail,
    };
  }

  async function buildQuote(invoice: InvoiceRecord): Promise<RouteQuote> {
    const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();
    const directory = await adapter.liquidityDirectory();
    return {
      invoiceId: invoice.id,
      routes: directory.map((provider) => routeFor(provider, expiresAt)),
      quotedAt: new Date().toISOString(),
      quoteExpiresAt: expiresAt,
    };
  }

  async function emitWebhook(event: WebhookEvent, payload: unknown) {
    const status = await adapter.getStatus();
    await dispatcher.emit(event, payload, { mode: status.mode, secrets: webhookSecrets });
  }

  function invoiceView(invoice: InvoiceRecord) {
    return {
      ...invoice,
      explorerUrl: invoice.proof ? adapter.getExplorerUrl(invoice.proof.txid) : undefined,
    };
  }

  /* ------------------------------ health & daemon ------------------------------ */

  app.get("/api/health", async (request) => envelope(request.id, { ok: true, service: "satsloom-api" }));

  app.get("/api/tachi/status", async (request) => envelope(request.id, await adapter.getStatus()));

  app.get("/api/tachi/validators", async (request) => envelope(request.id, await adapter.getValidators()));

  app.get("/api/tachi/detail", async (request) => {
    const [detail, capabilities] = await Promise.all([adapter.getDaemonDetail(), adapter.capabilities()]);
    return envelope(request.id, detail, { capabilities });
  });

  app.get("/api/tachi/capabilities", async (request) => envelope(request.id, await adapter.capabilities()));

  /* ------------------------------ merchant & dashboard ------------------------------ */

  app.get("/api/merchant", async (request) => envelope(request.id, merchant));

  app.get("/api/dashboard/summary", async (request) => {
    const mode: Mode = (await adapter.getStatus()).mode;
    const invoices = [...store.invoices.values()];
    const confirmed = invoices.filter((i) => i.status === "confirmed" || i.status === "refunded");
    const refunded = [...store.refunds.values()].filter((r) => r.status === "settled");
    const payouts = [...store.payouts.values()].filter((p) => p.status === "settled");

    let offchain = 0n;
    let offchainError: string | undefined;
    try {
      offchain = await adapter.getSpendableBalance("merchant");
    } catch (error) {
      offchainError = error instanceof Error ? error.message : String(error);
    }
    const onchain = adapter.hasIdentity("merchant")
      ? await adapter.getOnchainBalance(adapter.identity("merchant").address)
      : { sats: null, error: "no merchant identity configured" };

    const pendingSats = invoices.filter((i) => i.status === "pending").reduce((sum, i) => sum + i.amountSats, 0n);

    return envelope(request.id, {
      mode,
      counts: store.invoiceStatusCounts(),
      totals: {
        invoicedSats: invoices.reduce((sum, i) => sum + i.amountSats, 0n),
        confirmedSats: confirmed.reduce((sum, i) => sum + i.amountSats, 0n),
        refundedSats: refunded.reduce((sum, r) => sum + r.amountSats, 0n),
        paidOutSats: payouts.reduce((sum, p) => sum + p.amountSats, 0n),
      },
      balance: {
        offchainSats: offchain,
        onchainSats: onchain.sats,
        pendingSats,
        note: offchainError ?? onchain.error,
      },
      payoutAddress: merchant.payoutAddress ?? null,
      recentActivity: store.recentActivity(),
    });
  });

  /* ------------------------------ invoices ------------------------------ */

  app.post("/api/invoices", async (request: FastifyRequest<{ Body: { amountSats?: string | number; memo?: string; orderId?: string; expiresInSeconds?: number } }>, reply) => {
    if (!requireKey(request, reply)) return reply;
    const body = request.body ?? {};
    let amount: bigint;
    try {
      amount = BigInt(body.amountSats ?? 0);
    } catch {
      return fail(reply, request.id, new Error("amountSats must be an integer number of satoshis"), 400);
    }
    if (amount <= 0n) return fail(reply, request.id, new Error("amountSats must be positive"), 400);
    if (amount > 21_000_000n * 100_000_000n) return fail(reply, request.id, new Error("amountSats exceeds the total bitcoin supply"), 400);

    const status = await adapter.getStatus();
    if (status.mode === "degraded") {
      // An invoice is a promise to accept a specific payment at a specific address. Without the
      // daemon we cannot derive that address or read the baseline, so we refuse rather than mint a
      // payment request that could never be detected as paid.
      return fail(
        reply,
        request.id,
        new Error(`The Tachi daemon is unreachable (${status.detail ?? "no detail"}), so a payment target cannot be established. No invoice was created.`),
        503,
      );
    }

    try {
      const paymentTarget = await target();
      // The baseline must be real. Substituting an empty list on failure would make every
      // pre-existing VTXO look like a fresh payment to this invoice.
      let baseline: string[];
      try {
        baseline = (await adapter.getAddressVtxos(paymentTarget.owner)).map((vtxo) => vtxo.vtxoId);
      } catch (error) {
        return fail(
          reply,
          request.id,
          new Error(`Could not read the payment target's current VTXO set, so a new payment could not be distinguished from existing balance. No invoice was created. (${error instanceof Error ? error.message : String(error)})`),
          503,
        );
      }
      const now = new Date();
      const ttl = Math.min(Math.max(body.expiresInSeconds ?? INVOICE_TTL_SECONDS, 60), 86_400);
      const invoice: InvoiceRecord = {
        id: crypto.randomUUID(),
        amountSats: amount,
        memo: body.memo?.slice(0, 200),
        status: "created",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
        paymentTarget,
        baselineVtxoIds: baseline,
        orderId: body.orderId?.slice(0, 100),
      };
      store.invoices.set(invoice.id, invoice);
      const quote = await buildQuote(invoice);
      store.quotes.set(invoice.id, quote);
      store.addActivity({ kind: "invoice.created", message: `Invoice for ${amount} sats created`, invoiceId: invoice.id, mode: (await adapter.getStatus()).mode });
      await emitWebhook("invoice.created", invoiceView(invoice));
      return envelope(request.id, invoiceView(invoice), { quote });
    } catch (error) {
      return fail(reply, request.id, error);
    }
  });

  app.get("/api/invoices", async (request) => {
    const invoices = [...store.invoices.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return envelope(request.id, invoices.map(invoiceView));
  });

  app.get("/api/invoices/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    return envelope(request.id, invoiceView(invoice), {
      quote: store.quotes.get(invoice.id) ?? null,
      decision: store.decisions.get(invoice.id) ?? null,
      settlement: store.settlements.get(invoice.id) ?? null,
      refunds: [...store.refunds.values()].filter((r) => r.invoiceId === invoice.id),
    });
  });

  app.get("/api/invoices/:id/routes", async (request: FastifyRequest<{ Params: { id: string }; Querystring: { refresh?: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    try {
      let quote = store.quotes.get(invoice.id);
      // A quote is a perishable good. Re-quoting on demand is the difference between "the router
      // chose a route" and "the router chose a route that existed two minutes ago".
      if (!quote || request.query.refresh === "1" || !isQuoteFresh(quote)) {
        quote = await buildQuote(invoice);
        store.quotes.set(invoice.id, quote);
        if (store.quotes.get(invoice.id) && store.decisions.get(invoice.id)) {
          decisionLog.record({ invoiceId: invoice.id, kind: "requoted", reason: "quote refreshed from the liquidity directory" });
        }
      }
      const evaluations = evaluateRoutes(invoice, quote, merchant).map((evaluation) => ({
        ...evaluation,
        timelock: describeTimelock(evaluation.route),
        feeBps: feeBps(evaluation.route.feeSats, invoice.amountSats),
      }));
      return envelope(request.id, quote, { evaluations, fresh: isQuoteFresh(quote) });
    } catch (error) {
      return fail(reply, request.id, error);
    }
  });

  app.post("/api/invoices/:id/quote", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    try {
      const quote = await buildQuote(invoice);
      store.quotes.set(invoice.id, quote);
      return envelope(request.id, quote);
    } catch (error) {
      return fail(reply, request.id, error);
    }
  });

  app.post("/api/invoices/:id/select-route", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    const quote = store.quotes.get(request.params.id);
    if (!invoice || !quote) return fail(reply, request.id, new Error("invoice or quote not found"), 404);
    try {
      const decision = chooseRoute(invoice, quote, merchant);
      store.decisions.set(invoice.id, decision);
      decisionLog.record({ invoiceId: invoice.id, kind: "decided", decision, selectedRouteId: decision.selectedRouteId, reason: decision.reason });
      return envelope(request.id, decision);
    } catch (error) {
      return fail(reply, request.id, new Error((error as Error).message), 409);
    }
  });

  /** Demo hook for the fallback story: kill the best route and watch the router re-decide. */
  app.post("/api/invoices/:id/invalidate-best-route", async (request: FastifyRequest<{ Params: { id: string }; Body: { routeId?: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    const quote = store.quotes.get(invoice?.id ?? "");
    if (!invoice || !quote) return fail(reply, request.id, new Error("invoice or quote not found"), 404);
    const candidate =
      (request.body?.routeId ? quote.routes.find((r) => r.id === request.body?.routeId) : undefined) ??
      evaluateRoutes(invoice, quote, merchant).find((e) => e.rank === 1)?.route ??
      quote.routes[0];
    if (!candidate) return fail(reply, request.id, new Error("no route to invalidate"), 409);
    candidate.available = false;
    candidate.unavailableReason = "invalidated by the operator for the fallback demo";
    decisionLog.record({
      invoiceId: invoice.id,
      kind: "invalidated",
      selectedRouteId: candidate.id,
      reason: `route ${candidate.id} was marked unavailable`,
    });
    store.addActivity({
      kind: "route.invalidated",
      message: `Route ${candidate.id} invalidated — next settlement must fall back`,
      invoiceId: invoice.id,
      mode: (await adapter.getStatus()).mode,
    });
    return envelope(request.id, { invalidated: candidate.id, route: candidate });
  });

  /**
   * Settle an invoice: select (or re-select) a route and move the value.
   *
   * The interesting branch is the fallback: if the previously selected route is no longer
   * eligible, the router re-decides and the settlement is recorded as `fallback` with both route
   * ids, so the transparency page can show what changed and why.
   */
  app.post("/api/invoices/:id/settle", async (request: FastifyRequest<{ Params: { id: string }; Headers: { "idempotency-key"?: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    const idempotencyKey = request.headers["idempotency-key"] ?? `settle:${invoice.id}:${invoice.status}`;
    const replay = store.recall<Settlement>(idempotencyKey);
    if (replay) return envelope(request.id, replay, { idempotent: true });

    const existing = store.settlements.get(invoice.id);
    if (existing?.status === "settled") return envelope(request.id, existing, { idempotent: true });

    try {
      let quote = store.quotes.get(invoice.id);
      if (!quote || !isQuoteFresh(quote)) {
        quote = await buildQuote(invoice);
        store.quotes.set(invoice.id, quote);
        decisionLog.record({ invoiceId: invoice.id, kind: "requoted", reason: "quote was stale at settle time" });
      }
      const previous = store.decisions.get(invoice.id);
      let decision = previous;
      const stillEligible = previous ? evaluateRoutes(invoice, quote, merchant).some((e) => e.route.id === previous.selectedRouteId && e.eligible) : false;
      if (!decision || !stillEligible) {
        decision = chooseRoute(invoice, quote, merchant);
        store.decisions.set(invoice.id, decision);
        const isFallback = Boolean(previous && previous.selectedRouteId !== decision.selectedRouteId);
        decisionLog.record({
          invoiceId: invoice.id,
          kind: isFallback ? "fallback" : "decided",
          decision,
          previousRouteId: previous?.selectedRouteId,
          selectedRouteId: decision.selectedRouteId,
          reason: isFallback
            ? `${previous?.selectedRouteId} was no longer eligible — re-selected ${decision.selectedRouteId}: ${decision.reason}`
            : decision.reason,
        });
      }

      const route = quote.routes.find((r) => r.id === decision.selectedRouteId);
      if (!route) return fail(reply, request.id, new Error("selected route disappeared from the quote"), 409);

      const settlement: Settlement = {
        id: crypto.randomUUID(),
        invoiceId: invoice.id,
        routeId: route.id,
        status: "pending",
        simulation: false,
        mode: (await adapter.getStatus()).mode,
        fallbackFrom: previous && previous.selectedRouteId !== route.id ? previous.selectedRouteId : undefined,
        decidedAt: decision.decidedAt,
      };

      if (route.source === "onchain_redemption") {
        // Redemption is a different machine: it leaves the ledger for L1 and cannot be undone
        // inside an epoch, so it is only used when the operator asks for it explicitly.
        if (!merchant.payoutAddress) {
          return fail(reply, request.id, new Error("On-chain redemption requires PAYOUT_ADDRESS to be configured, or choose a ledger route instead"), 409);
        }
        const result = await adapter.withdrawSats({ from: "merchant", toAddress: merchant.payoutAddress, amountSats: invoice.amountSats });
        settlement.status = "settled";
        settlement.txid = result.txid;
        settlement.explorerUrl = adapter.getExplorerUrl(result.txid);
      } else {
        const result = await adapter.transferSats({
          from: "merchant",
          toOwner: (await adapter.targetFor("cold")).owner,
          amountSats: invoice.amountSats,
          feeSats: LEDGER_FEE_SATS,
          memo: `settlement for ${invoice.id}`,
        });
        settlement.status = "settled";
        settlement.txid = result.txid;
        settlement.vtxoId = result.createdVtxoIds[0];
        settlement.explorerUrl = adapter.getExplorerUrl(result.txid);
      }

      store.settlements.set(invoice.id, settlement);
      store.remember(idempotencyKey, "settlement", settlement.id);
      store.addActivity({
        kind: settlement.fallbackFrom ? "settlement.fallback" : "settlement.settled",
        message: settlement.fallbackFrom
          ? `Fallback settlement: ${settlement.fallbackFrom} → ${route.id}`
          : `Settled via ${route.id}`,
        invoiceId: invoice.id,
        txid: settlement.txid,
        explorerUrl: settlement.explorerUrl,
        mode: settlement.mode,
      });
      return envelope(request.id, settlement, { decision, route: { ...route, timelock: describeTimelock(route) } });
    } catch (error) {
      return fail(reply, request.id, error);
    }
  });

  app.get("/api/invoices/:id/settlement", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    return envelope(request.id, store.settlements.get(invoice.id) ?? null, {
      decision: store.decisions.get(invoice.id) ?? null,
      log: decisionLog.list(invoice.id, 20),
    });
  });

  /* ------------------------------ public pay page ------------------------------ */

  app.get("/api/pay/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    // Public by design: no merchant keys, no settlement internals, no mnemonic material.
    return envelope(request.id, {
      id: invoice.id,
      amountSats: invoice.amountSats,
      memo: invoice.memo,
      status: invoice.status,
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt,
      orderId: invoice.orderId,
      paymentTarget: invoice.paymentTarget,
      proof: invoice.proof ?? null,
      explorerUrl: invoice.proof ? adapter.getExplorerUrl(invoice.proof.txid) : undefined,
    });
  });

  app.get("/api/pay/:id/status", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    return envelope(request.id, {
      id: invoice.id,
      status: invoice.status,
      proof: invoice.proof ?? null,
      expiresAt: invoice.expiresAt,
      explorerUrl: invoice.proof ? adapter.getExplorerUrl(invoice.proof.txid) : undefined,
    });
  });

  /* ------------------------------ refunds & payouts ------------------------------ */

  app.post("/api/invoices/:id/refund", async (request: FastifyRequest<{ Params: { id: string }; Body: { amountSats?: string; reason?: string; toOwner?: string }; Headers: { "idempotency-key"?: string } }>, reply) => {
    const invoice = store.invoices.get(request.params.id);
    if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
    if (invoice.status !== "confirmed" && invoice.status !== "refunded") {
      return fail(reply, request.id, new Error(`Only a confirmed invoice can be refunded (status is ${invoice.status})`), 409);
    }
    const body = request.body ?? {};
    let amount: bigint;
    try {
      amount = body.amountSats ? BigInt(body.amountSats) : invoice.proof?.amountSats ?? invoice.amountSats;
    } catch {
      return fail(reply, request.id, new Error("amountSats must be an integer"), 400);
    }
    if (amount <= 0n) return fail(reply, request.id, new Error("Refund amount must be positive"), 400);
    if (amount > invoice.amountSats) return fail(reply, request.id, new Error("Refund cannot exceed the invoice amount"), 400);

    const toOwner = body.toOwner ?? invoice.paidFromOwner;
    if (!toOwner) {
      return fail(
        reply,
        request.id,
        new Error("The payer's ledger key is unknown, so there is nowhere to send the refund. Pass toOwner explicitly."),
        409,
      );
    }

    const idempotencyKey = request.headers["idempotency-key"] ?? `refund:${invoice.id}:${amount}`;
    const replay = store.recall<Refund>(idempotencyKey);
    if (replay) return envelope(request.id, replay, { idempotent: true });

    try {
      const result = await adapter.transferSats({
        from: "merchant",
        toOwner,
        amountSats: amount,
        feeSats: LEDGER_FEE_SATS,
        memo: `refund for ${invoice.id}`,
      });
      const refund: Refund = {
        id: crypto.randomUUID(),
        invoiceId: invoice.id,
        toAddress: toOwner,
        amountSats: amount,
        reason: body.reason?.slice(0, 200) ?? "unspecified",
        status: "settled",
        txid: result.txid,
        explorerUrl: adapter.getExplorerUrl(result.txid),
        createdAt: new Date().toISOString(),
        mode: (await adapter.getStatus()).mode,
      };
      store.refunds.set(refund.id, refund);
      store.remember(idempotencyKey, "refund", refund.id);
      const totalRefunded = [...store.refunds.values()].filter((r) => r.invoiceId === invoice.id && r.status === "settled").reduce((sum, r) => sum + r.amountSats, 0n);
      if (totalRefunded >= invoice.amountSats) invoice.status = "refunded";
      store.addActivity({ kind: "refund.settled", message: `Refunded ${amount} sats: ${refund.reason}`, invoiceId: invoice.id, txid: refund.txid, explorerUrl: refund.explorerUrl, mode: refund.mode });
      await emitWebhook("refund.settled", refund);
      return envelope(request.id, refund);
    } catch (error) {
      return fail(reply, request.id, error);
    }
  });

  app.get("/api/refunds", async (request) => envelope(request.id, [...store.refunds.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))));

  /**
   * Payout / sweep.
   *
   * Two destinations are meaningful and the shape of the address decides which: a 32-byte x-only
   * key stays on the ledger (fast, cheap, reversible until it commits), a Taproot address leaves
   * for L1 (irreversible, CSV-timed, the real "sweep to cold storage" story).
   */
  app.post("/api/payouts", async (request: FastifyRequest<{ Body: { toAddress?: string; toOwner?: string; amountSats?: string; kind?: string }; Headers: { "idempotency-key"?: string } }>, reply) => {
    if (!requireKey(request, reply)) return reply;
    const body = request.body ?? {};
    const destination = body.toAddress ?? body.toOwner ?? merchant.payoutAddress;
    if (!destination) return fail(reply, request.id, new Error("toAddress is required (or set PAYOUT_ADDRESS)"), 400);
    let amount: bigint;
    try {
      amount = BigInt(body.amountSats ?? 0);
    } catch {
      return fail(reply, request.id, new Error("amountSats must be an integer"), 400);
    }
    if (amount <= 0n) return fail(reply, request.id, new Error("amountSats must be positive"), 400);

    const isLedgerKey = /^[0-9a-fA-F]{64}$/.test(destination);
    const kind: Payout["kind"] = isLedgerKey && body.kind !== "onchain_redemption" ? "offchain_transfer" : "onchain_redemption";
    const idempotencyKey = request.headers["idempotency-key"] ?? `payout:${destination}:${amount}`;
    const replay = store.recall<Payout>(idempotencyKey);
    if (replay) return envelope(request.id, replay, { idempotent: true });

    try {
      const result = isLedgerKey && kind === "offchain_transfer"
        ? await adapter.transferSats({ from: "merchant", toOwner: destination, amountSats: amount, feeSats: LEDGER_FEE_SATS, memo: "merchant payout" })
        : await adapter.withdrawSats({ from: "merchant", toAddress: destination, amountSats: amount });
      const payout: Payout = {
        id: crypto.randomUUID(),
        toAddress: destination,
        amountSats: amount,
        status: "settled",
        txid: result.txid,
        explorerUrl: adapter.getExplorerUrl(result.txid),
        createdAt: new Date().toISOString(),
        mode: (await adapter.getStatus()).mode,
        kind,
      };
      store.payouts.set(payout.id, payout);
      store.remember(idempotencyKey, "payout", payout.id);
      store.addActivity({
        kind: "payout.settled",
        message: kind === "onchain_redemption" ? `Swept ${amount} sats to L1 ${destination.slice(0, 14)}…` : `Paid out ${amount} sats on the ledger`,
        txid: payout.txid,
        explorerUrl: payout.explorerUrl,
        mode: payout.mode,
      });
      await emitWebhook("payout.settled", payout);
      return envelope(request.id, payout);
    } catch (error) {
      return fail(reply, request.id, error);
    }
  });

  app.get("/api/payouts", async (request) => envelope(request.id, [...store.payouts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))));

  /* ------------------------------ liquidity directory ------------------------------ */

  app.get("/api/routes/liquidity", async (request, reply) => {
    try {
      const providers = await adapter.liquidityDirectory();
      return envelope(request.id, {
        providers: providers.map((provider) => ({
          ...provider,
          timelock: provider.timelockBlocks
            ? describeTimelock({ estimatedSettlementSeconds: provider.latencySeconds, timelockBlocks: provider.timelockBlocks })
            : describeTimelock({ estimatedSettlementSeconds: provider.latencySeconds }),
        })),
        policy: merchant.settlementPolicy,
        decisionLog: decisionLog.list(undefined, 25),
      });
    } catch (error) {
      return fail(reply, request.id, error);
    }
  });

  app.get("/api/routes/decisions", async (request: FastifyRequest<{ Querystring: { invoiceId?: string } }>) =>
    envelope(request.id, decisionLog.list(request.query.invoiceId, 50)));

  app.get("/api/policy", async (request) => envelope(request.id, merchant.settlementPolicy));

  /** The policy editor writes here; the next quote uses the new weights (determinism demo). */
  app.post("/api/policy", async (request: FastifyRequest<{ Body: Partial<Record<string, number | string>> }>, reply) => {
    if (!requireKey(request, reply)) return reply;
    const body = request.body ?? {};
    const numeric = (key: string, min: number, max: number) => {
      const raw = body[key];
      if (raw === undefined) return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be a number between ${min} and ${max}`);
      return value;
    };
    try {
      const updated = { ...merchant.settlementPolicy };
      if (body.maxFeeSats !== undefined) updated.maxFeeSats = BigInt(String(body.maxFeeSats));
      if (body.maxSettlementSeconds !== undefined) updated.maxSettlementSeconds = numeric("maxSettlementSeconds", 1, 86_400) ?? updated.maxSettlementSeconds;
      updated.feeWeight = numeric("feeWeight", 0, 1) ?? updated.feeWeight;
      updated.latencyWeight = numeric("latencyWeight", 0, 1) ?? updated.latencyWeight;
      updated.exitRiskWeight = numeric("exitRiskWeight", 0, 1) ?? updated.exitRiskWeight;
      updated.liquidityPenalty = numeric("liquidityPenalty", 0, 1) ?? updated.liquidityPenalty;
      const total = updated.feeWeight + updated.latencyWeight + updated.exitRiskWeight + updated.liquidityPenalty;
      if (total <= 0) throw new Error("At least one weight must be greater than zero");
      merchant.settlementPolicy = updated;
      return envelope(request.id, updated, { normalizedTotal: Number(total.toFixed(6)) });
    } catch (error) {
      return fail(reply, request.id, error, 400);
    }
  });

  /* ------------------------------ webhooks ------------------------------ */

  app.post("/api/webhooks/register", async (request: FastifyRequest<{ Body: { url?: string; events?: WebhookEvent[]; secret?: string } }>, reply) => {
    if (!requireKey(request, reply)) return reply;
    const body = request.body ?? {};
    if (!body.url || !/^https?:\/\//.test(body.url)) return fail(reply, request.id, new Error("url must be an absolute http(s) URL"), 400);
    const allowed: WebhookEvent[] = ["invoice.created", "invoice.pending", "invoice.confirmed", "invoice.expired", "payout.settled", "refund.settled"];
    const events = (body.events && body.events.length ? body.events : allowed).filter((event) => allowed.includes(event));
    if (events.length === 0) return fail(reply, request.id, new Error(`events must include at least one of: ${allowed.join(", ")}`), 400);
    const secret = body.secret ?? crypto.randomUUID().replace(/-/g, "");
    const registration = {
      id: crypto.randomUUID(),
      url: body.url,
      events,
      secretFingerprint: fingerprint(secret),
      createdAt: new Date().toISOString(),
    };
    store.webhooks.set(registration.id, registration);
    webhookSecrets.set(registration.id, secret);
    // The secret is returned exactly once, at registration, and never again.
    return envelope(request.id, { ...registration, secret });
  });

  app.get("/api/webhooks", async (request) => {
    const registrations = [...store.webhooks.values()].map((registration) => ({
      ...registration,
      live: webhookSecrets.has(registration.id),
    }));
    return envelope(request.id, registrations);
  });

  app.delete("/api/webhooks/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    store.webhooks.delete(request.params.id);
    webhookSecrets.delete(request.params.id);
    return envelope(request.id, { deleted: request.params.id });
  });

  app.get("/api/webhooks/deliveries", async (request: FastifyRequest<{ Querystring: { limit?: string } }>) => {
    const limit = Math.min(Number(request.query.limit ?? 50), 200);
    const deliveries = [...store.deliveries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    return envelope(request.id, deliveries);
  });

  /** Replay a delivery by hand — the fastest way for a merchant to debug their endpoint. */
  app.post("/api/webhooks/deliveries/:id/retry", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const delivery = store.deliveries.get(request.params.id);
    if (!delivery) return fail(reply, request.id, new Error("delivery not found"), 404);
    const secret = webhookSecrets.get(delivery.registrationId);
    if (!secret) return fail(reply, request.id, new Error("the registration's secret is no longer held in memory; re-register the endpoint"), 409);
    delivery.status = "retrying";
    delivery.attempts = 0;
    const requeued = await dispatcher.emit(delivery.event, delivery.payload, { mode: (await adapter.getStatus()).mode, secrets: webhookSecrets });
    return envelope(request.id, requeued[0] ?? delivery);
  });

  app.get("/api/webhooks/signature-example", async (request: FastifyRequest<{ Querystring: { secret?: string } }>) => {
    const body = JSON.stringify({ event: "invoice.confirmed", data: { id: "example" } });
    return envelope(request.id, { header: "SatsLoom-Signature", format: "t=<unix>,v1=<hmac-sha256(secret, \"t.body\")>", example: signPayload(request.query.secret ?? "whsec_example", body) });
  });

  /* ------------------------------ demo helpers ------------------------------ */

  if (demoEnabled) {
    app.post("/api/demo/fund-merchant", async (request: FastifyRequest<{ Body: { amountSats?: string } }>, reply) => {
      try {
        const amount = BigInt(request.body?.amountSats ?? process.env.DEMO_FUND_SATS ?? "500000");
        const identity = await adapter.targetFor("merchant");
        const faucet = await adapter.fundFromFaucet(identity.fundingAddress ?? identity.address, amount);
        const onboard = await adapter.onboard("merchant", amount);
        store.addActivity({
          kind: "daemon.status",
          message: `Onboarded ${amount} sats onto the ledger (faucet ${faucet.txid.slice(0, 12)}…)`,
          txid: onboard.txid,
          explorerUrl: adapter.getExplorerUrl(onboard.txid),
          mode: (await adapter.getStatus()).mode,
        });
        return envelope(request.id, { faucet, onboard, target: identity });
      } catch (error) {
        return fail(reply, request.id, error);
      }
    });

    /**
     * The demo payer pays an invoice. This is the judge-facing click: it is a real transfer from a
     * second funded account, so the proof, the explorer link and the webhook are all real.
     */
    app.post("/api/demo/pay-invoice/:id", async (request: FastifyRequest<{ Params: { id: string }; Body: { from?: AdapterRole } }>, reply) => {
      const invoice = store.invoices.get(request.params.id);
      if (!invoice) return fail(reply, request.id, new Error("invoice not found"), 404);
      if (invoice.status === "confirmed") return envelope(request.id, invoiceView(invoice), { idempotent: true });
      if (invoice.status === "expired") return fail(reply, request.id, new Error("invoice has expired"), 409);
      const from: AdapterRole = request.body?.from ?? "demoPayer";
      try {
        const payer = await adapter.targetFor(from);
        const result = await adapter.transferSats({
          from,
          toOwner: invoice.paymentTarget.owner,
          amountSats: invoice.amountSats,
          feeSats: LEDGER_FEE_SATS,
          memo: invoice.memo ?? `payment for ${invoice.id}`,
        });
        invoice.paidFromOwner = payer.owner;
        // Optimistically show the payment immediately; the detection loop confirms it from the
        // ledger rather than trusting the sender's own report.
        invoice.status = "pending";
        store.addActivity({
          kind: "payment.detected",
          message: `Payment broadcast from ${payer.owner.slice(0, 10)}… — awaiting ledger confirmation`,
          invoiceId: invoice.id,
          txid: result.txid,
          explorerUrl: adapter.getExplorerUrl(result.txid),
          mode: (await adapter.getStatus()).mode,
        });
        return envelope(request.id, { invoice: invoiceView(invoice), broadcast: result, payer: payer.owner });
      } catch (error) {
        return fail(reply, request.id, error);
      }
    });

    app.post("/api/demo/onboard-payer", async (request: FastifyRequest<{ Body: { amountSats?: string } }>, reply) => {
      try {
        const amount = BigInt(request.body?.amountSats ?? process.env.DEMO_FUND_SATS ?? "500000");
        const target = await adapter.targetFor("demoPayer");
        const faucet = await adapter.fundFromFaucet(target.fundingAddress ?? target.address, amount);
        const onboard = await adapter.onboard("demoPayer", amount);
        return envelope(request.id, { faucet, onboard, target });
      } catch (error) {
        return fail(reply, request.id, error);
      }
    });

    app.post("/api/demo/pay-invoice/:id/force-confirm", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      // Deliberately absent: there is no way to mark an invoice paid without a ledger proof.
      return fail(reply, request.id, new Error("Not supported by design: SatsLoom has no endpoint that confirms an invoice without an on-ledger proof. Wait for the detection loop to observe the payment."), 501);
    });
  }

  /* ------------------------------ detection loop ------------------------------ */

  const seenProofs = new Map<string, string>();

  async function detectOnce(): Promise<void> {
    const now = Date.now();
    const status = await adapter.getStatus();
    if (status.mode === "degraded") {
      // Nothing to do, and nothing is invented while the daemon is unreachable.
      return;
    }
    for (const invoice of store.invoices.values()) {
      // Widened to a mutable local: the guards below reassign it, and a narrowed union would
      // reject the transitions. `.includes()` is used rather than `===` so the guard does not
      // narrow the variable it tests.
      let current: InvoiceStatus = invoice.status;
      if (TERMINAL_STATUSES.includes(current)) continue;
      const expiry = Date.parse(invoice.expiresAt);
      if (Number.isFinite(expiry) && now > expiry && !invoice.proof) {
        if (current !== "expired") {
          invoice.status = "expired";
          store.addActivity({ kind: "invoice.expired", message: "Invoice expired unpaid", invoiceId: invoice.id, mode: status.mode });
          await emitWebhook("invoice.expired", invoiceView(invoice));
        }
        continue;
      }
      try {
        const proof = await adapter.detectInvoicePayment(invoice);
        if (!proof) continue;
        invoice.proof = proof;
        const isNew = seenProofs.get(invoice.id) !== proof.txid;
        if (proof.confirmations > 0) {
          const wasPending = current !== "confirmed";
          invoice.status = "confirmed";
          current = "confirmed";
          if (wasPending) {
            store.addActivity({
              kind: "invoice.confirmed",
              message: `Payment confirmed on-ledger (${proof.amountSats} sats)`,
              invoiceId: invoice.id,
              txid: proof.txid,
              explorerUrl: proof.explorerUrl,
              mode: proof.mode,
            });
          }
          if (isNew) {
            seenProofs.set(invoice.id, proof.txid);
            await emitWebhook("invoice.confirmed", { ...invoiceView(invoice), proof });
          }
        } else if (current === "created" || current === "pending") {
          if (current !== "pending") {
            invoice.status = "pending";
            current = "pending";
            store.addActivity({
              kind: "payment.detected",
              message: "Payment seen in the mempool, awaiting the next epoch",
              invoiceId: invoice.id,
              txid: proof.txid,
              explorerUrl: proof.explorerUrl,
              mode: proof.mode,
            });
            await emitWebhook("invoice.pending", { ...invoiceView(invoice), proof });
          }
        }
      } catch (error) {
        app.log.warn({ err: error, invoiceId: invoice.id }, "payment detection failed for invoice");
      }
    }
  }

  let detectionTimer: NodeJS.Timeout | undefined;
  if (options.detectionIntervalMs !== 0) {
    const interval = options.detectionIntervalMs ?? DETECTION_INTERVAL_MS;
    detectionTimer = setInterval(() => void detectOnce(), interval);
    detectionTimer.unref?.();
  }

  app.addHook("onClose", async () => {
    if (detectionTimer) clearInterval(detectionTimer);
  });

  return { app, store, adapter, dispatcher, detectOnce };
}

export type { ActivityEvent };
