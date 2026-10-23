/**
 * A Lightning node that is not a network.
 *
 * It behaves like a node in the one respect that matters for building the merchant loop: it
 * generates a preimage, commits to its SHA256 as the invoice's payment hash, signs a real BOLT11
 * invoice with a real key, and only reveals the preimage when the payment settles. Every
 * cryptographic check in the credit path therefore runs for real, and a test that credits a
 * payment is exercising the same code that would run in production.
 *
 * What it is not: a network, a channel, or value. `isLive()` returns false, the descriptor mode
 * is "fixture", and it defaults to `regtest` so that even if a customer scanned the QR code, no
 * real wallet would send real money. The honest label is structural — there is no code path in
 * this class that can report itself as live.
 */
import { createECDH, createHash, randomBytes } from "node:crypto";
import { DEFAULT_FEATURES, decodeInvoice, encodeInvoice, type Bolt11Network } from "@satsloom/bolt11";
import {
  RailError,
  type BackendInvoice,
  type BackendInvoiceStatus,
  type LightningNodeBackend,
  type RailHealth,
  type RailLiquidity,
  type RailNetwork,
} from "./index.js";

/**
 * A published, deliberately-worthless key. It exists so fixture invoices are reproducible in
 * tests; it must never be used for anything holding value, and it is not configurable to a
 * "real" key by accident because this backend cannot move value on any network at all.
 */
const FIXTURE_PRIVATE_KEY = "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734";

export type FixtureLightningBackendOptions = {
  /** Defaults to regtest: no real wallet will pay an `lnbcrt` invoice. */
  network?: RailNetwork;
  /** 32-byte hex. Defaults to the published fixture key. */
  privateKey?: string;
  inboundSats?: bigint;
  outboundSats?: bigint;
  onchainSats?: bigint;
};

type FixtureInvoice = {
  paymentHash: string;
  preimage: string;
  bolt11: string;
  createdAt: number;
  expiresAt: number;
  amountMsat: bigint;
  state: BackendInvoiceStatus["state"];
  paidMsat?: bigint;
  settledAt?: number;
};

export class FixtureLightningBackend implements LightningNodeBackend {
  readonly kind = "fixture";
  readonly network: RailNetwork;
  private readonly privateKey: string;
  private readonly inboundSats: bigint;
  private outboundSats: bigint;
  private readonly onchainSats: bigint;
  private readonly invoices = new Map<string, FixtureInvoice>();

  constructor(options: FixtureLightningBackendOptions = {}) {
    this.network = options.network ?? "regtest";
    this.privateKey = options.privateKey ?? FIXTURE_PRIVATE_KEY;
    this.inboundSats = options.inboundSats ?? 250_000n;
    this.outboundSats = options.outboundSats ?? 100_000n;
    this.onchainSats = options.onchainSats ?? 1_000_000n;
  }

  isLive(): boolean {
    return false;
  }

  async getInfo(): Promise<RailHealth> {
    return {
      reachable: true,
      synced: true,
      blockHeight: 0,
      nodePubkey: this.nodePubkey(),
      version: "fixture/0.1.0",
      detail: "In-process fixture node. No network, no channels, no value.",
    };
  }

  async createInvoice(input: { amountMsat: bigint; description: string; expirySeconds: number }): Promise<BackendInvoice> {
    const preimage = randomBytes(32).toString("hex");
    const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + input.expirySeconds;
    const bolt11 = encodeInvoice({
      network: this.bolt11Network(),
      amountMsat: input.amountMsat,
      paymentHash,
      paymentSecret: randomBytes(32).toString("hex"),
      description: input.description,
      payeePrivateKey: this.privateKey,
      timestamp: createdAt,
      expirySeconds: input.expirySeconds,
      features: DEFAULT_FEATURES,
    }).invoice;
    this.invoices.set(paymentHash, {
      paymentHash,
      preimage,
      bolt11,
      createdAt,
      expiresAt,
      amountMsat: input.amountMsat,
      state: "pending",
    });
    return { paymentHash, bolt11, expiresAt };
  }

  async lookupInvoice(paymentHash: string): Promise<BackendInvoiceStatus> {
    const invoice = this.invoices.get(paymentHash.toLowerCase());
    if (!invoice) return { state: "unknown" };
    if (invoice.state === "paid") {
      // A real node only reveals the preimage once the HTLC is settled; the fixture does the same.
      return { state: "paid", paidMsat: invoice.paidMsat, settledAt: invoice.settledAt, preimage: invoice.preimage };
    }
    if (invoice.state === "pending" && Math.floor(Date.now() / 1000) > invoice.expiresAt) {
      return { state: "expired" };
    }
    return { state: invoice.state, paidMsat: invoice.paidMsat };
  }

  async payInvoice(bolt11: string, _maxFeeMsat?: bigint): Promise<{ paymentHash: string; preimage: string; paidMsat: bigint }> {
    const decoded = decodeInvoice(bolt11);
    const amountMsat = decoded.amountMsat ?? 10_000_000n;
    if (amountMsat > this.outboundSats * 1000n) {
      throw new RailError("insufficient_balance", `Fixture outbound capacity (${this.outboundSats} sats) insufficient for ${amountMsat / 1000n} sats`);
    }
    const existing = this.invoices.get(decoded.paymentHash.toLowerCase());
    let preimage: string;
    if (existing?.preimage) {
      preimage = existing.preimage;
      existing.state = "paid";
      existing.paidMsat = amountMsat;
      existing.settledAt = Math.floor(Date.now() / 1000);
    } else {
      preimage = createHash("sha256").update(`fixture-paid:${decoded.paymentHash}`).digest("hex");
    }
    this.outboundSats = this.outboundSats - (amountMsat / 1000n);
    return { paymentHash: decoded.paymentHash, preimage, paidMsat: amountMsat };
  }

  async liquidity(): Promise<RailLiquidity> {
    return {
      inboundSats: this.inboundSats,
      outboundSats: this.outboundSats,
      onchainSats: this.onchainSats,
      detail: "Fixture liquidity. Not real capacity and never was.",
    };
  }

  /* --------------------------------------------------------------- test control */

  /** Settle an invoice, revealing its preimage. `amountMsat` may differ from the invoice amount. */
  settle(paymentHash: string, options: { amountMsat?: bigint; settledAt?: number } = {}): BackendInvoice {
    const invoice = this.invoices.get(paymentHash.toLowerCase());
    if (!invoice) throw new Error(`Unknown fixture invoice ${paymentHash}`);
    if (invoice.state !== "pending") throw new Error(`Fixture invoice ${paymentHash} is ${invoice.state}`);
    invoice.state = "paid";
    invoice.paidMsat = options.amountMsat ?? invoice.amountMsat;
    invoice.settledAt = options.settledAt ?? Math.floor(Date.now() / 1000);
    return { paymentHash: invoice.paymentHash, bolt11: invoice.bolt11, expiresAt: invoice.expiresAt, preimage: invoice.preimage };
  }

  cancel(paymentHash: string): void {
    const invoice = this.invoices.get(paymentHash.toLowerCase());
    if (!invoice) throw new Error(`Unknown fixture invoice ${paymentHash}`);
    invoice.state = "cancelled";
  }

  /** Simulate a node or daemon failure so the API's degraded-mode handling can be tested. */
  forget(paymentHash: string): void {
    this.invoices.delete(paymentHash.toLowerCase());
  }

  listInvoiceHashes(): string[] {
    return [...this.invoices.keys()];
  }

  /** Compressed public key derived from the fixture private key, via OpenSSL rather than a crypto library. */
  private nodePubkey(): string {
    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(this.privateKey, "hex"));
    return ecdh.getPublicKey("hex", "compressed");
  }

  private bolt11Network(): Bolt11Network {
    return this.network === "regtest" ? "regtest" : this.network === "signet" ? "signet" : this.network === "testnet" ? "testnet" : "mainnet";
  }
}
