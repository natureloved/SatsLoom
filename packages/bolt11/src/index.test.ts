import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  Bolt11Error,
  DEFAULT_FEATURES,
  decodeAmount,
  decodeInvoice,
  encodeAmount,
  encodeInvoice,
  hasFeature,
  invoiceSigningBytes,
  isExpired,
  paymentHashFromPreimage,
  verifyPreimage,
} from "./index.js";
import { bech32Decode, bech32Encode, convertBits } from "./bech32.js";

/**
 * The vectors below are copied from the BOLT11 specification ("Examples"). They are the
 * ground truth: if this implementation reproduces the exact invoice strings, the exact
 * signing preimage hex and the exact SHA256, then the tag order, both field encodings,
 * the amount handling, the feature bits and the deterministic signature are all right.
 */
const VECTORS = {
  privateKey: "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734",
  pubkey: "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad",
  paymentHash: "0001020304050607080900010203040506070809000102030405060708090102",
  paymentSecret: "11".repeat(32),
  timestamp: 1496314658,
  features: 0x4100n,
  donation: {
    invoice:
      "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql",
    description: "Please consider supporting this project",
    preimageHex:
      "6c6e62630b25fe64500d04444444444444444444444444444444444444444444444444444444444444444021a00008101820283038404800081018202830384048000810182028303840480810343f506c6561736520636f6e736964657220737570706f7274696e6720746869732070726f6a6563740500e08000",
    sha256: "6daf4d488be41ce7cbb487cab1ef2975e5efcea879b20d421f0ef86b07cbb987",
    signatureR: "8d3ce9e28357337f62da0162d9454df827f83cfe499aeb1c1db349d4d8112742",
    signatureS: "5e434ca29929406c23bba1ae8ac6ca32880b38d4bf6ff874024cac34ba9625f1",
    recoveryId: 1,
  },
  coffee: {
    invoice:
      "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh",
    description: "1 cup coffee",
    amountMsat: 250_000_000n,
    expirySeconds: 60,
    preimageHex:
      "6c6e626332353030750b25fe64500d04444444444444444444444444444444444444444444444444444444444444444021a000081018202830384048000810182028303840480008101820283038404808103414312063757020636f66666565030041e140382000",
    sha256: "047e24bf270b25d42a56d57b2578faa3a10684641bab817c2851a871cb41dbc0",
  },
} as const;

describe("BOLT11 specification vectors", () => {
  it("decodes the donation vector and recovers the documented payee key", () => {
    const decoded = decodeInvoice(VECTORS.donation.invoice);
    expect(decoded.network).toBe("mainnet");
    expect(decoded.amountMsat).toBeNull();
    expect(decoded.timestamp).toBe(VECTORS.timestamp);
    expect(decoded.paymentHash).toBe(VECTORS.paymentHash);
    expect(decoded.paymentSecret).toBe(VECTORS.paymentSecret);
    expect(decoded.description).toBe(VECTORS.donation.description);
    expect(decoded.features).toBe(VECTORS.features);
    expect(decoded.recoveredPayeePubkey).toBe(VECTORS.pubkey);
    expect(decoded.signature).toBe(`${VECTORS.donation.signatureR}${VECTORS.donation.signatureS}0${VECTORS.donation.recoveryId}`);
    expect(decoded.signatureValid).toBe(true);
  });

  it("decodes the coffee vector's amount, expiry and description", () => {
    const decoded = decodeInvoice(VECTORS.coffee.invoice);
    expect(decoded.amountMsat).toBe(VECTORS.coffee.amountMsat);
    expect(decoded.expirySeconds).toBe(VECTORS.coffee.expirySeconds);
    expect(decoded.description).toBe(VECTORS.coffee.description);
    expect(decoded.expiresAt).toBe(VECTORS.timestamp + VECTORS.coffee.expirySeconds);
  });

  it("reproduces the spec's signing preimage and its SHA256 byte for byte", () => {
    for (const vector of [VECTORS.donation, VECTORS.coffee]) {
      const { hrp, data } = bech32Decode(vector.invoice);
      const payloadWords = data.slice(0, -104);
      const message = invoiceSigningBytes(hrp, payloadWords);
      expect(Buffer.from(message).toString("hex")).toBe(vector.preimageHex);
      expect(createHash("sha256").update(message).digest("hex")).toBe(vector.sha256);
    }
  });

  it("re-encodes both vectors to the exact strings in the specification", () => {
    // includePayeePubkey: false because the spec's examples omit the `n` tag; a product
    // invoice includes it (asserted separately below).
    const donation = encodeInvoice({
      network: "mainnet",
      paymentHash: VECTORS.paymentHash,
      paymentSecret: VECTORS.paymentSecret,
      description: VECTORS.donation.description,
      payeePrivateKey: VECTORS.privateKey,
      timestamp: VECTORS.timestamp,
      features: VECTORS.features,
      includePayeePubkey: false,
    });
    expect(donation.invoice).toBe(VECTORS.donation.invoice);

    const coffee = encodeInvoice({
      network: "mainnet",
      amountMsat: VECTORS.coffee.amountMsat,
      paymentHash: VECTORS.paymentHash,
      paymentSecret: VECTORS.paymentSecret,
      description: VECTORS.coffee.description,
      payeePrivateKey: VECTORS.privateKey,
      timestamp: VECTORS.timestamp,
      expirySeconds: VECTORS.coffee.expirySeconds,
      features: VECTORS.features,
      includePayeePubkey: false,
    });
    expect(coffee.invoice).toBe(VECTORS.coffee.invoice);
  });
});

describe("amount encoding", () => {
  it("uses the shortest exact representation", () => {
    expect(encodeAmount(250_000_000n)).toBe("2500u");
    expect(encodeAmount(100_000_000_000n)).toBe("1");
    expect(encodeAmount(150_000_000_000n)).toBe("1500m");
    expect(encodeAmount(250_000_000_000n)).toBe("2500m");
    expect(encodeAmount(2_500_000n)).toBe("25u");
    expect(encodeAmount(60_000n)).toBe("600n");
  });

  it("round-trips every unit and rejects sub-millisatoshi amounts", () => {
    for (const msat of [1_000n, 1_000_000n, 1_000_000_000n, 100_000_000_000n, 123_400n]) {
      expect(decodeAmount(encodeAmount(msat))).toBe(msat);
    }
    // 1 pico-BTC is 0.1 msat: below the protocol's resolution, so it MUST fail.
    expect(() => decodeAmount("1p")).toThrow(Bolt11Error);
    expect(decodeAmount("10p")).toBe(1n);
  });

  it("rejects the spec's illegal amounts", () => {
    expect(() => decodeAmount("0123")).toThrow(Bolt11Error);
    expect(() => decodeAmount("12x")).toThrow(Bolt11Error);
    // A `p` amount whose last decimal is not 0 is sub-millisatoshi and MUST fail.
    expect(() => decodeAmount("11p")).toThrow(Bolt11Error);
    expect(decodeAmount("110p")).toBe(11n);
    expect(() => decodeAmount("")).toThrow(Bolt11Error);
  });
});

describe("invoice integrity", () => {
  const input = {
    network: "regtest" as const,
    amountMsat: 21_000n,
    paymentHash: paymentHashFromPreimage("aa".repeat(32)),
    paymentSecret: "bb".repeat(32),
    description: "Order 101",
    payeePrivateKey: VECTORS.privateKey,
    expirySeconds: 900,
  };

  it("produces a payable invoice with the payee key declared", () => {
    const invoice = encodeInvoice(input);
    expect(invoice.network).toBe("regtest");
    expect(invoice.invoice.startsWith("lnbcrt")).toBe(true);
    expect(invoice.payeePubkey).toBe(VECTORS.pubkey);
    expect(invoice.signatureValid).toBe(true);
    expect(invoice.amountMsat).toBe(21_000n);
    expect(invoice.expirySeconds).toBe(900);
    expect(hasFeature(invoice, 8)).toBe(true);
    expect(invoice.features).toBe(DEFAULT_FEATURES);
  });

  it("rejects a tampered payload that carries a valid checksum", () => {
    const { invoice } = encodeInvoice(input);
    const { hrp, data } = bech32Decode(invoice);
    const tampered = [...data];
    // Change the invoice amount's committed expiry (the `x` value) while keeping the signature.
    const xIndex = tampered.findIndex((word, i) => i > 6 && word === 6 && tampered[i + 1] === 0 && tampered[i + 2] === 2);
    expect(xIndex).toBeGreaterThan(0);
    tampered[xIndex + 3] = 31;
    const reChecksummed = bech32Encode(hrp, tampered);
    expect(() => decodeInvoice(reChecksummed)).toThrow(/signature/i);
  });

  it("rejects a corrupted checksum and mixed case", () => {
    const { invoice } = encodeInvoice(input);
    const corrupted = invoice.slice(0, -1) + (invoice.endsWith("q") ? "p" : "q");
    expect(() => decodeInvoice(corrupted)).toThrow(Bolt11Error);
    expect(() => decodeInvoice(invoice.toUpperCase().slice(0, 30) + invoice.slice(30))).toThrow(Bolt11Error);
  });

  it("separates expiry from creation time", () => {
    const invoice = encodeInvoice({ ...input, timestamp: 1_000_000 });
    expect(isExpired(invoice, 1_000_899)).toBe(false);
    expect(isExpired(invoice, 1_000_900)).toBe(true);
  });

  it("encodes and decodes an on-chain fallback address", () => {
    // BIP-173 / BIP-350 addresses: bech32 for v0, bech32m for v1.
    const p2wpkh = bech32Encode("bcrt", [0, ...convertBits([...new Uint8Array(20).fill(7)], 8, 5, true)]);
    const p2tr = bech32Encode("bcrt", [1, ...convertBits([...new Uint8Array(32).fill(9)], 8, 5, true)], 0x2bc830a3);
    expect(decodeInvoice(encodeInvoice({ ...input, fallbackAddress: p2wpkh }).invoice).fallbackAddress).toBe(p2wpkh);
    expect(decodeInvoice(encodeInvoice({ ...input, fallbackAddress: p2tr }).invoice).fallbackAddress).toBe(p2tr);
  });
});

describe("preimage verification", () => {
  it("credits only the preimage that hashes to the committed payment hash", () => {
    const preimage = "0f".repeat(32);
    const hash = paymentHashFromPreimage(preimage);
    expect(verifyPreimage(preimage, hash)).toBe(true);
    expect(verifyPreimage("ff".repeat(32), hash)).toBe(false);
    expect(verifyPreimage("not-hex", hash)).toBe(false);
    expect(verifyPreimage(preimage, hash.toUpperCase())).toBe(true);
  });
});

describe("bech32", () => {
  it("handles BIP-173 vectors and rejects bad checksums", () => {
    expect(bech32Decode("A12UEL5L").hrp).toBe("a");
    expect(bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw").hrp).toBe("abcdef");
    expect(() => bech32Decode("A12UEL5X")).toThrow(/checksum/);
    expect(() => bech32Decode("a12uEl5l")).toThrow(/mixed-case/);
  });

  it("refuses values that do not fit the source width", () => {
    expect(() => convertBits([32], 5, 8, true)).toThrow(/does not fit/);
  });
});
