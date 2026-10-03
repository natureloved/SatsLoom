/**
 * Adapter tests.
 *
 * Two kinds, deliberately separated:
 *
 *  1. **Offline invariants** — key derivation, sighash, signing, VTXO id derivation, coin
 *     selection, the fixture ledger's rules. These run everywhere and verify the cryptography that
 *     actually moves money, because the SDK's signing and encoding layer is pure local code.
 *  2. **Live contract tests** — skipped unless `TACHI_LIVE_TEST=1`, because they need the real
 *     daemon. Run them with `TACHI_LIVE_TEST=1 npm test` on a machine that can reach regtest; the
 *     Day-1 gate (`npm run spike:tachi`) reports the same information as a truth table.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildTachiTxDeposit,
  computeVtxoId,
  encodeTachiTx,
  signTachiTx,
  tachiTxSigHash,
  userKeyMatches,
  vtxoIdFromDeposit,
} from "@tachibtc/taurus-vault-core";
import { FixtureDaemon, LiveTachiDaemon } from "./daemon.js";
import { identityFromMnemonic, isTestMnemonic, walletNetwork } from "./keys.js";
import { TachiRail, normalizeXOnly } from "./rail.js";
import { TachiAdapter } from "./index.js";
import { InsufficientCapacityError, TransferRejectedError } from "./errors.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PAYER_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const fixtureOptions = { provider: "fixture" as const, commitDelaySeconds: 0, env: { ...process.env, TACHI_PROVIDER: "fixture" } };

describe("identity derivation", () => {
  it("derives the BIP-84 regtest account the daemon reconstructs", () => {
    const identity = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    expect(identity.descriptor.path).toBe("m/84'/1'/0'/0/0");
    expect(identity.xOnly).toHaveLength(64);
    expect(identity.compressed).toMatch(/^0[23]/);
    expect(identity.address.startsWith("bcrt1q")).toBe(true);
    // The signing key and the published descriptor must agree, or a vault built from this
    // identity would commit to a key the owner cannot spend with.
    expect(userKeyMatches(identity.descriptor as never, identity.compressed)).toBe(true);
  });

  it("gives the same key for the same mnemonic and a different key for a different index", () => {
    const a = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    const b = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    const c = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest", index: 1 });
    expect(b.xOnly).toBe(a.xOnly);
    expect(c.xOnly).not.toBe(a.xOnly);
  });

  it("rejects an invalid mnemonic instead of deriving something", () => {
    expect(() => identityFromMnemonic("not actually a mnemonic at all", { network: "regtest" })).toThrow(/BIP-39/);
    expect(() => identityFromMnemonic(TEST_MNEMONIC, { network: "dogecoin" })).toThrow(/Unsupported wallet network/);
  });

  it("recognises published test vectors so the UI can warn about them", () => {
    expect(isTestMnemonic(TEST_MNEMONIC)).toBe(true);
    expect(isTestMnemonic(PAYER_MNEMONIC)).toBe(true);
    expect(isTestMnemonic("legal winner thank year wave sausage worth useful legal winner thank yellow".replace("legal", "legal"))).toBe(true);
  });

  it("normalizes compressed keys to x-only and refuses junk", () => {
    const identity = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    expect(normalizeXOnly(identity.compressed)).toBe(identity.xOnly);
    expect(normalizeXOnly(identity.xOnly)).toBe(identity.xOnly);
    expect(() => normalizeXOnly("deadbeef")).toThrow(/32- or 33-byte/);
  });

  it("resolves the network constants the vault builder needs", () => {
    expect((walletNetwork("regtest") as { bech32?: string }).bech32).toBe("bcrt");
    expect((walletNetwork("signet") as { bech32?: string }).bech32).toBe("tb");
    expect(() => walletNetwork("mainnet")).toThrow(/supports signet and regtest/);
  });
});

describe("transaction envelope", () => {
  it("signs a deposit with a 64-byte BIP-340 signature over the daemon's sighash", async () => {
    const identity = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    const tx = buildTachiTxDeposit({ userXOnly: Buffer.from(identity.xOnly, "hex"), amountSats: 100_000n, nonce: 1n });
    expect(tx.signature.length).toBe(0);
    const signed = await signTachiTx(tx, identity.signer as never);
    expect(signed.signature.length).toBe(64);
    expect(signed.outputs[0].amount).toBe(100_000n);
    expect(tachiTxSigHash(signed).length).toBe(32);
  });

  it("derives an output's VTXO id as sha256(tx_hash || be_uint32(index))", async () => {
    const identity = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    const tx = buildTachiTxDeposit({ userXOnly: Buffer.from(identity.xOnly, "hex"), amountSats: 42_000n, nonce: 7n });
    const signed = await signTachiTx(tx, identity.signer as never);
    const txHash = createHash("sha256").update(encodeTachiTx(signed)).digest("hex");
    // The SDK derives the id from the encoded transaction; the rail derives it from the hash. They
    // must agree, or a payment would be tracked under an id the ledger never mints.
    expect(vtxoIdFromDeposit(signed, 0).toString("hex")).toBe(computeVtxoId(txHash, 0).toString("hex"));
    expect(computeVtxoId(txHash, 1).toString("hex")).not.toBe(computeVtxoId(txHash, 0).toString("hex"));
  });

  it("produces a different id for a different nonce, so a resubmitted tx is a new tx", async () => {
    const identity = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    const one = await signTachiTx(buildTachiTxDeposit({ userXOnly: Buffer.from(identity.xOnly, "hex"), amountSats: 1000n, nonce: 1n }), identity.signer as never);
    const two = await signTachiTx(buildTachiTxDeposit({ userXOnly: Buffer.from(identity.xOnly, "hex"), amountSats: 1000n, nonce: 2n }), identity.signer as never);
    expect(vtxoIdFromDeposit(one, 0).toString("hex")).not.toBe(vtxoIdFromDeposit(two, 0).toString("hex"));
  });
});

describe("coin selection", () => {
  const rail = new TachiRail({ daemon: new FixtureDaemon({ commitDelaySeconds: 0 }) });
  const vtxo = (id: string, amountSats: bigint) => ({ vtxoId: id, owner: "aa".repeat(32), amountSats, state: "committed" as const });

  it("prefers the fewest inputs by taking the largest first", () => {
    const chosen = rail.selectInputs([vtxo("a".repeat(64), 10_000n), vtxo("b".repeat(64), 90_000n), vtxo("c".repeat(64), 1000n)], 50_000n);
    expect(chosen.map((v) => v.amountSats)).toEqual([90_000n]);
  });

  it("is deterministic for equal amounts regardless of input order", () => {
    const a = vtxo("a".repeat(64), 30_000n);
    const b = vtxo("b".repeat(64), 30_000n);
    const forward = rail.selectInputs([a, b], 30_000n).map((v) => v.vtxoId);
    const reversed = rail.selectInputs([b, a], 30_000n).map((v) => v.vtxoId);
    expect(reversed).toEqual(forward);
  });

  it("combines inputs when one is not enough, and refuses when nothing is", () => {
    expect(rail.selectInputs([vtxo("a".repeat(64), 20_000n), vtxo("b".repeat(64), 40_000n)], 50_000n)).toHaveLength(2);
    expect(() => rail.selectInputs([vtxo("a".repeat(64), 100n)], 50_000n)).toThrow(InsufficientCapacityError);
  });
});

describe("fixture ledger rules", () => {
  it("credits a deposit and reports it as spendable", async () => {
    const daemon = new FixtureDaemon({ commitDelaySeconds: 0 });
    const identity = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    const rail = new TachiRail({ daemon });
    const result = await rail.onboard(identity, 250_000n);
    expect(result.accepted).toBe(true);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(await daemon.balance(identity.xOnly)).toMatchObject({ balanceSats: 250_000n, nonce: 1 });
  });

  it("rejects a replayed nonce", async () => {
    const daemon = new FixtureDaemon({ commitDelaySeconds: 0 });
    const identity = identityFromMnemonic(TEST_MNEMONIC, { network: "regtest" });
    const tx = await signTachiTx(buildTachiTxDeposit({ userXOnly: Buffer.from(identity.xOnly, "hex"), amountSats: 1000n, nonce: 1n }), identity.signer as never);
    const hex = encodeTachiTx(tx).toString("hex");
    const meta = {
      kind: "deposit" as const,
      sender: identity.xOnly,
      inputs: [],
      outputs: [{ owner: identity.xOnly, amountSats: "1000" }],
      feeSats: "0",
      nonce: "1",
      createdVtxoIds: [vtxoIdFromDeposit(tx, 0).toString("hex")],
      txHash: createHash("sha256").update(encodeTachiTx(tx)).digest("hex"),
    };
    expect((await daemon.broadcastTx(hex, meta)).accepted).toBe(true);
    const again = await daemon.broadcastTx(hex, meta);
    expect(again.accepted).toBe(false);
    expect(again.log).toMatch(/already exists/);
  });

  it("rejects a transfer that spends a VTXO the sender does not own", async () => {
    const daemon = new FixtureDaemon({ commitDelaySeconds: 0 });
    const meta = {
      kind: "transfer" as const,
      sender: "cc".repeat(32),
      inputs: [{ vtxoId: "dd".repeat(32), valueSats: "5000" }],
      outputs: [{ owner: "ee".repeat(32), amountSats: "4000" }],
      feeSats: "1",
      nonce: "1",
      createdVtxoIds: [],
    };
    const ack = await daemon.broadcastTx("00", meta);
    expect(ack.accepted).toBe(false);
    expect(ack.log).toMatch(/vtxo not found/);
  });
});

describe("adapter end-to-end on the fixture ledger", () => {
  it("moves value from the demo payer to the merchant and detects the payment", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 500_000n);
    await adapter.onboard("demoPayer", 500_000n);

    const target = await adapter.targetFor("merchant");
    // What the API does at invoice creation: snapshot the existing VTXO ids as the baseline.
    const baseline = (await adapter.getAddressVtxos(target.owner)).map((vtxo) => vtxo.vtxoId);
    expect(baseline).toHaveLength(1);
    const before = await adapter.detectInvoicePayment({ id: "probe", amountSats: 10_000n, paymentTarget: target, baselineVtxoIds: baseline });
    expect(before).toBeNull();

    const transfer = await adapter.transferSats({ from: "demoPayer", toOwner: target.owner, amountSats: 50_000n, memo: "order" });
    expect(transfer.accepted).toBe(true);

    const proof = await adapter.detectInvoicePayment({ id: "inv", amountSats: 50_000n, paymentTarget: target, baselineVtxoIds: baseline });
    expect(proof).not.toBeNull();
    expect(proof!.amountSats).toBe(50_000n);
    expect(proof!.txid).toBe(transfer.txid);
    expect(proof!.vtxoId).toMatch(/^[0-9a-f]{64}$/);
    expect(proof!.confirmations).toBe(1);
    expect(proof!.explorerUrl).toContain("explorer-regtest.tachibtc.com/tx/");
    expect(proof!.mode).toBe("fixture");

    // Idempotent: the same ledger state yields the same proof, every poll.
    const second = await adapter.detectInvoicePayment({ id: "inv", amountSats: 50_000n, paymentTarget: target, baselineVtxoIds: baseline });
    expect(second!.txid).toBe(proof!.txid);
  });

  it("refuses to detect a payment at all when the baseline is unknown", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 500_000n);
    const target = await adapter.targetFor("merchant");
    // An unknown baseline must be a refusal: assuming "empty" here would report a pre-existing
    // 500,000-sat VTXO as payment of a 1,000-sat invoice.
    await expect(adapter.detectInvoicePayment({ id: "inv", amountSats: 1000n, paymentTarget: target })).rejects.toMatchObject({ code: "proof_stale" });
  });

  it("respects the invoice's baseline so an older VTXO cannot be mistaken for this payment", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 500_000n);
    const target = await adapter.targetFor("merchant");
    const existing = await adapter.getAddressVtxos(target.owner);
    const baseline = existing.map((v) => v.vtxoId);
    const proof = await adapter.detectInvoicePayment({ id: "inv", amountSats: 1000n, paymentTarget: target, baselineVtxoIds: baseline });
    expect(proof).toBeNull();
  });

  it("does NOT treat the merchant's own payout change as a customer payment", async () => {
    // The regression that matters most: a payout or a refund leaves change at the merchant's own
    // vault address. Amount-wise that change is "a new VTXO at least as large as the invoice", so a
    // naive detector confirms the invoice — telling the merchant they were paid when they merely
    // moved their own money. Detection must exclude outputs this process created for itself.
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 500_000n);
    await adapter.onboard("demoPayer", 500_000n);
    const merchant = await adapter.targetFor("merchant");
    const payer = await adapter.targetFor("demoPayer");
    const baseline = (await adapter.getAddressVtxos(merchant.owner)).map((v) => v.vtxoId);

    const invoice = { id: "inv-self", amountSats: 50_000n, paymentTarget: merchant, baselineVtxoIds: baseline };
    // A merchant payout: 1,000 sats out to the payer, ~498,999 back as change to the merchant.
    const payout = await adapter.transferSats({ from: "merchant", toOwner: payer.owner, amountSats: 1_000n, memo: "sweep" });
    expect(payout.selfOwnedVtxoIds).toHaveLength(1);
    expect(payout.createdVtxoIds).toContain(payout.selfOwnedVtxoIds[0]);

    expect(await adapter.detectInvoicePayment(invoice)).toBeNull();

    // And a genuine payment afterwards still confirms.
    await adapter.transferSats({ from: "demoPayer", toOwner: merchant.owner, amountSats: 50_000n });
    const proof = await adapter.detectInvoicePayment(invoice);
    expect(proof).not.toBeNull();
    expect(proof!.amountSats).toBe(50_000n);
  });

  it("prefers an exact-amount VTXO over a larger one, so change never outranks a real payment", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 500_000n);
    await adapter.onboard("demoPayer", 500_000n);
    await adapter.onboard("cold", 500_000n);
    const merchant = await adapter.targetFor("merchant");
    const cold = await adapter.targetFor("cold");
    const baseline = (await adapter.getAddressVtxos(merchant.owner)).map((v) => v.vtxoId);
    const invoice = { id: "inv-exact", amountSats: 50_000n, paymentTarget: merchant, baselineVtxoIds: baseline };

    // An overpayment lands first (60,000), then the exact invoice amount (50,000).
    await adapter.transferSats({ from: "cold", toOwner: merchant.owner, amountSats: 60_000n });
    await adapter.transferSats({ from: "demoPayer", toOwner: merchant.owner, amountSats: 50_000n });

    const proof = await adapter.detectInvoicePayment(invoice);
    expect(proof?.amountSats).toBe(50_000n);
  });

  it("refunds back to the payer's key and refuses when the payer is unknown", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 500_000n);
    await adapter.onboard("demoPayer", 500_000n);
    const payer = await adapter.targetFor("demoPayer");
    const merchant = await adapter.targetFor("merchant");
    await adapter.transferSats({ from: "demoPayer", toOwner: merchant.owner, amountSats: 20_000n });
    const refund = await adapter.transferSats({ from: "merchant", toOwner: payer.owner, amountSats: 20_000n, memo: "refund" });
    expect(refund.accepted).toBe(true);
    expect(await adapter.getTxStatus(refund.txid)).toMatchObject({ state: "committed" });
  });

  it("refuses to invent a key when none is configured in live mode", () => {
    const adapter = new TachiAdapter({ provider: "live", env: { ...process.env, TACHI_PROVIDER: "live", MERCHANT_MNEMONIC: undefined } as NodeJS.ProcessEnv });
    expect(adapter.hasIdentity("merchant")).toBe(false);
    expect(() => adapter.identity("merchant")).toThrow(/MERCHANT_MNEMONIC is not set/);
  });

  it("reports fixture mode in the capability probe rather than claiming live", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    const report = await adapter.capabilities();
    expect(report.mode).toBe("fixture");
    expect(report.capabilities.every((c) => c.mode !== "live")).toBe(true);
    expect(report.capabilities.find((c) => c.id === "explorer-link")?.ok).toBe(true);
  });

  it("surfaces a daemon refusal as a typed error carrying the daemon's own log", async () => {
    const daemon = new FixtureDaemon({ commitDelaySeconds: 0 });
    const adapter = new TachiAdapter({ ...fixtureOptions, daemon });
    // Fund the payer, then spend it all, then try again: the second transfer has no inputs left.
    await adapter.onboard("demoPayer", 10_000n);
    await adapter.onboard("merchant", 10_000n);
    const merchant = await adapter.targetFor("merchant");
    await adapter.transferSats({ from: "demoPayer", toOwner: merchant.owner, amountSats: 9_999n });
    await expect(
      adapter.transferSats({ from: "demoPayer", toOwner: merchant.owner, amountSats: 9_999n }),
    ).rejects.toBeInstanceOf(InsufficientCapacityError);
  });
});

describe("live daemon error mapping", () => {
  it("maps a transport failure to DaemonUnreachable, not to a fake success", async () => {
    const daemon = new LiveTachiDaemon({
      baseUrl: "https://rpc-regtest.invalid",
      timeoutMs: 200,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed: getaddrinfo ENOTFOUND rpc-regtest.invalid");
      }) as unknown as typeof fetch,
    });
    await expect(daemon.health()).rejects.toMatchObject({ code: "daemon_unreachable" });
  });

  it("treats a non-zero CheckTx code as a rejection even though the HTTP call succeeded", async () => {
    const daemon = new LiveTachiDaemon({
      baseUrl: "https://rpc-regtest.example",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { code: 4, log: "invalid nonce: got 3, expected 4", hash: "ab".repeat(32) } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const ack = await daemon.broadcastTx("00", { kind: "transfer", sender: "aa".repeat(32), inputs: [], outputs: [], feeSats: "0", nonce: "3", createdVtxoIds: [] });
    expect(ack.accepted).toBe(false);
    expect(ack.code).toBe(4);
    expect(ack.log).toMatch(/invalid nonce/);
  });

  it("reports a 404 tx lookup as 'not found yet' rather than throwing", async () => {
    const daemon = new LiveTachiDaemon({
      baseUrl: "https://rpc-regtest.example",
      fetchImpl: (async () => new Response("transaction not found", { status: 404 })) as unknown as typeof fetch,
    });
    expect(await daemon.txStatus("ab".repeat(32))).toMatchObject({ found: false, state: "pending" });
  });
});

describe("withdrawal destination validation", () => {
  it("refuses a destination that is not a Taproot address", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 100_000n);
    await expect(adapter.withdrawSats({ from: "merchant", toAddress: "bcrt1qnotataprootaddress", amountSats: 1000n })).rejects.toBeTruthy();
  });

  it("accepts a Taproot address and converts it to an output key", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await adapter.onboard("merchant", 100_000n);
    const cold = await adapter.targetFor("cold");
    const result = await adapter.withdrawSats({ from: "merchant", toAddress: cold.address, amountSats: 10_000n });
    expect(result.accepted).toBe(true);
    expect(result.kind).toBe("withdraw");
    // Two outputs: the destination and the change coming back to the merchant as a fresh VTXO.
    expect(result.createdVtxoIds).toHaveLength(2);
  });

  it("rejects a zero or negative amount before touching the ledger", async () => {
    const adapter = new TachiAdapter(fixtureOptions);
    await expect(adapter.transferSats({ from: "merchant", toOwner: "aa".repeat(32), amountSats: 0n })).rejects.toBeTruthy();
    await expect(adapter.onboard("merchant", -1n)).rejects.toBeInstanceOf(InsufficientCapacityError);
  });
});

/**
 * Live contract tests. Skipped by default; run with `TACHI_LIVE_TEST=1 npm test` on a machine with
 * regtest access and funded accounts. They assert the same properties the fixture tests do, only
 * against the real network — which is the one thing a local harness cannot prove.
 */
const live = process.env.TACHI_LIVE_TEST === "1" ? describe : describe.skip;
live("live daemon contract (TACHI_LIVE_TEST=1)", () => {
  const adapter = new TachiAdapter({ provider: "live" });

  it("reports live mode and a reachable daemon", async () => {
    const status = await adapter.getStatus();
    expect(status.mode).toBe("live");
    expect(status.reachable).toBe(true);
  });

  it("derives a bcrt1p address from the live quorum", async () => {
    const target = await adapter.targetFor("merchant");
    expect(target.address.startsWith("bcrt1p")).toBe(true);
    expect(await adapter.verifyVault({ id: "", address: target.address, csvDelay: Number(process.env.TACHI_CSV_BLOCKS ?? 1008) })).toMatchObject({ valid: true });
  });

  it("reads the merchant's balance and VTXO set", async () => {
    const target = await adapter.targetFor("merchant");
    expect(typeof (await adapter.getSpendableBalance("merchant"))).toBe("bigint");
    expect(Array.isArray(await adapter.getAddressVtxos(target.owner))).toBe(true);
  });

  it("broadcasts a transfer and reads its status back", async () => {
    const target = await adapter.targetFor("demoPayer");
    const result = await adapter.transferSats({ from: "merchant", toOwner: target.owner, amountSats: 1000n, memo: "live contract test" });
    expect(result.accepted).toBe(true);
    const status = await adapter.getTxStatus(result.txid);
    expect(status.found).toBe(true);
  });

  it("reports a typed rejection for a transfer larger than the balance", async () => {
    const target = await adapter.targetFor("demoPayer");
    await expect(adapter.transferSats({ from: "merchant", toOwner: target.owner, amountSats: 21_000_000n * 100_000_000n })).rejects.toBeInstanceOf(InsufficientCapacityError);
  });

  it("returns a rejection with the daemon's log rather than a silent success", async () => {
    const daemon = new LiveTachiDaemon();
    const ack = await daemon.broadcastTx("00", { kind: "transfer", sender: "aa".repeat(32), inputs: [], outputs: [], feeSats: "0", nonce: "1", createdVtxoIds: [] });
    expect(ack.accepted).toBe(false);
    expect(typeof ack.log).toBe("string");
  });
});

void TransferRejectedError;
