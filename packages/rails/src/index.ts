/**
 * Payment rails.
 *
 * SatsLoom's problem today is that its settlement is a `async (route) => ({ simulation: true })`
 * closure inside the API, so "which network, which custodian, is this real?" is answered by a
 * string in a response envelope. A rail is the opposite: one object that owns value movement for
 * one network, reports its own capabilities, and cannot lie about being live.
 *
 * The honesty rule is structural, not editorial:
 *   - `RailDescriptor.live` is true only when the backend can move real value on a real network;
 *   - `mode` is derived from the backend, never passed in by a caller;
 *   - `verifyPayment()` is a pure function so credit decisions are testable without a node;
 *   - an invoice returned by a node is decoded and checked before it is ever shown to a customer
 *     (`assertInvoiceMatchesRequest`), because a node that returns a mismatched invoice must be a
 *     loud failure, not a silent mis-credit.
 */
import {
  Bolt11Error,
  decodeInvoice,
  isExpired,
  verifyPreimage,
  type Bolt11Network,
  type DecodedInvoice,
} from "@satsloom/bolt11";

export type RailKind = "lightning" | "onchain" | "ark" | "tachi";
export type RailNetwork = "regtest" | "signet" | "testnet" | "mainnet";
/** What the rail is: an in-process stand-in, a test network, or money. */
export type RailMode = "fixture" | "testnet" | "mainnet";

export type RailCapabilities = {
  /** Can produce a payable artifact (BOLT11 invoice, address, ...). */
  issue: boolean;
  /** Can observe and verify an incoming payment. */
  detect: boolean;
  /** Can send value back to the payer. */
  refund: boolean;
  /** Can send value to an arbitrary destination (merchant payout). */
  payout: boolean;
  /** Reports capacity/headroom. */
  liquidity: boolean;
};

export type RailDescriptor = {
  id: string;
  kind: RailKind;
  network: RailNetwork;
  mode: RailMode;
  /** True only if this rail can move real value on a real network. */
  live: boolean;
  /** True only if this rail has been exercised against its real counterpart and a receipt exists. */
  verified: boolean;
  custody: "self" | "third_party";
  capabilities: RailCapabilities;
  /** Human-readable, shown in the UI verbatim. Never claim more than the fields above. */
  note: string;
};

export type RailHealth = {
  reachable: boolean;
  synced?: boolean;
  blockHeight?: number;
  nodePubkey?: string;
  version?: string;
  detail?: string;
};

export type RailLiquidity = {
  /** Sats that can be received right now (inbound headroom). */
  inboundSats: bigint;
  /** Sats that can be sent right now (outbound/local balance). */
  outboundSats: bigint;
  onchainSats?: bigint;
  detail?: string;
};

export type CreateRequestInput = {
  amountMsat: bigint;
  description: string;
  /** Invoice lifetime in seconds. Callers should keep this well under the quote/route expiry. */
  expirySeconds: number;
  /** Optional on-chain fallback (BIP21) for wallets that cannot pay Lightning. */
  onchainFallbackAddress?: string;
};

export type PaymentRequest = {
  rail: string;
  /** The rail's own identifier for this request: the payment hash for Lightning. */
  railRequestId: string;
  paymentHash: string;
  amountMsat: bigint;
  /** The payable artifact. For Lightning this is a real BOLT11 string. */
  invoice: string;
  network: RailNetwork;
  mode: RailMode;
  createdAt: number;
  expiresAt: number;
  description: string;
  /** BIP21 URI when a fallback address is configured. */
  onchainUri?: string;
  /** What the node/backend actually committed to, decoded independently of the backend. */
  decoded: DecodedInvoice;
};

export type PaymentState = "pending" | "paid" | "expired" | "cancelled" | "unknown";

export type PaymentObservation = {
  railRequestId: string;
  paymentHash: string;
  state: PaymentState;
  /** Amount the payer actually sent, when the rail reports it. */
  paidMsat?: bigint;
  settledAt?: number;
  /** Lightning proof of payment. Its SHA256 must equal the committed payment hash. */
  preimage?: string;
};

export type CreditPolicy = {
  /** Accept a payment larger than the request (the surplus is kept, not refunded). */
  allowOverpayment: boolean;
  /** Accept a payment smaller than the request and credit the partial amount. */
  allowPartial: boolean;
  /** Extra time after `expiresAt` during which a late-but-real settlement is still credited. */
  lateSettlementGraceSeconds: number;
};

export const DEFAULT_CREDIT_POLICY: CreditPolicy = {
  allowOverpayment: true,
  allowPartial: false,
  lateSettlementGraceSeconds: 0,
};

export type CreditRefusalReason =
  | "not_paid"
  | "cancelled"
  | "unknown_state"
  | "payment_hash_mismatch"
  | "missing_preimage"
  | "invalid_preimage"
  | "underpaid"
  | "expired"
  | "duplicate";

export type PaymentVerdict =
  | {
      credited: true;
      amountMsat: bigint;
      surplusMsat: bigint;
      preimage: string;
      settledAt: number;
    }
  | {
      credited: false;
      reason: CreditRefusalReason;
      detail: string;
      /** Amount the rail reported, when it reported one, so operators can see what happened. */
      paidMsat?: bigint;
    };

export class RailError extends Error {
  readonly code: string;
  /** Structured, non-secret context: HTTP status, backend name, retryability. */
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super(message, { cause: options?.cause });
    this.name = "RailError";
    this.code = code;
    this.details = options?.details ?? {};
  }
}

export class InvoiceVerificationError extends RailError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("invoice_verification_failed", message, options);
    this.name = "InvoiceVerificationError";
  }
}

export class RailUnavailableError extends RailError {
  constructor(message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super("rail_unavailable", message, options);
    this.name = "RailUnavailableError";
  }

  /** HTTP status from the node, when the failure came from one. Lets callers distinguish 404 from an outage. */
  get status(): number | undefined {
    const value = this.details.status;
    return typeof value === "number" ? value : undefined;
  }
}

/* ------------------------------------------------------------------ backend */

export type BackendInvoice = {
  paymentHash: string;
  bolt11: string;
  expiresAt: number;
  /** Present in the fixture backend; real nodes do not reveal the preimage before settlement. */
  preimage?: string;
};

export type BackendInvoiceStatus = {
  state: PaymentState;
  paidMsat?: bigint;
  settledAt?: number;
  preimage?: string;
};

export interface LightningNodeBackend {
  readonly kind: string;
  readonly network: RailNetwork;
  /** True only for a backend that talks to real value movement. */
  isLive(): boolean;
  getInfo(): Promise<RailHealth>;
  /**
   * Ask the node to issue an invoice. The node generates the preimage and therefore the payment
   * hash (that is how every real Lightning node behaves, and LND's AddInvoice is no exception),
   * so the rail derives its commitment from what the node returns and then verifies it.
   */
  createInvoice(input: {
    amountMsat: bigint;
    description: string;
    expirySeconds: number;
  }): Promise<BackendInvoice>;
  lookupInvoice(paymentHash: string): Promise<BackendInvoiceStatus>;
  payInvoice(bolt11: string, maxFeeMsat?: bigint): Promise<{ paymentHash: string; preimage: string; paidMsat: bigint }>;
  liquidity(): Promise<RailLiquidity>;
}

export interface PaymentRail {
  describe(): RailDescriptor;
  health(): Promise<RailHealth>;
  createRequest(input: CreateRequestInput): Promise<PaymentRequest>;
  /** Read the current state of a request from the rail. Never credits anything by itself. */
  observe(railRequestId: string): Promise<PaymentObservation>;
  pay(bolt11: string, maxFeeMsat?: bigint): Promise<{ paymentHash: string; preimage: string; paidMsat: bigint; rail: string }>;
  liquidity(): Promise<RailLiquidity>;
}

/* ------------------------------------------------------------------ verification */

/**
 * The credit decision, as a pure function.
 *
 * This is the code that decides whether goods ship, so it is deliberately boring: every
 * refusal has a named reason, and the proof (preimage hashing to the committed payment hash)
 * is checked here rather than trusted from the rail's `state` field. A rail that says "paid"
 * without a valid preimage is a bug or an attack, and both must fail closed.
 */
export function verifyPayment(
  request: PaymentRequest,
  observation: PaymentObservation,
  policy: CreditPolicy = DEFAULT_CREDIT_POLICY,
  nowSeconds = Math.floor(Date.now() / 1000),
): PaymentVerdict {
  if (observation.paymentHash !== request.paymentHash || observation.railRequestId !== request.railRequestId) {
    return {
      credited: false,
      reason: "payment_hash_mismatch",
      detail: "Observation does not belong to this payment request",
      paidMsat: observation.paidMsat,
    };
  }
  if (observation.state === "cancelled") return { credited: false, reason: "cancelled", detail: "Invoice was cancelled" };
  if (observation.state === "expired") return { credited: false, reason: "expired", detail: "Invoice expired before payment" };
  if (observation.state === "unknown") return { credited: false, reason: "unknown_state", detail: "Rail could not determine invoice state" };
  if (observation.state !== "paid") {
    return { credited: false, reason: "not_paid", detail: `Invoice is ${observation.state}`, paidMsat: observation.paidMsat };
  }

  const paidMsat = observation.paidMsat ?? 0n;
  if (!observation.preimage) {
    return { credited: false, reason: "missing_preimage", detail: "Rail reported payment without revealing a preimage", paidMsat };
  }
  if (!verifyPreimage(observation.preimage, request.paymentHash)) {
    return {
      credited: false,
      reason: "invalid_preimage",
      detail: "Revealed preimage does not hash to the invoice's payment hash",
      paidMsat,
    };
  }
  const settledAt = observation.settledAt ?? nowSeconds;
  if (settledAt > request.expiresAt + policy.lateSettlementGraceSeconds) {
    return {
      credited: false,
      reason: "expired",
      detail: `Settlement at ${settledAt} is after invoice expiry ${request.expiresAt} plus a ${policy.lateSettlementGraceSeconds}s grace`,
      paidMsat,
    };
  }
  if (paidMsat < request.amountMsat) {
    if (!policy.allowPartial) {
      return { credited: false, reason: "underpaid", detail: `Received ${paidMsat} of ${request.amountMsat} msat`, paidMsat };
    }
    if (paidMsat <= 0n) {
      return { credited: false, reason: "underpaid", detail: "Received zero", paidMsat };
    }
    return { credited: true, amountMsat: paidMsat, surplusMsat: 0n, preimage: observation.preimage, settledAt };
  }
  const surplusMsat = paidMsat - request.amountMsat;
  if (!policy.allowOverpayment && surplusMsat > 0n) {
    return {
      credited: false,
      reason: "underpaid",
      detail: `Overpayment of ${surplusMsat} msat is not accepted under this policy; refund the difference`,
      paidMsat,
    };
  }
  return { credited: true, amountMsat: paidMsat, surplusMsat, preimage: observation.preimage, settledAt };
}

/**
 * Process-local guard against crediting the same payment twice.
 *
 * This is NOT the durable idempotency the live product needs — that is a unique constraint on
 * `(rail, preimage)` in the ledger (see docs/live-product-plan.md §W4). It exists so the
 * verification logic is complete and testable today, and so a single process cannot double-credit
 * while the database work is still pending.
 */
export class CreditRegistry {
  private readonly credited = new Set<string>();

  key(rail: string, preimage: string): string {
    return `${rail}:${preimage.toLowerCase()}`;
  }

  has(rail: string, preimage: string): boolean {
    return this.credited.has(this.key(rail, preimage));
  }

  record(rail: string, preimage: string): void {
    this.credited.add(this.key(rail, preimage));
  }

  /** Credit exactly once. Returns false when this payment was already credited. */
  claim(rail: string, preimage: string): boolean {
    const key = this.key(rail, preimage);
    if (this.credited.has(key)) return false;
    this.credited.add(key);
    return true;
  }
}

/* ------------------------------------------------------------------ rail */

const MODE_BY_NETWORK: Record<RailNetwork, RailMode> = {
  mainnet: "mainnet",
  testnet: "testnet",
  signet: "testnet",
  regtest: "testnet",
};

/**
 * Verify that a BOLT11 invoice a node returned is the invoice we asked for, before exposing it.
 *
 * Checks, in order: decodable (checksum + signature), correct network, amount exactly as
 * requested, payment hash exactly as requested, and not already expired. A node (or a
 * misconfigured proxy, or a hostile middlebox) returning a *different* invoice is one of the
 * few ways a customer could pay an attacker instead of the merchant, so this fails closed.
 */
export function assertInvoiceMatchesRequest(
  invoice: string,
  expected: { network: Bolt11Network; amountMsat: bigint; paymentHash: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): DecodedInvoice {
  let decoded: DecodedInvoice;
  try {
    decoded = decodeInvoice(invoice, { verifySignature: true });
  } catch (error) {
    if (error instanceof Bolt11Error) throw new InvoiceVerificationError(`Node returned an undecodable invoice: ${error.message}`, { cause: error });
    throw error;
  }
  if (decoded.network !== expected.network) {
    throw new InvoiceVerificationError(`Node returned a ${decoded.network} invoice, expected ${expected.network}`);
  }
  if (decoded.amountMsat === null) throw new InvoiceVerificationError("Node returned an amountless invoice");
  if (decoded.amountMsat !== expected.amountMsat) {
    throw new InvoiceVerificationError(`Node returned an invoice for ${decoded.amountMsat} msat, expected ${expected.amountMsat} msat`);
  }
  if (decoded.paymentHash !== expected.paymentHash.toLowerCase()) {
    throw new InvoiceVerificationError("Node returned an invoice whose payment hash does not match the one requested");
  }
  if (isExpired(decoded, nowSeconds)) throw new InvoiceVerificationError("Node returned an already-expired invoice");
  return decoded;
}

export type LightningRailOptions = {
  backend: LightningNodeBackend;
  id?: string;
  /** Set true only after the rail has been exercised against the real counterpart and receipted. */
  verified?: boolean;
  creditPolicy?: CreditPolicy;
};

/**
 * The Lightning rail: a thin, opinionated layer over a node backend.
 *
 * It owns exactly three things the backend must not decide: how a request is described to
 * customers (with the invoice independently verified), how observations are normalized, and
 * that nothing is credited without a preimage that hashes to the committed payment hash.
 */
export class LightningRail implements PaymentRail {
  private readonly backend: LightningNodeBackend;
  private readonly id: string;
  private readonly verified: boolean;
  private readonly creditPolicy: CreditPolicy;
  readonly registry = new CreditRegistry();

  constructor(options: LightningRailOptions) {
    this.backend = options.backend;
    this.id = options.id ?? `lightning-${options.backend.network}`;
    this.verified = options.verified ?? false;
    this.creditPolicy = options.creditPolicy ?? DEFAULT_CREDIT_POLICY;
  }

  describe(): RailDescriptor {
    const live = this.backend.isLive();
    return {
      id: this.id,
      kind: "lightning",
      network: this.backend.network,
      mode: this.backend.kind === "fixture" ? "fixture" : MODE_BY_NETWORK[this.backend.network],
      live,
      verified: this.verified,
      custody: "self",
      capabilities: { issue: true, detect: true, refund: true, payout: true, liquidity: true },
      note: this.backend.kind === "fixture"
        ? "In-process test node. Invoices are real BOLT11 and cryptographically verified, but no network or value is involved."
        : live
          ? `Connected to a Lightning node on ${this.backend.network}. Payments are real.`
          : `Connected to a ${this.backend.network} node. Payments use test coins and have no value.`,
    };
  }

  async health(): Promise<RailHealth> {
    try {
      return await this.backend.getInfo();
    } catch (error) {
      return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async createRequest(input: CreateRequestInput): Promise<PaymentRequest> {
    if (input.amountMsat <= 0n) throw new RailError("invalid_amount", "amountMsat must be positive");
    if (!Number.isInteger(input.expirySeconds) || input.expirySeconds <= 0) {
      throw new RailError("invalid_expiry", "expirySeconds must be a positive integer");
    }
    const created = await this.backend.createInvoice({
      amountMsat: input.amountMsat,
      description: input.description,
      expirySeconds: input.expirySeconds,
    });
    const paymentHash = created.paymentHash.toLowerCase();
    // Independent of the backend: decode the invoice and check it commits to the hash, amount,
    // network and expiry we believe it does before a customer ever sees it.
    const decoded = assertInvoiceMatchesRequest(
      created.bolt11,
      { network: this.backend.network as Bolt11Network, amountMsat: input.amountMsat, paymentHash },
    );
    return {
      rail: this.id,
      railRequestId: paymentHash,
      paymentHash,
      amountMsat: input.amountMsat,
      invoice: created.bolt11,
      network: this.backend.network,
      mode: this.describe().mode,
      createdAt: decoded.timestamp,
      expiresAt: created.expiresAt || decoded.expiresAt,
      description: input.description,
      onchainUri: input.onchainFallbackAddress ? `bitcoin:${input.onchainFallbackAddress}` : undefined,
      decoded,
    };
  }

  async observe(railRequestId: string): Promise<PaymentObservation> {
    const status = await this.backend.lookupInvoice(railRequestId);
    return {
      railRequestId,
      paymentHash: railRequestId,
      state: status.state,
      paidMsat: status.paidMsat,
      settledAt: status.settledAt,
      preimage: status.preimage,
    };
  }

  /**
   * Read the rail, verify the observation against the caller's persisted request, and claim the
   * settlement exactly once. The request is passed in rather than looked up here because
   * durable state belongs to the ledger, not to a rail instance.
   */
  async credit(
    request: PaymentRequest,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<PaymentVerdict & { observation: PaymentObservation }> {
    const observation = await this.observe(request.railRequestId);
    const verdict = verifyPayment(request, observation, this.creditPolicy, nowSeconds);
    if (verdict.credited && !this.registry.claim(this.id, verdict.preimage)) {
      return {
        credited: false,
        reason: "duplicate",
        detail: "This settlement was already credited",
        paidMsat: observation.paidMsat,
        observation,
      };
    }
    return { ...verdict, observation };
  }

  async liquidity(): Promise<RailLiquidity> {
    return this.backend.liquidity();
  }

  async pay(bolt11: string, maxFeeMsat?: bigint): Promise<{ paymentHash: string; preimage: string; paidMsat: bigint; rail: string }> {
    const result = await this.backend.payInvoice(bolt11, maxFeeMsat);
    return { ...result, rail: this.id };
  }
}

export { decodeInvoice, verifyPreimage } from "@satsloom/bolt11";
export { FixtureLightningBackend } from "./fixture.js";
export { LndRestBackend, type LndRestBackendOptions } from "./lnd-rest.js";
export { buildLightningRailFromEnv, type RailSource, type ResolvedRail } from "./config.js";
export { InvoiceWatcher, type WatchTarget, type WatcherOptions } from "./watcher.js";
export { PaymentCorrespondence } from "./correspondence.js";
