import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { decodeInvoice, paymentHashFromPreimage } from "@satsloom/bolt11";
import {
  CreditRegistry,
  DEFAULT_CREDIT_POLICY,
  LightningRail,
  assertInvoiceMatchesRequest,
  verifyPayment,
  type PaymentObservation,
  type PaymentRequest,
} from "./index.js";
import { FixtureLightningBackend } from "./fixture.js";
import { LndRestBackend } from "./lnd-rest.js";

const PREIMAGE = "5a".repeat(32);
const PAYMENT_HASH = paymentHashFromPreimage(PREIMAGE);

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  const preimage = overrides.paymentHash && overrides.paymentHash !== PAYMENT_HASH ? undefined : PREIMAGE;
  const hash = overrides.paymentHash ?? PAYMENT_HASH;
  return {
    rail: "lightning-regtest",
    railRequestId: hash,
    paymentHash: hash,
    amountMsat: 21_000n,
    invoice: "lnbcrt1-not-used-by-these-checks",
    network: "regtest",
    mode: "testnet",
    createdAt: 1_000_000,
    expiresAt: 1_000_900,
    description: "Order 101",
    decoded: {} as PaymentRequest["decoded"],
    ...overrides,
    ...(preimage ? {} : {}),
  };
}

function observation(overrides: Partial<PaymentObservation> = {}): PaymentObservation {
  return {
    railRequestId: PAYMENT_HASH,
    paymentHash: PAYMENT_HASH,
    state: "paid",
    paidMsat: 21_000n,
    settledAt: 1_000_500,
    preimage: PREIMAGE,
    ...overrides,
  };
}

describe("credit decisions fail closed", () => {
  it("credits an exact payment whose preimage hashes to the committed payment hash", () => {
    const verdict = verifyPayment(request(), observation(), DEFAULT_CREDIT_POLICY, 1_000_600);
    expect(verdict.credited).toBe(true);
    if (verdict.credited) {
      expect(verdict.amountMsat).toBe(21_000n);
      expect(verdict.surplusMsat).toBe(0n);
    }
  });

  it("keeps a real surplus rather than silently discarding it", () => {
    const verdict = verifyPayment(request(), observation({ paidMsat: 25_000n }), DEFAULT_CREDIT_POLICY, 1_000_600);
    expect(verdict.credited).toBe(true);
    if (verdict.credited) expect(verdict.surplusMsat).toBe(4_000n);
  });

  it("refuses a payment that is not settled", () => {
    for (const state of ["pending", "expired", "cancelled", "unknown"] as const) {
      const verdict = verifyPayment(request(), observation({ state, preimage: undefined }), DEFAULT_CREDIT_POLICY, 1_000_600);
      expect(verdict.credited).toBe(false);
    }
  });

  it("refuses a preimage that does not hash to the committed payment hash", () => {
    const verdict = verifyPayment(request(), observation({ preimage: "ff".repeat(32) }), DEFAULT_CREDIT_POLICY, 1_000_600);
    expect(verdict.credited).toBe(false);
    if (!verdict.credited) expect(verdict.reason).toBe("invalid_preimage");
  });

  it("refuses a settlement reported without any preimage at all", () => {
    const verdict = verifyPayment(request(), observation({ preimage: undefined }), DEFAULT_CREDIT_POLICY, 1_000_600);
    expect(verdict.credited).toBe(false);
    if (!verdict.credited) expect(verdict.reason).toBe("missing_preimage");
  });

  it("refuses an observation that belongs to a different invoice", () => {
    const other = paymentHashFromPreimage("99".repeat(32));
    const verdict = verifyPayment(request(), observation({ railRequestId: other, paymentHash: other }), DEFAULT_CREDIT_POLICY, 1_000_600);
    expect(verdict.credited).toBe(false);
    if (!verdict.credited) expect(verdict.reason).toBe("payment_hash_mismatch");
  });

  it("refuses underpayment by default and can be configured to accept partials", () => {
    const underpaid = observation({ paidMsat: 20_000n });
    expect(verifyPayment(request(), underpaid, DEFAULT_CREDIT_POLICY, 1_000_600).credited).toBe(false);
    const partial = verifyPayment(request(), underpaid, { ...DEFAULT_CREDIT_POLICY, allowPartial: true }, 1_000_600);
    expect(partial.credited).toBe(true);
    if (partial.credited) expect(partial.amountMsat).toBe(20_000n);
  });

  it("refuses overpayment when the policy does not accept it", () => {
    const verdict = verifyPayment(request(), observation({ paidMsat: 30_000n }), { ...DEFAULT_CREDIT_POLICY, allowOverpayment: false }, 1_000_600);
    expect(verdict.credited).toBe(false);
  });

  it("refuses settlements after expiry unless a grace window allows them", () => {
    const late = observation({ settledAt: 1_000_901 });
    expect(verifyPayment(request(), late, DEFAULT_CREDIT_POLICY, 1_001_000).credited).toBe(false);
    const graced = verifyPayment(request(), late, { ...DEFAULT_CREDIT_POLICY, lateSettlementGraceSeconds: 300 }, 1_001_000);
    expect(graced.credited).toBe(true);
  });

  it("credits each preimage exactly once", () => {
    const registry = new CreditRegistry();
    expect(registry.claim("lightning-regtest", PREIMAGE)).toBe(true);
    expect(registry.claim("lightning-regtest", PREIMAGE)).toBe(false);
    expect(registry.has("lightning-regtest", PREIMAGE.toUpperCase())).toBe(true);
    expect(registry.claim("lightning-mainnet", PREIMAGE)).toBe(true);
  });
});

describe("LightningRail over the fixture backend", () => {
  const backend = new FixtureLightningBackend();
  const rail = new LightningRail({ backend });

  it("never describes itself as live", () => {
    const descriptor = rail.describe();
    expect(descriptor.mode).toBe("fixture");
    expect(descriptor.live).toBe(false);
    expect(descriptor.verified).toBe(false);
    expect(descriptor.note).toMatch(/no network or value/i);
  });

  it("issues a real, verifiable BOLT11 invoice on regtest", async () => {
    const created = await rail.createRequest({ amountMsat: 21_000n, description: "Order 101", expirySeconds: 900 });
    expect(created.invoice.startsWith("lnbcrt")).toBe(true);
    expect(created.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    // Decoded independently of the fixture's own encoder state.
    const decoded = decodeInvoice(created.invoice);
    expect(decoded.paymentHash).toBe(created.paymentHash);
    expect(decoded.amountMsat).toBe(21_000n);
    expect(decoded.description).toBe("Order 101");
    expect(decoded.expirySeconds).toBe(900);
    expect(decoded.signatureValid).toBe(true);
    expect(decoded.payeePubkey).toBe((await backend.getInfo()).nodePubkey);
    expect(created.expiresAt).toBe(decoded.expiresAt);
  });

  it("refuses to credit until the node reveals a settlement", async () => {
    const created = await rail.createRequest({ amountMsat: 5_000n, description: "unpaid", expirySeconds: 900 });
    const verdict = await rail.credit(created);
    expect(verdict.credited).toBe(false);
    if (!verdict.credited) expect(verdict.reason).toBe("not_paid");
  });

  it("credits a settled invoice once and reports a duplicate on the second attempt", async () => {
    const created = await rail.createRequest({ amountMsat: 7_000n, description: "paid", expirySeconds: 900 });
    backend.settle(created.paymentHash);
    const first = await rail.credit(created);
    expect(first.credited).toBe(true);
    const second = await rail.credit(created);
    expect(second.credited).toBe(false);
    if (!second.credited) expect(second.reason).toBe("duplicate");
  });

  it("refuses an invoice the node has forgotten", async () => {
    const created = await rail.createRequest({ amountMsat: 1_000n, description: "vanished", expirySeconds: 900 });
    backend.forget(created.paymentHash);
    const verdict = await rail.credit(created);
    expect(verdict.credited).toBe(false);
    if (!verdict.credited) expect(verdict.reason).toBe("unknown_state");
  });

  it("reports liquidity with the fixture's honest label", async () => {
    const liquidity = await rail.liquidity();
    expect(liquidity.inboundSats).toBe(250_000n);
    expect(liquidity.detail).toMatch(/not real capacity/i);
  });
});

describe("a node that returns the wrong invoice is rejected", () => {
  it("rejects an invoice for a different amount, hash or network", async () => {
    const backend = new FixtureLightningBackend();
    const rail = new LightningRail({ backend });
    const created = await rail.createRequest({ amountMsat: 1_000n, description: "Order", expirySeconds: 900 });

    expect(() => assertInvoiceMatchesRequest(created.invoice, {
      network: "regtest",
      amountMsat: 2_000n,
      paymentHash: created.paymentHash,
    })).toThrow(/msat/i);

    expect(() => assertInvoiceMatchesRequest(created.invoice, {
      network: "regtest",
      amountMsat: 1_000n,
      paymentHash: paymentHashFromPreimage("01".repeat(32)),
    })).toThrow(/payment hash/i);

    expect(() => assertInvoiceMatchesRequest(created.invoice, {
      network: "mainnet",
      amountMsat: 1_000n,
      paymentHash: created.paymentHash,
    })).toThrow(/mainnet/);
  });

  it("rejects a tampered invoice before a customer could scan it", async () => {
    const backend = new FixtureLightningBackend();
    const rail = new LightningRail({ backend });
    const created = await rail.createRequest({ amountMsat: 1_000n, description: "Order", expirySeconds: 900 });
    const tampered = created.invoice.slice(0, -1) + (created.invoice.endsWith("q") ? "p" : "q");
    expect(() => assertInvoiceMatchesRequest(tampered, {
      network: "regtest",
      amountMsat: 1_000n,
      paymentHash: created.paymentHash,
    })).toThrow(/undecodable/i);
  });
});

describe("LND REST backend", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastMacaroon: string | undefined;
  let lastBody: Record<string, unknown> | undefined;
  /** Deltas applied to the stub's responses so failure modes can be exercised. */
  const stubState = { settled: false, preimageMissing: false, redirect: false };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        lastMacaroon = req.headers["grpc-metadata-macaroon"] as string | undefined;
        if (req.method === "POST") {
          try {
            lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            lastBody = undefined;
          }
        }
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (stubState.redirect) {
          res.writeHead(302, { location: "http://evil.example/v1/invoices" });
          res.end();
          return;
        }
        if (req.url === "/v1/getinfo") {
          send(200, { identity_pubkey: "02".repeat(33), synced_to_chain: true, block_height: 800_000, version: "0.19.0-beta" });
          return;
        }
        if (req.url === "/v1/invoices" && req.method === "POST") {
          send(200, {
            r_hash: Buffer.from(PAYMENT_HASH, "hex").toString("base64"),
            payment_request: "lnbcrt1stub",
            creation_date: "1700000000",
            expiry: "900",
          });
          return;
        }
        if (req.url === `/v1/invoice/${PAYMENT_HASH}`) {
          send(200, {
            state: stubState.settled ? "SETTLED" : "OPEN",
            amt_paid_msat: stubState.settled ? "21000" : "0",
            settle_date: stubState.settled ? "1700000500" : "0",
            r_preimage: stubState.settled && !stubState.preimageMissing ? Buffer.from(PREIMAGE, "hex").toString("base64") : "",
          });
          return;
        }
        if (req.url === `/v1/invoice/${"ab".repeat(32)}`) {
          send(404, { error: "unable to locate invoice" });
          return;
        }
        if (req.url === "/v1/channels") {
          send(200, { channels: [
            { active: true, local_balance: "50000", remote_balance: "150000" },
            { active: false, local_balance: "999999", remote_balance: "999999" },
          ] });
          return;
        }
        if (req.url === "/v1/channels/transactions" && req.method === "POST") {
          send(200, {
            payment_error: "",
            payment_preimage: Buffer.from(PREIMAGE, "hex").toString("base64"),
            payment_hash: Buffer.from(PAYMENT_HASH, "hex").toString("base64"),
            payment_route: { total_amt_msat: "21000", total_fees_msat: "100" },
          });
          return;
        }
        send(404, { error: "unknown endpoint" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const backend = () => new LndRestBackend({ baseUrl, macaroonHex: "ab".repeat(32), network: "mainnet", allowInsecureHttp: true });

  it("requires https unless the caller explicitly allows a private-network node", () => {
    expect(() => new LndRestBackend({ baseUrl: "http://node.example:8080", macaroonHex: "ab".repeat(32), network: "mainnet" })).toThrow(/https/);
  });

  it("reports mainnet as live and testnet as not live", () => {
    expect(backend().isLive()).toBe(true);
    expect(new LndRestBackend({ baseUrl, macaroonHex: "ab".repeat(32), network: "signet", allowInsecureHttp: true }).isLive()).toBe(false);
  });

  it("reads node info with the macaroon header", async () => {
    const info = await backend().getInfo();
    expect(info.reachable).toBe(true);
    expect(info.synced).toBe(true);
    expect(info.blockHeight).toBe(800_000);
    expect(lastMacaroon).toBe("ab".repeat(32));
  });

  it("creates an invoice with value_msat, memo and expiry, and converts the hash to hex", async () => {
    const created = await backend().createInvoice({ amountMsat: 21_000n, description: "Order 101", expirySeconds: 900 });
    expect(created.paymentHash).toBe(PAYMENT_HASH);
    expect(created.expiresAt).toBe(1_700_000_900);
    // Verified against a real LND 0.21.4 on signet: `value` and `value_msat` are mutually
    // exclusive and sending both fails with "sat and msat arguments are mutually exclusive".
    // Sub-satoshi precision is the point, so `value_msat` alone is the correct body.
    expect(lastBody).toMatchObject({ value_msat: "21000", memo: "Order 101", expiry: "900" });
    expect(lastBody).not.toHaveProperty("value");
  });

  it("maps LND invoice states and only surfaces a preimage when one is present", async () => {
    stubState.settled = false;
    const open = await backend().lookupInvoice(PAYMENT_HASH);
    expect(open.state).toBe("pending");
    expect(open.preimage).toBeUndefined();

    stubState.settled = true;
    const settled = await backend().lookupInvoice(PAYMENT_HASH);
    expect(settled.state).toBe("paid");
    expect(settled.paidMsat).toBe(21_000n);
    expect(settled.settledAt).toBe(1_700_000_500);
    expect(settled.preimage).toBe(PREIMAGE);

    stubState.preimageMissing = true;
    const proofMissing = await backend().lookupInvoice(PAYMENT_HASH);
    expect(proofMissing.state).toBe("paid");
    expect(proofMissing.preimage).toBeUndefined();
    stubState.preimageMissing = false;
    stubState.settled = false;
  });

  it("treats an unknown payment hash as unknown, not as an outage", async () => {
    expect((await backend().lookupInvoice("ab".repeat(32))).state).toBe("unknown");
  });

  it("refuses to follow a redirect", async () => {
    stubState.redirect = true;
    await expect(backend().lookupInvoice(PAYMENT_HASH)).rejects.toThrow(/redirect/i);
    stubState.redirect = false;
  });

  it("sums only active channels for liquidity and labels inbound honestly", async () => {
    const liquidity = await backend().liquidity();
    expect(liquidity.outboundSats).toBe(50_000n);
    expect(liquidity.inboundSats).toBe(150_000n);
    expect(liquidity.detail).toMatch(/lower bound/i);
  });

  it("surfaces an HTTP failure as a rail-unavailable error with its status", async () => {
    const bad = new LndRestBackend({ baseUrl: `${baseUrl}/nope`, macaroonHex: "ab".repeat(32), network: "mainnet", allowInsecureHttp: true });
    await expect(bad.getInfo()).rejects.toMatchObject({ name: "RailUnavailableError", code: "rail_unavailable" });
  });

  it("refuses a macaroon that is not hex", () => {
    expect(() => new LndRestBackend({ baseUrl, macaroonHex: "not-a-macaroon", network: "mainnet", allowInsecureHttp: true })).toThrow(/hex/);
  });

  it("pays a BOLT11 invoice and verifies the returned preimage proof", async () => {
    const result = await backend().payInvoice("lnbcrt210n1stub");
    expect(result.paymentHash).toBe(PAYMENT_HASH);
    expect(result.preimage).toBe(PREIMAGE);
    expect(result.paidMsat).toBe(21_000n);
  });

  it("pays an invoice in fixture mode and updates outbound capacity", async () => {
    const fixture = new FixtureLightningBackend({ outboundSats: 100_000n });
    const created = await fixture.createInvoice({ amountMsat: 21_000n, description: "Payout", expirySeconds: 600 });
    const result = await fixture.payInvoice(created.bolt11);
    expect(result.paymentHash).toBe(created.paymentHash);
    expect(result.preimage).toBeDefined();
    expect(paymentHashFromPreimage(result.preimage)).toBe(created.paymentHash);
    const liq = await fixture.liquidity();
    expect(liq.outboundSats).toBe(100_000n - 21n);
  });
});

describe("preimage hashing agrees with the invoice commitment", () => {
  it("uses SHA256(preimage) as the payment hash", () => {
    expect(paymentHashFromPreimage(PREIMAGE)).toBe(createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex"));
  });
});
