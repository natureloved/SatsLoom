/**
 * Shared domain types for SatsLoom.
 *
 * `mode` is part of every API envelope and is deliberately explicit:
 *  - `live`     : the value came from a real Tachi daemon / Bitcoin network.
 *  - `degraded` : the daemon is unreachable or the operation is not supported. Nothing is faked.
 *  - `fixture`  : an in-process test/dev ledger is answering. Never presented as live.
 *
 * A merchant must be able to tell at a glance which of the three they are looking at, so
 * `mode` is never inferred in the browser — it always travels with the payload.
 */
export type Mode = "live" | "degraded" | "fixture";

export type SettlementPolicy = {
  maxFeeSats: bigint;
  maxSettlementSeconds: number;
  feeWeight: number;
  latencyWeight: number;
  exitRiskWeight: number;
  liquidityPenalty: number;
};

export type Merchant = { id: string; name: string; settlementPolicy: SettlementPolicy; payoutAddress?: string };

export type InvoiceStatus = "created" | "pending" | "confirmed" | "expired" | "refunded" | "failed";

/** Where an invoice expects to be paid: the merchant's own Tachi account key. */
export type PaymentTarget = {
  /** 32-byte x-only owner key of the merchant account (hex). VTXOs are credited to this key. */
  owner: string;
  /** Taproot (P2TR) form of the same account, for display and QR rendering. */
  address: string;
  /** P2TR address VTXOs are locked to. Same value as `address` for a ledger identity. */
  vaultAddress?: string;
  /**
   * The BIP-84 P2WPKH funding address for the same key. This is what a faucet or an exchange
   * sends to; `address` is where ledger payments land.
   */
  fundingAddress?: string;
  csvBlocks?: number;
};

export type Invoice = {
  id: string;
  amountSats: bigint;
  memo?: string;
  status: InvoiceStatus;
  createdAt: string;
  expiresAt: string;
  paymentTarget?: PaymentTarget;
  /** VTXO ids already present at the target when the invoice was created — the detection baseline. */
  baselineVtxoIds?: string[];
  /** Order reference supplied by the merchant's shop system, echoed back to webhooks. */
  orderId?: string;
};

/** Proof that an invoice was actually paid. Always carries an explorer link when one exists. */
export type PaymentProof = {
  invoiceId: string;
  txid: string;
  vtxoId?: string;
  amountSats: bigint;
  confirmations: number;
  explorerUrl: string;
  verifiedAt: string;
  mode: Mode;
};

export type LiquidityRoute = {
  id: string;
  source: "vtxo" | "liquidity_provider" | "onchain_redemption" | "simulation";
  /** Human-facing provider name, e.g. "Tachi ledger (self-custody)". */
  provider?: string;
  capacitySats: bigint;
  feeSats: bigint;
  estimatedSettlementSeconds: number;
  expiresAt: string;
  exitRisk: "none" | "low" | "medium" | "high";
  timelockBlocks?: number;
  available: boolean;
  requiresCooperativeSigning: boolean;
  simulation: boolean;
  /** Why a route is unavailable — surfaced in the UI rather than hidden. */
  unavailableReason?: string;
};

export type RouteQuote = { invoiceId: string; routes: LiquidityRoute[]; quotedAt: string; quoteExpiresAt: string };

export type RouteDecision = {
  invoiceId: string;
  selectedRouteId: string;
  scoringInputs: {
    feeSats: bigint;
    settlementSeconds: number;
    exitRiskWeight: number;
    liquidityAvailable: bigint;
    expirySecondsRemaining: number;
  };
  reason: string;
  decidedAt: string;
};

export type SettlementStatus = "not_started" | "pending" | "settled" | "fallback" | "failed" | "refund_required";

export type Settlement = {
  id: string;
  invoiceId: string;
  routeId: string;
  status: SettlementStatus;
  txid?: string;
  vtxoId?: string;
  explorerUrl?: string;
  error?: string;
  simulation: boolean;
  mode: Mode;
  /** Set when the router had to re-select because the preferred route died. */
  fallbackFrom?: string;
  decidedAt?: string;
};

export type Refund = {
  id: string;
  invoiceId: string;
  toAddress: string;
  amountSats: bigint;
  reason: string;
  status: "pending" | "settled" | "failed";
  txid?: string;
  explorerUrl?: string;
  error?: string;
  createdAt: string;
  mode: Mode;
};

export type Payout = {
  id: string;
  toAddress: string;
  amountSats: bigint;
  status: "pending" | "settled" | "failed";
  txid?: string;
  explorerUrl?: string;
  error?: string;
  createdAt: string;
  mode: Mode;
  kind: "onchain_redemption" | "offchain_transfer";
};

export type DaemonStatus = {
  reachable: boolean;
  network?: string;
  version?: string;
  mode: Mode;
  /** Server time of the daemon when it reported, if known. */
  checkedAt?: string;
  detail?: string;
};

export type Validator = { id: string; endpoint?: string; online: boolean };

export type VaultSummary = { id: string; address: string; cooperativeLeaf?: unknown; exitLeaf?: unknown; csvDelay: number };

export type VerificationResult = { valid: boolean; details?: string };

export type Vtxo = {
  vtxoId: string;
  address?: string;
  owner: string;
  amountSats: bigint;
  state: "pending" | "committed" | "spent";
  txid?: string;
  vout?: number;
  /** Epoch (Tachi block height) the VTXO committed in. */
  epoch?: number;
  timelockBlocks?: number;
};

/** A settlement source advertised in the liquidity directory. */
export type LiquidityProvider = {
  id: string;
  name: string;
  kind: "self_custody" | "liquidity_provider" | "onchain_redemption";
  capacitySats: bigint;
  feeSats: bigint;
  feeBps: number;
  latencySeconds: number;
  exitRisk: LiquidityRoute["exitRisk"];
  available: boolean;
  requiresCooperativeSigning: boolean;
  timelockBlocks?: number;
  status: "live" | "degraded" | "unavailable";
  lastCheckedAt: string;
  detail?: string;
};

export type WebhookEvent = "invoice.created" | "invoice.pending" | "invoice.confirmed" | "invoice.expired" | "payout.settled" | "refund.settled";

export type WebhookRegistration = {
  id: string;
  url: string;
  events: WebhookEvent[];
  /** Never returned in full by the API — only a fingerprint. */
  secretFingerprint: string;
  createdAt: string;
};

export type WebhookDelivery = {
  id: string;
  registrationId: string;
  url: string;
  event: WebhookEvent;
  payload: unknown;
  status: "delivered" | "failed" | "retrying";
  attempts: number;
  maxAttempts: number;
  signature: string;
  /** Exactly the bytes that were signed and POSTed, so a merchant can reproduce the HMAC. */
  body?: string;
  responseCode?: number;
  responseBody?: string;
  error?: string;
  createdAt: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
};

export type DashboardSummary = {
  mode: Mode;
  counts: Record<InvoiceStatus, number>;
  totals: { invoicedSats: bigint; confirmedSats: bigint; refundedSats: bigint; paidOutSats: bigint };
  balance: { offchainSats: bigint; onchainSats: bigint; pendingSats: bigint; note?: string };
  recentActivity: ActivityEvent[];
};

export type ActivityEvent = {
  id: string;
  at: string;
  kind:
    | "invoice.created"
    | "payment.detected"
  /** A ledger output that was already credited elsewhere; refusing to count it twice. */
  | "payment.duplicate"
    | "invoice.confirmed"
    | "invoice.expired"
    | "settlement.settled"
    | "settlement.fallback"
    | "refund.settled"
    | "payout.settled"
    | "route.invalidated"
    | "daemon.status";
  message: string;
  invoiceId?: string;
  txid?: string;
  explorerUrl?: string;
  mode: Mode;
};

/** One entry of the Day-1 gate: is this Tachi capability actually working right now? */
export type Capability = {
  id: string;
  label: string;
  ok: boolean;
  /** `live` when proven against the daemon, `fixture` for the in-process ledger, `degraded` otherwise. */
  mode: Mode;
  detail?: string;
  /** What to do when `ok` is false. */
  remediation?: string;
};

export type CapabilityReport = {
  mode: Mode;
  daemon: { baseUrl: string; reachable: boolean };
  capabilities: Capability[];
  checkedAt: string;
};

export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

export { loadDotEnv, parseEnvFile, providerFromEnv } from "./env.js";

export {
  BLOCK_SECONDS,
  blocksToSeconds,
  countdown,
  describeTimelock,
  exitRiskExplanation,
  formatSats,
  friendlyDuration,
  groupDigits,
  satsToBtcString,
  timeAgo,
  type TimelockView,
} from "./format.js";
