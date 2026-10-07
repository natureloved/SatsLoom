import "dotenv/config";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import {
  confirmPayment,
  createInvoiceAggregate,
  markQuoted,
  selectSettlementRoute,
  settleInvoice,
  type InvoiceAggregate,
} from "@satsloom/domain";
import {
  InvoiceWatcher,
  PaymentCorrespondence,
  buildLightningRailFromEnv,
  type PaymentObservation,
  type PaymentRequest,
} from "@satsloom/rails";
import type { Invoice, Merchant, RouteQuote, Settlement } from "@satsloom/shared";
import { jsonSafe } from "@satsloom/shared";
import { PersistentStore, type IdempotencyRecord, type WebhookLog } from "./storage.ts";

export { PersistentStore } from "./storage.ts";
export type { IdempotencyRecord, StoreData, WebhookLog } from "./storage.ts";

export const app = Fastify({
  logger: process.env.NODE_ENV !== "test",
  trustProxy: process.env.VERCEL === "1",
  bodyLimit: 64 * 1024,
});

const mode = "live" as const;
const demoMode = process.env.SATSLOOM_DEMO_MODE === "true" ||
  (process.env.SATSLOOM_DEMO_MODE !== "false" && process.env.NODE_ENV !== "production");
const adminToken = process.env.SATSLOOM_ADMIN_TOKEN ?? "";
const proofSecret = process.env.SATSLOOM_PROOF_SECRET ?? (process.env.NODE_ENV === "production" ? "" : randomBytes(32).toString("hex"));
const defaultStoreFile = fileURLToPath(new URL("../data/satsloom.json", import.meta.url));
const storeFile = process.env.NODE_ENV === "test"
  ? undefined
  : process.env.SATSLOOM_DATA_FILE ?? (process.env.VERCEL === "1" ? undefined : defaultStoreFile);
const store = new PersistentStore(storeFile);
const loaded = store.load();

/* ------------------------------------------------------------- rail selection */
/**
 * Live payments become available as soon as a node is configured; the simulation routes stay
 * available behind demo mode. Both live side by side, and every response envelope states which
 * rail produced it, so a caller cannot be confused about whether real value moved.
 */
let resolvedRail;
try {
  resolvedRail = buildLightningRailFromEnv();
} catch (error) {
  // A strictly-configured but broken node takes the live routes offline loudly, not the whole
  // API: the demo/simulation surface keeps working and live routes report 503 with the reason.
  resolvedRail = {
    source: "fixture" as const,
    rail: buildLightningRailFromEnv({ ...process.env, SATSLOOM_RAIL: "fixture" }).rail,
    fellBack: true,
    fallbackReason: (error as Error).message,
  };
}
const activeRail = resolvedRail.rail;
const railConfigError = resolvedRail.fellBack ? resolvedRail.fallbackReason : undefined;
const railUnavailable = () => railConfigError !== undefined || resolvedRail.source !== "lnd";
/** Payment requests keyed by payment hash, so the watcher can re-check without a database. */
const paymentRequests = new Map<string, PaymentRequest>();
/**
 * Both directions of the hash <-> invoice correspondence, so the credit path (arriving keyed by
 * payment hash) and the read path (arriving keyed by invoice id) each resolve to the other side
 * with a plain call. A single-direction map here is a silent credit blocker, which is exactly
 * the bug this type exists to prevent.
 */
const correspondence = new PaymentCorrespondence();
/**
 * Macaroon -> invoice id for live x402 challenges. Written only when a real payment is
 * credited, so an entry here is evidence that value actually moved.
 */
const liveMacaroons = new Map<string, string>();
const watcher = new InvoiceWatcher({
  rail: activeRail,
  onChange: (observation: PaymentObservation) => onRailObservation(observation),
  onError: (error, context) => {
    app.log?.warn?.({ err: error, railRequestId: context.railRequestId, failures: context.consecutiveFailures },
      "lightning rail observation failed");
  },
});

const merchant: Merchant = {
  id: "merchant-demo",
  name: "SatsLoom Demo Merchant",
  settlementPolicy: {
    maxFeeSats: 1_000n,
    maxSettlementSeconds: 600,
    feeWeight: 0.2,
    latencyWeight: 0.35,
    exitRiskWeight: 0.35,
    liquidityPenalty: 0.1,
  },
};

const aggregates: Map<string, InvoiceAggregate> = loaded.aggregates;
const quotes: Map<string, RouteQuote> = loaded.quotes;
const transactions: Map<string, Settlement> = loaded.transactions;
const refunds: Map<string, any> = loaded.refunds;
const payouts: Map<string, any> = loaded.payouts;
const webhookUrls = loaded.webhookUrls;
const webhookLogs: WebhookLog[] = loaded.webhookLogs;
const idempotencyRecords = loaded.idempotencyRecords;
const settlementJobs = new Map<string, Promise<Awaited<ReturnType<typeof settleInvoice>>>>();
const eventClients = new Map<string, Set<any>>();
const liquidity = {
  vtxoSats: 100_000n,
  providerSats: 250_000n,
  onchainSats: 1_000_000n,
  reservedSats: loaded.reservedLiquiditySats,
};
const maximumBitcoinSats = 21_000_000n * 100_000_000n;

function persist() {
  store.saveDebounced(
    aggregates,
    quotes,
    transactions,
    refunds,
    payouts,
    webhookLogs,
    webhookUrls,
    idempotencyRecords,
    liquidity.reservedSats,
  );
}

const envelope = (requestId: string, data: unknown, extra: Record<string, unknown> = {}) => ({
  requestId,
  mode,
  demo: demoMode,
  ...extra,
  data: jsonSafe(data),
});

/** Rail facts that must never be asserted by a caller. */
const railSummary = () => {
  const descriptor = activeRail.describe();
  return {
    rail: descriptor.id,
    kind: descriptor.kind,
    network: descriptor.network,
    mode: descriptor.mode,
    live: descriptor.live,
    verified: descriptor.verified,
    custody: descriptor.custody,
    note: descriptor.note,
  };
};

/**
 * The one place a real settlement is credited.
 *
 * Deliberately narrow: the watcher reports an observation, this turns it into a verified
 * preimage-backed payment record, and it refuses anything that does not hash to the committed
 * payment hash. It never invents money, and a second call with the same preimage is a no-op.
 */
async function onRailObservation(observation: PaymentObservation) {
  const paymentHash = observation.paymentHash.toLowerCase();
  const request = paymentRequests.get(paymentHash);
  if (!request) return; // somebody else's invoice: not ours to credit
  if (observation.state !== "paid") return;
  const invoiceId = correspondence.invoiceIdFor(paymentHash);
  if (!invoiceId) return;
  const aggregate = aggregates.get(invoiceId);
  if (!aggregate || aggregate.lifecycle === "SETTLED") return;

  const verdict = await activeRail.credit(request);
  if (!verdict.credited) {
    app.log?.warn?.({ reason: verdict.reason, detail: verdict.detail, invoiceId }, "settlement refused by the credit path");
    return;
  }
  // The invoice state machine owns the lifecycle; this only records the verified payment.
  try {
    confirmPayment(aggregate);
  } catch {
    // already confirmed, or expired: recording it as verified payment is still correct.
  }
  aggregate.invoice.status = "confirmed";
  aggregate.lifecycle = "PAYMENT_CONFIRMED";
  const received = {
    invoiceId,
    paymentHash,
    preimage: verdict.preimage,
    amountMsat: verdict.amountMsat,
    surplusMsat: verdict.surplusMsat,
    settledAt: verdict.settledAt,
    rail: request.rail,
    network: request.network,
    mode: request.mode,
    verified: true,
    simulation: false,
  };
  payouts.set(invoiceId, { ...received, id: crypto.randomUUID(), amountSats: verdict.amountMsat / 1000n, status: "credited", createdAt: new Date(verdict.settledAt * 1000).toISOString(), verification: "preimage-sha256" });
  // A live x402 challenge is settled: bind a macaroon to it so a retry carrying the preimage can
  // unlock the resource. The macaroon is only issued after credit, so possession of it implies a
  // payment this node actually verified.
  if (aggregates.get(invoiceId)?.purpose === "x402-live") {
    liveMacaroons.set(`m_${invoiceId.slice(0, 8)}_${paymentHash.slice(0, 12)}`, invoiceId);
  }
  publishInvoiceEvent(invoiceId, "payment.received", received);
  persist();
  app.log?.info?.(received, "real lightning payment credited");
}

export function isValidAdminToken(providedToken: string | undefined, expectedToken = adminToken): boolean {
  if (!expectedToken || !providedToken) return false;
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function requireAdmin(request: any, reply: any): boolean {
  if (!adminToken) {
    reply.code(503).send(envelope(request.id, null, { error: "Administrative API is disabled: configure SATSLOOM_ADMIN_TOKEN" }));
    return false;
  }
  const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!isValidAdminToken(match?.[1])) {
    reply.code(401).header("www-authenticate", "Bearer").send(envelope(request.id, null, { error: "A valid administrative Bearer token is required" }));
    return false;
  }
  return true;
}

function requireDemoMode(request: any, reply: any): boolean {
  if (demoMode) return true;
  reply.code(503).send(envelope(request.id, null, { error: "Live payment execution is not configured; simulated payment endpoints are disabled" }));
  return false;
}

function signDemoReceipt(invoiceId: string, expiresAt: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, invoiceId, expiresAt, simulation: true })).toString("base64url");
  const signature = createHmac("sha256", proofSecret).update(payload).digest("base64url");
  return `SatsLoom-Demo ${payload}.${signature}`;
}

function verifyDemoReceipt(authorization: string): { invoiceId: string; expiresAt: string } | null {
  if (!proofSecret) return null;
  const match = authorization.match(/^SatsLoom-Demo\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const [, payload, providedSignature] = match;
  const expectedSignature = createHmac("sha256", proofSecret).update(payload).digest();
  const actualSignature = Buffer.from(providedSignature, "base64url");
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.v !== 1 || decoded.simulation !== true || typeof decoded.invoiceId !== "string" || typeof decoded.expiresAt !== "string") return null;
    if (!Number.isFinite(Date.parse(decoded.expiresAt)) || Date.parse(decoded.expiresAt) <= Date.now()) return null;
    return { invoiceId: decoded.invoiceId, expiresAt: decoded.expiresAt };
  } catch {
    return null;
  }
}

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

function rateLimitBucketsKey(request: any): string {
  return `${request.ip ?? "unknown"}:${request.routeOptions?.url ?? request.url.split("?")[0]}`;
}
const rateLimitBuckets = new Map<string, { startedAt: number; count: number }>();
function rateLimited(request: any, reply: any, limit: number, windowMs = 60_000): boolean {
  if (process.env.NODE_ENV === "test") return false;
  const now = Date.now();
  const key = rateLimitBucketsKey(request);
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateLimitBuckets.size > 5_000) {
    for (const [bucketKey, value] of rateLimitBuckets) {
      if (now - value.startedAt >= windowMs) rateLimitBuckets.delete(bucketKey);
    }
  }
  if (bucket.count <= limit) return false;
  reply.header("retry-after", String(Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000))));
  reply.code(429).send(envelope(request.id, null, { error: "Rate limit exceeded; retry later" }));
  return true;
}

function idempotencyInput(request: any): { key: string; hash: string } | null {
  const supplied = request.headers["idempotency-key"] ?? request.headers["x-idempotency-key"];
  if (typeof supplied !== "string" || supplied.length < 8 || supplied.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(supplied)) return null;
  return {
    key: supplied,
    hash: createHash("sha256").update(JSON.stringify(request.body ?? {})).digest("hex"),
  };
}

function hasInvalidIdempotencyKey(request: any): boolean {
  const supplied = request.headers["idempotency-key"] ?? request.headers["x-idempotency-key"];
  return supplied !== undefined && idempotencyInput(request) === null;
}

function cachedIdempotentResponse(scope: string, request: any): { response?: unknown; conflict: boolean } {
  const input = idempotencyInput(request);
  if (!input) return { conflict: false };
  const record = idempotencyRecords.get(`${scope}:${input.key}`);
  if (!record) return { conflict: false };
  if (!Number.isFinite(Date.parse(record.createdAt)) || Date.now() - Date.parse(record.createdAt) > 24 * 60 * 60_000) {
    idempotencyRecords.delete(`${scope}:${input.key}`);
    return { conflict: false };
  }
  if (record.requestHash && record.requestHash !== input.hash) return { conflict: true };
  return { response: record.response, conflict: false };
}

function rememberIdempotentResponse(scope: string, request: any, response: unknown) {
  const input = idempotencyInput(request);
  if (!input) return;
  idempotencyRecords.set(`${scope}:${input.key}`, {
    scope,
    requestHash: input.hash,
    response: jsonSafe(response),
    createdAt: new Date().toISOString(),
  });
  if (idempotencyRecords.size > 10_000) {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const [key, record] of idempotencyRecords) {
      if (Date.parse(record.createdAt) < cutoff) idempotencyRecords.delete(key);
      if (idempotencyRecords.size <= 10_000) break;
    }
  }
  persist();
}

function validatedWebhookUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  const allowedOrigins = (process.env.SATSLOOM_WEBHOOK_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowed = allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      const allowHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.pathname === "/" &&
        !parsed.search && !parsed.hash && !isIP(allowHost) && parsed.origin === url.origin;
    } catch { return false; }
  });
  if (!allowed || !process.env.SATSLOOM_WEBHOOK_SECRET) return null;
  return url.toString();
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const ip = ipv4Number(address);
  const inRange = (network: string, prefix: number) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ip & mask) === (ipv4Number(network) & mask);
  };
  const reservedRanges: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !reservedRanges.some(([network, prefix]) => inRange(network, prefix));
}

async function postWebhook(url: string, body: string, headers: Record<string, string>): Promise<number> {
  const target = new URL(url);
  // Resolve and pin a public IPv4 address at dispatch time to reduce DNS rebinding/SSRF risk.
  const addresses = await lookup(target.hostname, { all: true, family: 4, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpv4(address))) {
    throw new Error("Webhook hostname did not resolve exclusively to public IPv4 addresses");
  }
  const address = addresses[0];
  return new Promise<number>((resolve, reject) => {
    const pinnedLookup = ((_hostname: string, options: any, callback: any) => {
      if (options?.all) callback(null, [{ address: address.address, family: 4 }]);
      else callback(null, address.address, 4);
    }) as any;
    const request = https.request(target, {
      method: "POST",
      headers,
      lookup: pinnedLookup,
      servername: target.hostname,
      rejectUnauthorized: true,
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.setTimeout(4_000, () => request.destroy(new Error("Webhook request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function invoiceView(aggregate: InvoiceAggregate) {
  return {
    ...aggregate.invoice,
    simulation: true,
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

async function dispatchWebhook(invoiceId: string, url: string, event: string, payload: unknown) {
  const log: WebhookLog = {
    id: crypto.randomUUID(),
    invoiceId,
    event,
    // Do not expose possible path-based webhook credentials in the public demo log.
    url: (() => { try { return new URL(url).origin; } catch { return "invalid webhook URL"; } })(),
    status: 0,
    payload: jsonSafe(payload),
    timestamp: new Date().toISOString(),
  };
  try {
    const validatedUrl = validatedWebhookUrl(url);
    if (!validatedUrl) throw new Error("Webhook destination is no longer allow-listed");
    const body = JSON.stringify({ id: log.id, event, invoiceId, timestamp: log.timestamp, data: jsonSafe(payload), simulation: true });
    const signature = createHmac("sha256", process.env.SATSLOOM_WEBHOOK_SECRET ?? "").update(body).digest("hex");
    log.status = await postWebhook(validatedUrl, body, {
      "content-type": "application/json",
      "x-satsloom-event": event,
      "x-satsloom-delivery": log.id,
      "x-satsloom-signature": `sha256=${signature}`,
    });
  } catch (error) {
    log.status = "error";
    log.error = error instanceof Error ? error.message : String(error);
  }
  webhookLogs.push(log);
  if (webhookLogs.length > 500) webhookLogs.splice(0, webhookLogs.length - 500);
  persist();
}

function publishInvoiceEvent(invoiceId: string, event: string, data: unknown) {
  const clients = eventClients.get(invoiceId);
  if (clients) {
    const message = `event: ${event}\ndata: ${JSON.stringify(jsonSafe(data))}\n\n`;
    for (const client of clients) client.write(message);
  }
  const url = webhookUrls.get(invoiceId);
  if (url) void dispatchWebhook(invoiceId, url, event, data);
}

app.addHook("onRequest", async (request: any, reply) => {
  if (!request.url.startsWith("/api/") || request.method === "OPTIONS") return;
  const routePath = request.routeOptions?.url ?? request.url.split("?")[0];
  if (rateLimited(request, reply, routePath === "/api/x402/resource" ? 30 : 120)) return reply;
});

app.addHook("preHandler", async (request: any, reply) => {
  if (process.env.NODE_ENV === "test" || demoMode || request.method === "OPTIONS") return;
  const routePath = request.routeOptions?.url ?? request.url.split("?")[0];
  const publicRead = request.method === "GET" && (
    routePath === "/api/health" ||
    routePath.startsWith("/api/tachi/") ||
    routePath === "/api/x402/resource" ||
    routePath === "/api/invoices/:id" ||
    routePath === "/api/invoices/:id/routes" ||
    routePath === "/api/invoices/:id/settlement" ||
    routePath === "/api/invoices/:id/events" ||
    routePath === "/api/transactions/:txid"
  );
  if (!publicRead && !requireAdmin(request, reply)) return reply;
});

app.addHook("onClose", async () => {
  store.flush(aggregates, quotes, transactions, refunds, payouts, webhookLogs, webhookUrls, idempotencyRecords, liquidity.reservedSats);
});

app.addHook("onSend", async (request, reply, payload) => {
  const allowedOrigin = allowedBrowserOrigin(request.headers.origin);
  if (allowedOrigin) reply.header("access-control-allow-origin", allowedOrigin);
  reply.header("vary", "Origin");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  reply.header("access-control-allow-headers", "content-type,idempotency-key,x-idempotency-key,authorization,x-402-payment,x-payment-invoice");
  reply.header("access-control-expose-headers", "www-authenticate,x-402-invoice-id,x-402-price-sats,x-402-payment-url");
  return payload;
});
app.options("/*", async (_request, reply) => reply.code(204).send());

app.get("/api/health", async (request) => {
  const descriptor = activeRail.describe();
  let railHealth;
  try {
    railHealth = await activeRail.health();
  } catch (error) {
    railHealth = { reachable: false, detail: error instanceof Error ? error.message : String(error) };
  }
  return envelope(request.id, {
    ok: true,
    service: "satsloom-api",
    paymentExecution: resolvedRail.source === "lnd" ? "lightning-rail" : "simulated-only",
    persisted: Boolean(storeFile),
    rail: railSummary(),
    railHealth,
    railConfigError: railConfigError ?? null,
    persistence: storeFile ? "single-process-local-json" : "ephemeral-process-memory",
    sharedDatabase: false,
  });
});

function safeConfiguredOrigin(configured: string | undefined): string | null {
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function configuredTachiOrigin(): string | null {
  return safeConfiguredOrigin(process.env.TACHI_DAEMON_RPC_URL);
}

const tachiStatusUnavailable = {
  reachable: false,
  checked: false,
  network: "regtest",
  mode: "not-queried",
  message: "The public API does not contact the Tachi endpoint; use the opt-in local integration spike.",
};

app.get("/api/tachi/status", async (request) => envelope(request.id, {
  daemon: { ...tachiStatusUnavailable, endpointConfigured: configuredTachiOrigin() !== null },
  validatorCount: 0,
  capabilities: {
    vaultCreation: "opt-in adapter spike only",
    vaultVerification: "opt-in adapter spike only",
    deposit: "opt-in regtest spike only; not run by this API",
    vtxoRegistration: "opt-in regtest spike only; not run by this API",
    vtxoQuery: "opt-in regtest spike only; not run by this API",
    userPsbtSigning: "opt-in regtest spike only; not run by this API",
    kdhtCooperativeSigning: "unavailable",
    vtxoTransfer: "unavailable",
    unilateralExitPreparation: "opt-in regtest spike only; not run by this API",
  },
}));

app.get("/api/tachi/telemetry", async (request) => envelope(request.id, {
  network: "regtest (spike configuration; not queried)",
  daemon: { ...tachiStatusUnavailable, endpointConfigured: configuredTachiOrigin() !== null },
  daemonUrl: configuredTachiOrigin(),
  explorerUrl: safeConfiguredOrigin(process.env.TACHI_EXPLORER_URL),
  timelockBlocks: null,
  validatorCount: 0,
  validators: [],
  primitives: {
    taurusVault: "separate opt-in SDK spike; no active demo vault",
    vtxoExecution: "Not executed by the demo settlement API",
    satVM: "Not exercised by this service",
    x402: "HTTP 402 challenge with signed simulation receipt, not payment verification",
  },
}, { simulation: true }));

app.get("/api/tachi/validators", async (request) => envelope(request.id, [], { simulation: true }));
app.get("/api/merchant", async (request) => envelope(request.id, merchant));

app.get("/api/overview", async (request) => {
  const all = [...aggregates.values()];
  const settled = all.filter((item) => item.lifecycle === "SETTLED");
  const pending = all.filter((item) => item.lifecycle !== "SETTLED" && item.lifecycle !== "REFUNDED" &&
    (item.invoice.status === "pending" || item.invoice.status === "confirmed"));
  return envelope(request.id, {
    invoiceCount: all.length,
    settledSats: settled.reduce((sum, item) => sum + item.invoice.amountSats, 0n),
    pendingSats: pending.reduce((sum, item) => sum + item.invoice.amountSats, 0n),
    routingLiquiditySats: 0n,
    simulatedRoutingLiquiditySats: 1_350_000n,
    reservedLiquiditySats: liquidity.reservedSats,
  }, { simulation: true });
});

app.get("/api/liquidity", async (request) => envelope(request.id, liquidity, { simulation: true }));
app.get("/api/transactions", async (request) => envelope(request.id, [...transactions.values()], { simulation: true }));
app.get("/api/refunds", async (request) => envelope(request.id, [...refunds.values()], { simulation: true }));
app.get("/api/payouts", async (request) => envelope(request.id, [...payouts.values()], { simulation: true }));
app.get("/api/webhooks", async (request) => envelope(request.id, webhookLogs, { simulation: true }));

app.post("/api/invoices", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  if (hasInvalidIdempotencyKey(request)) return reply.code(400).send(envelope(request.id, null, { error: "Idempotency-Key must be 8-200 safe characters" }));
  const cached = cachedIdempotentResponse("invoice.create", request);
  if (cached.conflict) return reply.code(409).send(envelope(request.id, null, { error: "Idempotency-Key was already used with a different request body" }));
  if (cached.response) return { ...(cached.response as Record<string, unknown>), requestId: request.id };

  const amountSats = parseSats(request.body?.amountSats);
  if (amountSats === null) return reply.code(400).send(envelope(request.id, null, { error: "amountSats must be a positive integer within the Bitcoin supply" }));
  const memo = typeof request.body?.memo === "string" ? request.body.memo.trim().slice(0, 200) : undefined;
  const rawWebhookUrl = typeof request.body?.webhookUrl === "string" ? request.body.webhookUrl.trim() : "";
  const webhookUrl = rawWebhookUrl ? validatedWebhookUrl(rawWebhookUrl) : null;
  if (rawWebhookUrl && !webhookUrl) {
    return reply.code(400).send(envelope(request.id, null, { error: "Webhook URL requires HTTPS, an exact SATSLOOM_WEBHOOK_ALLOWED_ORIGINS match, and SATSLOOM_WEBHOOK_SECRET" }));
  }

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
  const response = envelope(request.id, { ...invoice, lifecycle: aggregate.lifecycle }, { simulation: true });
  rememberIdempotentResponse("invoice.create", request, response);
  return response;
});

app.post("/api/checkout/session", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  if (hasInvalidIdempotencyKey(request)) return reply.code(400).send(envelope(request.id, null, { error: "Idempotency-Key must be 8-200 safe characters" }));
  const cached = cachedIdempotentResponse("checkout.session", request);
  if (cached.conflict) return reply.code(409).send(envelope(request.id, null, { error: "Idempotency-Key was already used with a different request body" }));
  if (cached.response) return { ...(cached.response as Record<string, unknown>), requestId: request.id };

  const amountSats = parseSats(request.body?.amountSats);
  if (amountSats === null) return reply.code(400).send(envelope(request.id, null, { error: "amountSats must be a positive integer within the Bitcoin supply" }));
  const now = new Date();
  const requestedMemo = typeof request.body?.memo === "string" ? request.body.memo : `Order ${request.body?.orderId ?? ""}`.trim();
  const rawWebhookUrl = typeof request.body?.webhookUrl === "string" ? request.body.webhookUrl.trim() : "";
  const webhookUrl = rawWebhookUrl ? validatedWebhookUrl(rawWebhookUrl) : null;
  if (rawWebhookUrl && !webhookUrl) {
    return reply.code(400).send(envelope(request.id, null, { error: "Webhook URL requires HTTPS, an exact SATSLOOM_WEBHOOK_ALLOWED_ORIGINS match, and SATSLOOM_WEBHOOK_SECRET" }));
  }

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
  const response = envelope(request.id, {
    checkoutSessionId: crypto.randomUUID(),
    invoiceId: invoice.id,
    amountSats: invoice.amountSats.toString(),
    memo: invoice.memo,
    paymentStatus: invoice.status,
    paymentUrl: `/#checkout/${invoice.id}`,
    qrPayload: null,
    simulation: true,
    invoice,
  }, { simulation: true });
  rememberIdempotentResponse("checkout.session", request, response);
  return response;
});

app.get("/api/invoices/:id", async (request: any, reply) => {
  const aggregate = aggregates.get(request.params.id);
  return aggregate ? envelope(request.id, invoiceView(aggregate)) : reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
});

app.post("/api/invoices/:id/simulate-payment", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  const aggregate = aggregates.get(request.params.id);
  if (!aggregate) return reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
  try {
    const result = confirmPayment(aggregate);
    if (!result.idempotent) {
      publishInvoiceEvent(aggregate.invoice.id, "payment.confirmed", invoiceView(aggregate));
      persist();
    }
    return envelope(request.id, invoiceView(aggregate), { simulation: true, idempotent: result.idempotent });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message, simulation: true }));
  }
});

app.get("/api/invoices/:id/events", async (request: any, reply: any) => {
  const aggregate = aggregates.get(request.params.id);
  if (!aggregate) return reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
  reply.hijack();
  const response = reply.raw;
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
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
  const quote = quotes.get(request.params.id);
  return quote ? envelope(request.id, quote, { simulation: true }) : reply.code(404).send(envelope(request.id, null, { error: "quote not found" }));
});

app.post("/api/invoices/:id/select-route", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  const aggregate = aggregates.get(request.params.id);
  const quote = quotes.get(request.params.id);
  if (!aggregate || !quote) return reply.code(404).send(envelope(request.id, null, { error: "invoice or quote not found" }));
  try {
    const decision = selectSettlementRoute(aggregate, quote, merchant);
    publishInvoiceEvent(aggregate.invoice.id, "route.selected", { aggregate: invoiceView(aggregate), decision });
    persist();
    return envelope(request.id, decision, { simulation: true });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message, simulation: true }));
  }
});

app.post("/api/invoices/:id/invalidate-best-route", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  const aggregate = aggregates.get(request.params.id);
  const quote = quotes.get(request.params.id);
  if (!aggregate || !quote) return reply.code(404).send(envelope(request.id, null, { error: "invoice or quote not found" }));
  if (["SETTLED", "REFUNDED", "SETTLEMENT_FAILED", "REFUND_REQUIRED"].includes(aggregate.lifecycle)) {
    return reply.code(409).send(envelope(request.id, null, { error: "Route changes are closed for this terminal invoice state", simulation: true }));
  }
  const routeId = aggregate.decision?.selectedRouteId ?? quote.routes[0]?.id;
  const route = quote.routes.find((candidate) => candidate.id === routeId);
  if (route) route.available = false;
  publishInvoiceEvent(aggregate.invoice.id, "route.invalidated", { routeId, available: false });
  persist();
  return envelope(request.id, { invalidated: routeId, available: false }, { simulation: true });
});

app.post("/api/invoices/:id/settle", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  const aggregate = aggregates.get(request.params.id);
  const quote = quotes.get(request.params.id);
  if (!aggregate || !quote) return reply.code(404).send(envelope(request.id, null, { error: "invoice or quote not found" }));
  try {
    let job = settlementJobs.get(aggregate.invoice.id);
    if (!job) {
      job = settleInvoice(aggregate, quote, merchant, async (route) => ({
        simulation: true,
        txid: `sim-${route.id}-${aggregate.invoice.id.slice(0, 8)}`,
      }));
      settlementJobs.set(aggregate.invoice.id, job);
      void job.then(() => settlementJobs.delete(aggregate.invoice.id), () => settlementJobs.delete(aggregate.invoice.id));
    }
    const result = await job;
    if (result.settlement.txid) transactions.set(result.settlement.txid, result.settlement);
    publishInvoiceEvent(aggregate.invoice.id, "invoice.settled", { settlement: result.settlement, aggregate: invoiceView(aggregate) });
    persist();
    return envelope(request.id, result.settlement, {
      simulation: true,
      idempotent: result.idempotent,
      fallbackHistory: aggregate.fallbackHistory,
    });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message, simulation: true }));
  }
});

app.post("/api/invoices/:id/refund", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  const aggregate = aggregates.get(request.params.id);
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
    reason: typeof request.body?.reason === "string" ? request.body.reason.slice(0, 200) : "Merchant requested refund",
    simulation: true,
    createdAt: new Date().toISOString(),
  };
  refunds.set(aggregate.invoice.id, refund);
  publishInvoiceEvent(aggregate.invoice.id, "refund.created", { aggregate: invoiceView(aggregate), refund });
  persist();
  return envelope(request.id, refund, { simulation: true, idempotent: false });
});

app.post("/api/payouts", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  const amountSats = parseSats(request.body?.amountSats);
  if (amountSats === null) return reply.code(400).send(envelope(request.id, null, { error: "amountSats must be a positive integer within the Bitcoin supply" }));
  const availableSats = liquidity.vtxoSats + liquidity.providerSats - liquidity.reservedSats;
  if (amountSats > availableSats) return reply.code(409).send(envelope(request.id, null, { error: "Insufficient sample routing capacity" }));
  const destination = typeof request.body?.destination === "string" ? request.body.destination.trim().slice(0, 200) : "";
  if (!destination) return reply.code(400).send(envelope(request.id, null, { error: "destination label is required; payouts are simulation records and do not broadcast" }));
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
  const aggregate = aggregates.get(request.params.id);
  return aggregate
    ? envelope(request.id, { settlement: aggregate.settlement ?? null, lifecycle: aggregate.lifecycle, decision: aggregate.decision, fallbackHistory: aggregate.fallbackHistory })
    : reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
});

app.get("/api/transactions/:txid", async (request: any, reply) => {
  const settlement = transactions.get(request.params.txid);
  return settlement
    ? envelope(request.id, settlement, { simulation: settlement.simulation })
    : reply.code(404).send(envelope(request.id, null, { error: "transaction not found" }));
});

app.get("/api/x402/resource", async (request: any, reply) => {
  const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";

  // L402-style live path: a real invoice was issued and the rail has credited it. The caller
  // presents the macaroon plus the preimage the node revealed; we verify the preimage hashes to
  // the invoice's payment hash rather than trusting the caller's claim.
  if (authorization.startsWith("L402 ")) {
    const parts = authorization.slice(5).trim().split(":");
    const macaroon = parts[0] ?? "";
    const preimage = parts[1] ?? "";
    const liveInvoiceId = liveMacaroons.get(macaroon);
    const paymentHash = liveInvoiceId ? correspondence.paymentHashFor(liveInvoiceId) : undefined;
    const payout = liveInvoiceId ? payouts.get(liveInvoiceId) : undefined;
    const matches = Boolean(
      preimage && paymentHash &&
        createHash("sha256").update(Buffer.from(preimage.toLowerCase(), "hex")).digest("hex") === paymentHash,
    );
    if (liveInvoiceId && payout && matches) {
      return envelope(request.id, {
        unlocked: true,
        protocol: "L402",
        invoiceId: liveInvoiceId,
        service: "SatsLoom live resource",
        data: { message: "Live content released against a verified Lightning preimage." },
      }, { simulation: false, proof: "preimage-sha256" });
    }
  }

  // A reachable Lightning node is configured: hand the agent a real BOLT11 invoice it can pay,
  // exactly like the /api/live/invoices rail.
  if (!railUnavailable()) {
    const amountSats = 50n;
    const expirySeconds = 900;
    const now = new Date();
    const invoiceId = crypto.randomUUID();
    const memo = "SatsLoom x402 challenge (50 sats)";
    const invoice: Invoice = {
      id: invoiceId,
      amountSats,
      memo,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expirySeconds * 1000).toISOString(),
    };
    let paymentRequest;
    try {
      paymentRequest = await activeRail.createRequest({
        amountMsat: amountSats * 1000n,
        description: memo,
        expirySeconds,
        onchainFallbackAddress: undefined,
      });
    } catch (error) {
      return reply.code(503).send(envelope(request.id, null, {
        error: `The lightning rail could not issue an x402 invoice: ${(error as Error).message}`,
        simulation: false,
      }));
    }
    const aggregate = markQuoted(createInvoiceAggregate(invoice));
    aggregate.purpose = "x402-live";
    aggregates.set(invoice.id, aggregate);
    paymentRequests.set(paymentRequest.paymentHash, paymentRequest);
    correspondence.link(paymentRequest.paymentHash, invoice.id);
    watcher.watch({ railRequestId: paymentRequest.paymentHash, expiresAt: paymentRequest.expiresAt, invoiceId: invoice.id });
    persist();
    reply.header("x-satsloom-payment-hash", paymentRequest.paymentHash);
    return reply
      .code(402)
      .header(
        "www-authenticate",
        `L402 macaroon="pay-to-obtain", invoice="${paymentRequest.invoice}", price="50", currency="SAT"`,
      )
      .header("x-402-invoice-id", invoice.id)
      .header("x-402-price-sats", "50")
      .header("x-402-payment-url", `/#live?invoice=${invoice.id}`)
      .send(envelope(request.id, {
        error: "Payment Required",
        status: 402,
        invoiceId,
        amountSats: "50",
        amountMsat: paymentRequest.amountMsat,
        memo,
        payment: {
          rail: paymentRequest.rail,
          network: paymentRequest.network,
          bolt11: paymentRequest.invoice,
          bip21: `bitcoin:?${new URLSearchParams({ lightning: paymentRequest.invoice }).toString()}`,
          paymentHash: paymentRequest.paymentHash,
        },
        message:
          "Pay this BOLT11 invoice over Lightning, then retry with Authorization: L402 <macaroon>:<preimage>. The resource unlocks only when the preimage hashes to this invoice's payment hash.",
      }, { simulation: false }));
  }

  if (!demoMode || !proofSecret) {
    return reply.code(503).send(envelope(request.id, null, { error: "Live x402 payment verification is not configured; the signed-receipt demo is unavailable" }));
  }
  const receipt = verifyDemoReceipt(authorization);
  if (receipt) {
    const aggregate = aggregates.get(receipt.invoiceId);
    if (aggregate?.purpose === "x402-demo" && aggregate.lifecycle === "SETTLED" &&
      aggregate.settlement?.status === "settled" && aggregate.settlement.simulation) {
      return envelope(request.id, {
        unlocked: true,
        protocol: "x402-demo",
        invoiceId: receipt.invoiceId,
        service: "SatsLoom sample resource",
        data: { message: "This is sample content returned after verifying a signed demo receipt." },
      }, { simulation: true, proof: "signed-demo-receipt-not-payment-proof" });
    }
  }

  const now = new Date();
  const invoice: Invoice = {
    id: crypto.randomUUID(),
    amountSats: 50n,
    memo: "x402 demo challenge (50 sats simulated)",
    status: "created",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  };
  const aggregate = markQuoted(createInvoiceAggregate(invoice));
  aggregate.purpose = "x402-demo";
  aggregates.set(invoice.id, aggregate);
  quotes.set(invoice.id, createDemoQuote(invoice));
  persist();
  return reply
    .code(402)
    .header("www-authenticate", `SatsLoom-Demo invoice="${invoice.id}", price="50", currency="SAT", simulation="true"`)
    .header("x-402-invoice-id", invoice.id)
    .header("x-402-price-sats", "50")
    .header("x-402-payment-url", `/#checkout/${invoice.id}`)
    .send(envelope(request.id, {
      error: "Payment Required (simulation)",
      status: 402,
      invoiceId: invoice.id,
      amountSats: "50",
      memo: invoice.memo,
      message: "This demo does not accept sats. POST /api/x402/agent-pay produces a signed simulation receipt, not proof of Bitcoin payment.",
    }, { simulation: true }));
});

app.post("/api/x402/agent-pay", async (request: any, reply) => {
  if (!requireDemoMode(request, reply)) return;
  if (!proofSecret) return reply.code(503).send(envelope(request.id, null, { error: "Configure SATSLOOM_PROOF_SECRET to issue signed demo receipts" }));
  const invoiceId = typeof request.body?.invoiceId === "string" ? request.body.invoiceId : "";
  const aggregate = aggregates.get(invoiceId);
  const quote = quotes.get(invoiceId);
  if (!aggregate || !quote || aggregate.purpose !== "x402-demo" || aggregate.invoice.amountSats !== 50n) {
    return reply.code(404).send(envelope(request.id, null, { error: "Valid x402 demo challenge not found" }));
  }
  if (aggregate.lifecycle === "SETTLED" && aggregate.settlement?.status === "settled" && aggregate.settlement.simulation) {
    const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
    return envelope(request.id, {
      invoiceId,
      status: "simulated",
      proofToken: signDemoReceipt(invoiceId, expiresAt),
      proofExpiresAt: expiresAt,
      settlement: aggregate.settlement,
    }, { simulation: true, idempotent: true });
  }
  try {
    let job = settlementJobs.get(invoiceId);
    let sharedInFlightJob = Boolean(job);
    if (!job) {
      confirmPayment(aggregate);
      selectSettlementRoute(aggregate, quote, merchant);
      job = settleInvoice(aggregate, quote, merchant, async (route) => ({
        simulation: true,
        txid: `demo-${route.id}-${invoiceId.slice(0, 8)}`,
      }));
      settlementJobs.set(invoiceId, job);
      void job.then(() => settlementJobs.delete(invoiceId), () => settlementJobs.delete(invoiceId));
      sharedInFlightJob = false;
    }
    const result = await job;
    if (result.settlement.status !== "settled") {
      return reply.code(409).send(envelope(request.id, result.settlement, { error: "Demo settlement did not complete", simulation: true }));
    }
    if (result.settlement.txid) transactions.set(result.settlement.txid, result.settlement);
    publishInvoiceEvent(invoiceId, "invoice.settled", { settlement: result.settlement, aggregate: invoiceView(aggregate) });
    persist();
    const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
    return envelope(request.id, {
      invoiceId,
      status: "simulated",
      proofToken: signDemoReceipt(invoiceId, expiresAt),
      proofExpiresAt: expiresAt,
      settlement: result.settlement,
    }, { simulation: true, idempotent: result.idempotent || sharedInFlightJob });
  } catch (error) {
    return reply.code(409).send(envelope(request.id, null, { error: (error as Error).message, simulation: true }));
  }
});

/* ------------------------------------------------------------------ live payments */
/**
 * The live payment surface.
 *
 * These routes exist so that a real BOLT11 invoice can be issued, watched, and credited, and
 * so that every claim they make is verifiable from the response alone: which rail, which
 * network, which mode, and (once a payment lands) the preimage that proves it.
 */
app.post("/api/live/invoices", async (request: any, reply) => {
  if (railUnavailable()) {
    return reply.code(503).send(envelope(request.id, null, {
      error: "A configured and reachable Lightning node is required for live invoices",
      railConfigError: railConfigError ?? null,
    }));
  }
  const amountSats = parseSats(request.body?.amountSats);
  if (amountSats === null) return reply.code(400).send(envelope(request.id, null, { error: "amountSats must be a positive integer within the Bitcoin supply" }));
  const memo = typeof request.body?.memo === "string" ? request.body.memo.trim().slice(0, 200) : "SatsLoom live invoice";
  const expirySeconds = Number.isInteger(request.body?.expirySeconds) && request.body.expirySeconds > 0 && request.body.expirySeconds <= 86_400
    ? request.body.expirySeconds
    : 600;
  const now = new Date();
  const invoice: Invoice = {
    id: crypto.randomUUID(),
    amountSats,
    memo,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expirySeconds * 1000).toISOString(),
  };
  let paymentRequest;
  try {
    paymentRequest = await activeRail.createRequest({
      amountMsat: amountSats * 1000n,
      description: memo,
      expirySeconds,
      onchainFallbackAddress: undefined,
    });
  } catch (error) {
    return reply.code(503).send(envelope(request.id, null, {
      error: `The lightning rail could not issue an invoice: ${(error as Error).message}`,
    }));
  }
  const aggregate = markQuoted(createInvoiceAggregate(invoice));
  aggregates.set(invoice.id, aggregate);
  paymentRequests.set(paymentRequest.paymentHash, paymentRequest);
  // Indexed hash -> invoice id so the credit path can resolve an observation (which arrives
  // keyed by payment hash) back to the invoice it belongs to. Keeping this lookup keyed the
  // same way as the credit path reads it is what makes credit reachable at all.
  correspondence.link(paymentRequest.paymentHash, invoice.id);
  // Watch immediately: the payer may settle before this response is even delivered.
  watcher.watch({ railRequestId: paymentRequest.paymentHash, expiresAt: paymentRequest.expiresAt, invoiceId: invoice.id });
  persist();
  reply.header("x-satsloom-payment-hash", paymentRequest.paymentHash);
  return envelope(request.id, {
    invoice,
    payment: {
      rail: paymentRequest.rail,
      network: paymentRequest.network,
      mode: paymentRequest.mode,
      bolt11: paymentRequest.invoice,
      /** BIP21 URI so a wallet can pay without script support. */
      bip21: `bitcoin:?${new URLSearchParams({ lightning: paymentRequest.invoice }).toString()}`,
      paymentHash: paymentRequest.paymentHash,
      amountMsat: paymentRequest.amountMsat,
      expiresAt: new Date(paymentRequest.expiresAt * 1000).toISOString(),
      description: paymentRequest.description,
    },
  }, { simulation: false, rail: railSummary() });
});

/** Observe the rail directly, independent of any client polling. */
app.get("/api/live/invoices/:id", async (request: any, reply) => {
  if (railUnavailable()) {
    return reply.code(503).send(envelope(request.id, null, { error: "No Lightning node is configured" }));
  }
  const aggregate = aggregates.get(request.params.id);
  if (!aggregate) return reply.code(404).send(envelope(request.id, null, { error: "invoice not found" }));
  const paymentHash = correspondence.paymentHashFor(request.params.id);
  const paymentRequest = paymentHash ? paymentRequests.get(paymentHash) : undefined;
  if (!paymentRequest) {
    return envelope(request.id, { invoice: aggregate.invoice, payment: null, settlement: aggregate.settlement ?? null });
  }
  let observation;
  try {
    observation = await activeRail.observe(paymentRequest.railRequestId);
  } catch (error) {
    return reply.code(503).send(envelope(request.id, null, { error: `Could not reach the node: ${(error as Error).message}` }));
  }
  // Crediting here as well as in the watcher is safe: the credit path is a single-claim
  // registry keyed on the preimage, so exactly one of the two paths records the payment.
  if (observation.state === "paid") await onRailObservation(observation);
  return envelope(request.id, {
    invoice: aggregate.invoice,
    payment: {
      bolt11: paymentRequest.invoice,
      paymentHash: paymentRequest.paymentHash,
      network: paymentRequest.network,
      mode: paymentRequest.mode,
      rail: paymentRequest.rail,
      amountMsat: paymentRequest.amountMsat,
      expiresAt: new Date(paymentRequest.expiresAt * 1000).toISOString(),
    },
    observation,
    // The credit path records the verified payout in `payouts`; the route-level settlement
    // read is the domain's own field. Reporting both means a client can see the settlement on
    // the invoice it paid without needing the payout id first.
    settlement: aggregate.settlement ?? (payouts.get(request.params.id)
      ? { ...payouts.get(request.params.id), status: "credited" }
      : null),
  }, { simulation: false, rail: railSummary() });
});

/** Live liquidity, straight from the node. */
app.get("/api/live/liquidity", async (request, reply) => {
  if (railUnavailable()) return reply.code(503).send(envelope(request.id, null, { error: "No Lightning node is configured" }));
  try {
    const liquidity = await activeRail.liquidity();
    return envelope(request.id, liquidity, { simulation: false, rail: railSummary() });
  } catch (error) {
    return reply.code(503).send(envelope(request.id, null, { error: `Could not read liquidity from the node: ${(error as Error).message}` }));
  }
});

// Vercel's Node runtime invokes a default-exported handler and never calls listen(), so the same
// app instance is also mounted as a request handler. `npm run dev` still uses the listener below
// and gets the watcher plus the local Lightning node.
type NodeHandler = (request: unknown, response: unknown) => Promise<void>;

const vercelHandler: NodeHandler = async (request, response) => {
  await app.ready();
  app.server.emit("request", request, response);
};

export default vercelHandler;

// A self-hosted run listens on a port and starts the watcher; Vercel invokes the default export
// above with a plain req/res and must not bind a port or start background timers.
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" }).then(() => {
    // Watching begins here rather than at import time, so a test suite can build the app
    // without starting background timers.
    watcher.start();
  }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
