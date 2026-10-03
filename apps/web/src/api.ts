/**
 * API client.
 *
 * No hardcoded localhost: the base URL comes from `VITE_API_URL` and defaults to a same-origin
 * `/api` prefix, which is what the Docker Compose nginx proxy and the Vercel rewrite both use.
 * That default is also why the browser never talks to the Tachi daemon directly — it cannot; the
 * daemon has no CORS headers for browsers and holds the quorum keys.
 */
const RAW_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
export const API_BASE = RAW_BASE.replace(/\/$/, "");

export type Envelope<T> = {
  requestId?: string;
  mode: "live" | "degraded" | "fixture";
  daemon?: { reachable: boolean; network?: string; version?: string; detail?: string; checkedAt?: string };
  capabilities?: unknown;
  error?: { code: string; message: string; details?: unknown };
  data: T;
  [key: string]: unknown;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new ApiError(`Request failed with HTTP ${response.status}`, "http_error", response.status);
  }
  if (!response.ok || payload.error) {
    throw new ApiError(payload.error?.message ?? `HTTP ${response.status}`, payload.error?.code ?? "error", response.status, payload.error?.details);
  }
  return payload;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}), headers }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};

/* ---------------- domain types as the API serializes them (bigints as strings) ---------------- */

export type Sats = string;

export type InvoiceView = {
  id: string;
  amountSats: Sats;
  memo?: string;
  status: "created" | "pending" | "confirmed" | "expired" | "refunded" | "failed";
  createdAt: string;
  expiresAt: string;
  orderId?: string;
  paymentTarget?: { owner: string; address: string; vaultAddress?: string; fundingAddress?: string; csvBlocks?: number };
  proof?: { txid: string; vtxoId?: string; amountSats: Sats; confirmations: number; explorerUrl: string; verifiedAt: string; mode: string } | null;
  explorerUrl?: string;
  paidFromOwner?: string;
};

export type RouteView = {
  id: string;
  source: string;
  provider?: string;
  capacitySats: Sats;
  feeSats: Sats;
  estimatedSettlementSeconds: number;
  exitRisk: "none" | "low" | "medium" | "high";
  timelockBlocks?: number;
  available: boolean;
  requiresCooperativeSigning: boolean;
  simulation: boolean;
  unavailableReason?: string;
};

export type Evaluation = {
  route: RouteView;
  score: number | null;
  rank: number | null;
  eligible: boolean;
  reason?: string;
  explanation: string;
  timelock: { friendly: string; advanced: string };
  feeBps: number;
};

export type SettlementView = {
  id: string;
  routeId: string;
  status: string;
  txid?: string;
  explorerUrl?: string;
  simulation: boolean;
  mode: string;
  fallbackFrom?: string;
  error?: string;
};

export type ActivityView = {
  id: string;
  at: string;
  kind: string;
  message: string;
  invoiceId?: string;
  txid?: string;
  explorerUrl?: string;
  mode: string;
};

export type SummaryView = {
  mode: "live" | "degraded" | "fixture";
  counts: Record<string, number>;
  totals: { invoicedSats: Sats; confirmedSats: Sats; refundedSats: Sats; paidOutSats: Sats };
  balance: { offchainSats: Sats; onchainSats: Sats | null; pendingSats: Sats; note?: string };
  payoutAddress: string | null;
  recentActivity: ActivityView[];
};

export type ProviderView = {
  id: string;
  name: string;
  kind: string;
  capacitySats: Sats;
  feeSats: Sats;
  feeBps: number;
  latencySeconds: number;
  exitRisk: "none" | "low" | "medium" | "high";
  available: boolean;
  requiresCooperativeSigning: boolean;
  timelockBlocks?: number;
  status: "live" | "degraded" | "unavailable";
  lastCheckedAt: string;
  detail?: string;
  timelock: { friendly: string; advanced: string };
};

export type DeliveryView = {
  id: string;
  url: string;
  event: string;
  status: "delivered" | "failed" | "retrying";
  attempts: number;
  maxAttempts: number;
  signature: string;
  body?: string;
  responseCode?: number;
  error?: string;
  createdAt: string;
  nextAttemptAt?: string;
};

export type CapabilityView = { id: string; label: string; ok: boolean; mode: string; detail?: string; remediation?: string };

export type PolicyView = {
  maxFeeSats: Sats;
  maxSettlementSeconds: number;
  feeWeight: number;
  latencyWeight: number;
  exitRiskWeight: number;
  liquidityPenalty: number;
};
