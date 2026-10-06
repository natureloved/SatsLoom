/**
 * BOLT11 invoices: encode, decode, verify.
 *
 * Why this exists in SatsLoom: the demo issues `paymentUrl: "/#checkout/<id>"` and a `null`
 * QR payload, because there is nothing real to encode. A live rail needs an artifact a real
 * wallet can scan and pay, and the verification side needs to be able to check a payment
 * against it. This package produces real, signed, spec-conformant invoices — the strings are
 * payable by any BOLT11 wallet on the matching network.
 *
 * Two encodings live in one format, and getting them confused produces invoices that decode
 * to the wrong field values rather than failing loudly:
 *
 *   - byte-valued fields (payment hash `p`, secret `s`, description `d`, pubkey `n`,
 *     description hash `h`, fallback `f`) are bytes regrouped 8->5 bits with padding;
 *   - integer/bitfield fields (timestamp, `x` expiry, `c` cltv delta, `9` features) are the
 *     big-endian base-32 digits of the value itself.
 *
 * Both rules are asserted against the BOLT11 specification's own test vectors in index.test.ts,
 * including the spec's signing-preimage hex and its SHA256, so the format handling is checked
 * against the reference rather than against this implementation's own assumptions.
 *
 * Signature: 64-byte compact ECDSA (R||S) over secp256k1 plus a 1-byte recovery id, over
 * SHA256(hrp || data_words_as_bytes). The `1` separator is NOT part of the signed message.
 * Deterministic (RFC6979) signing makes the vectors reproducible byte for byte.
 */
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Bech32Error, bech32Decode, bech32Encode, bytesToWords, convertBits, wordsToBytes, BECH32M_CONST } from "./bech32.js";

export type Bolt11Network = "mainnet" | "testnet" | "signet" | "regtest";

export const NETWORK_PREFIX: Record<Bolt11Network, string> = {
  mainnet: "lnbc",
  testnet: "lntb",
  signet: "lntbs",
  regtest: "lnbcrt",
};

const ADDRESS_HRP: Record<Bolt11Network, string> = {
  mainnet: "bc",
  testnet: "tb",
  signet: "tb",
  regtest: "bcrt",
};

/** Tagged-field type indices are the bech32 charset index of the tag character. */
const TAG = { p: 1, s: 16, d: 13, m: 27, n: 19, h: 23, x: 6, c: 24, f: 9, r: 3, features: 5 } as const;

/** BOLT9 feature bits used by SatsLoom's default invoice feature set. */
export const FEATURE_BIT = {
  varOnionOptinOptional: 8,
  varOnionOptinRequired: 9,
  paymentSecretOptional: 14,
  paymentSecretRequired: 15,
  basicMppOptional: 16,
  basicMppRequired: 17,
} as const;

/**
 * The feature set the BOLT11 spec's own examples use: var_onion_optin optional (bit 8) and
 * payment_secret optional (bit 14) => 0x4100. Wallets rely on this to know they may attach a
 * payment secret, and it is what LND/CLN invoices typically advertise.
 */
export const DEFAULT_FEATURES = (1n << 8n) | (1n << 14n);

export const DEFAULT_EXPIRY_SECONDS = 3600;
export const DEFAULT_MIN_FINAL_CLTV_EXPIRY = 18;

export type Bolt11ErrorCode =
  | "invalid_encoding"
  | "invalid_checksum"
  | "invalid_signature"
  | "unsupported_network"
  | "invalid_amount"
  | "missing_field"
  | "duplicate_field"
  | "expired"
  | "not_payable";

export class Bolt11Error extends Error {
  readonly code: Bolt11ErrorCode;

  constructor(code: Bolt11ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "Bolt11Error";
    this.code = code;
  }
}

export type RoutingHint = {
  pubkey: string;
  shortChannelId: string;
  feeBaseMsat: bigint;
  feeProportionalMillionths: bigint;
  cltvExpiryDelta: number;
};

export type DecodedInvoice = {
  readonly invoice: string;
  readonly network: Bolt11Network;
  /** null when the invoice is amountless (a donation request). */
  readonly amountMsat: bigint | null;
  readonly timestamp: number;
  readonly paymentHash: string;
  readonly paymentSecret?: string;
  readonly payeePubkey?: string;
  /** Pubkey recovered from the signature; equals `payeePubkey` when both are present and honest. */
  readonly recoveredPayeePubkey?: string;
  readonly signatureValid: boolean;
  readonly description?: string;
  readonly descriptionHash?: string;
  readonly paymentMetadata?: string;
  readonly expirySeconds: number;
  /** Unix seconds at which the invoice stops being payable. */
  readonly expiresAt: number;
  readonly minFinalCltvExpiry: number;
  readonly features: bigint;
  readonly fallbackAddress?: string;
  readonly routingHints: RoutingHint[];
  readonly signature: string;
  readonly unknownTags: Array<{ type: number; words: number[] }>;
};

export type EncodeInvoiceInput = {
  readonly network: Bolt11Network;
  readonly amountMsat?: bigint | null;
  readonly paymentHash: Uint8Array | string;
  readonly paymentSecret?: Uint8Array | string;
  /** 32-byte secp256k1 private key of the payee node. Never logged, never persisted in the clear. */
  readonly payeePrivateKey: Uint8Array | string;
  readonly description?: string;
  readonly descriptionHash?: Uint8Array | string;
  readonly paymentMetadata?: Uint8Array | string;
  readonly timestamp?: number;
  /** Omit to leave the field out (wallets then assume 3600). SatsLoom always sets it explicitly. */
  readonly expirySeconds?: number;
  readonly minFinalCltvExpiry?: number;
  readonly features?: bigint;
  readonly fallbackAddress?: string;
  /**
   * Include the payee public key as an `n` tag (default true). Real invoices should: it lets a
   * payer verify the signature against a declared key instead of recovering whatever key the
   * signature happens to imply, and it gives routers a target. The BOLT11 specification's own
   * test vectors omit it, so the vector-reproduction tests set this to false.
   */
  readonly includePayeePubkey?: boolean;
};

/* ------------------------------------------------------------------ helpers */

function hexToBytes(value: Uint8Array | string, expectedBytes: number, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== expectedBytes) throw new Bolt11Error("invalid_encoding", `${label} must be ${expectedBytes} bytes`);
    return value;
  }
  if (!/^[0-9a-fA-F]*$/.test(value) || value.length !== expectedBytes * 2) {
    throw new Bolt11Error("invalid_encoding", `${label} must be ${expectedBytes} bytes of hex`);
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

/** Payment hash for a Lightning payment preimage: SHA256(preimage). */
export function paymentHashFromPreimage(preimage: Uint8Array | string): string {
  const bytes = typeof preimage === "string" ? hexToBytes(preimage, 32, "preimage") : hexToBytes(preimage, 32, "preimage");
  return toHex(sha256(bytes));
}

/**
 * The check a live rail must perform before crediting an invoice: the revealed preimage
 * must hash to the payment hash that was committed to in the invoice.
 */
export function verifyPreimage(preimage: Uint8Array | string, paymentHash: Uint8Array | string): boolean {
  try {
    const expected = typeof paymentHash === "string" ? paymentHash.toLowerCase() : toHex(paymentHash);
    return paymentHashFromPreimage(preimage) === expected;
  } catch {
    return false;
  }
}

/** Minimal big-endian base-32 digits of a non-negative integer. */
function integerToWords(value: bigint): number[] {
  if (value < 0n) throw new Bolt11Error("invalid_encoding", "integer fields must be non-negative");
  const words: number[] = [];
  let remaining = value;
  while (remaining > 0n) {
    words.unshift(Number(remaining & 31n));
    remaining >>= 5n;
  }
  if (!words.length) words.push(0);
  return words;
}

function wordsToInteger(words: readonly number[]): bigint {
  let value = 0n;
  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31) throw new Bolt11Error("invalid_encoding", "data words must be 0-31");
    value = (value << 5n) | BigInt(word);
  }
  return value;
}

/** Timestamps are a fixed 35 bits => exactly 7 words, zero-padded on the left. */
function timestampToWords(timestamp: number): number[] {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0x7ffffffff) {
    throw new Bolt11Error("invalid_encoding", "timestamp must be a non-negative 35-bit integer");
  }
  const words = integerToWords(BigInt(timestamp));
  while (words.length < 7) words.unshift(0);
  return words;
}

function tagWords(type: keyof typeof TAG | number, data: readonly number[]): number[] {
  const index = typeof type === "number" ? type : TAG[type];
  if (data.length > 1023) throw new Bolt11Error("invalid_encoding", "tagged field data exceeds 1023 words");
  return [index, (data.length >> 5) & 31, data.length & 31, ...data];
}

/** msat per amount unit, in tenths of a millisatoshi so `p` stays exact. */
const AMOUNT_UNITS: ReadonlyArray<readonly [string, bigint]> = [
  ["", 1_000_000_000_000n],
  ["m", 1_000_000_000n],
  ["u", 1_000_000n],
  ["n", 1_000n],
  ["p", 1n],
];

export function encodeAmount(amountMsat: bigint): string {
  if (amountMsat <= 0n) throw new Bolt11Error("invalid_amount", "amount must be positive");
  const tenths = amountMsat * 10n;
  for (const [multiplier, unitTenths] of AMOUNT_UNITS) {
    if (tenths % unitTenths === 0n && tenths / unitTenths > 0n) {
      return `${tenths / unitTenths}${multiplier}`;
    }
  }
  throw new Bolt11Error("invalid_amount", "amount cannot be represented exactly in BOLT11 units");
}

export function decodeAmount(amount: string): bigint {
  const match = amount.match(/^(\d+)([munp]?)$/);
  if (!match) throw new Bolt11Error("invalid_amount", `invalid amount in invoice: ${JSON.stringify(amount)}`);
  const [, digits, multiplier] = match;
  if (digits.length > 1 && digits.startsWith("0")) throw new Bolt11Error("invalid_amount", "amount has a leading zero");
  const unit = AMOUNT_UNITS.find(([letter]) => letter === multiplier);
  if (!unit) throw new Bolt11Error("invalid_amount", `unknown amount multiplier ${JSON.stringify(multiplier)}`);
  const tenths = BigInt(digits) * unit[1];
  if (tenths % 10n !== 0n) throw new Bolt11Error("invalid_amount", "amount has sub-millisatoshi precision");
  const amountMsat = tenths / 10n;
  if (amountMsat <= 0n) throw new Bolt11Error("invalid_amount", "amount must be positive");
  return amountMsat;
}

/* ------------------------------------------------------------------ address */

function encodeWitnessAddress(network: Bolt11Network, version: number, program: Uint8Array): string {
  const words = [version, ...bytesToWords(program)];
  return bech32Encode(ADDRESS_HRP[network], words, version === 0 ? undefined : BECH32M_CONST);
}

function decodeWitnessAddress(network: Bolt11Network, words: readonly number[]): string | undefined {
  if (words.length < 2) return undefined;
  const version = words[0];
  let program: Uint8Array;
  try {
    program = wordsToBytes(words.slice(1));
  } catch {
    return undefined;
  }
  if (program.length < 2 || program.length > 40) return undefined;
  return encodeWitnessAddress(network, version, program);
}

/* ------------------------------------------------------------------ decode */

function detectNetwork(hrp: string): { network: Bolt11Network; amount: string } {
  if (!hrp.startsWith("ln")) throw new Bolt11Error("unsupported_network", "invoice must start with the bech32 prefix \"ln\"");
  const rest = hrp.slice(2);
  const candidates: Array<[string, Bolt11Network]> = [
    ["bcrt", "regtest"],
    ["tbs", "signet"],
    ["bc", "mainnet"],
    ["tb", "testnet"],
  ];
  for (const [currency, network] of candidates) {
    if (rest.startsWith(currency)) return { network, amount: rest.slice(currency.length) };
  }
  throw new Bolt11Error("unsupported_network", `unsupported currency prefix in ${JSON.stringify(hrp)}`);
}

/**
 * The exact bytes BOLT11 signs: `hrp` as UTF-8 followed by the tagged data words regrouped
 * into bytes, with zero padding. Exported because a liveness audit should be able to
 * recompute it independently.
 */
export function invoiceSigningBytes(hrp: string, payloadWords: readonly number[]): Uint8Array {
  const hrpBytes = Uint8Array.from(Buffer.from(hrp, "utf8"));
  const dataBytes = Uint8Array.from(convertBits(payloadWords, 5, 8, true));
  const message = new Uint8Array(hrpBytes.length + dataBytes.length);
  message.set(hrpBytes, 0);
  message.set(dataBytes, hrpBytes.length);
  return message;
}

export function decodeInvoice(invoice: string, options: { verifySignature?: boolean } = {}): DecodedInvoice {
  const verifySignature = options.verifySignature ?? true;
  const normalised = invoice.trim();
  let decoded: ReturnType<typeof bech32Decode>;
  try {
    decoded = bech32Decode(normalised);
  } catch (error) {
    const code = error instanceof Bech32Error && /checksum/.test(error.message) ? "invalid_checksum" : "invalid_encoding";
    throw new Bolt11Error(code, `cannot decode invoice: ${(error as Error).message}`, { cause: error });
  }
  const { hrp, data } = decoded;
  const { network, amount } = detectNetwork(hrp);
  if (amount && !/^\d+[munp]?$/.test(amount)) throw new Bolt11Error("invalid_amount", `invalid amount in invoice: ${JSON.stringify(amount)}`);
  const amountMsat = amount ? decodeAmount(amount) : null;

  if (data.length < 7 + 104) throw new Bolt11Error("invalid_encoding", "invoice data part is too short");
  const signatureWords = data.slice(-104);
  const payloadWords = data.slice(0, -104);
  const timestamp = Number(wordsToInteger(payloadWords.slice(0, 7)));

  const fields: MutableInvoiceFields = { routingHints: [], unknownTags: [] };
  let index = 7;
  while (index < payloadWords.length) {
    if (index + 3 > payloadWords.length) throw new Bolt11Error("invalid_encoding", "truncated tagged field");
    const type = payloadWords[index];
    const length = (payloadWords[index + 1] << 5) | payloadWords[index + 2];
    const start = index + 3;
    const end = start + length;
    if (end > payloadWords.length) throw new Bolt11Error("invalid_encoding", "tagged field length exceeds data part");
    const words = payloadWords.slice(start, end);
    readTag(fields, type, words, network);
    index = end;
  }

  const signature = toHex(Uint8Array.from(convertBits(signatureWords, 5, 8, false)));
  const message = invoiceSigningBytes(hrp, payloadWords);
  const messageHash = sha256(message);
  const compactSignature = Uint8Array.from(Buffer.from(signature, "hex").subarray(0, 64));

  let signatureValid = false;
  let recoveredPayeePubkey: string | undefined;
  if (verifySignature) {
    // The invoice must carry a key: either the `n` tag or one recoverable from the signature.
    if (fields.payeePubkey) {
      try {
        signatureValid = secp256k1.verify(compactSignature, messageHash, Buffer.from(fields.payeePubkey, "hex"), { prehash: false });
      } catch {
        signatureValid = false;
      }
    }
    try {
      // Re-order into the form the recovery routine expects (recovery || r || s).
      const bolt11Order = Uint8Array.from(Buffer.from(signature, "hex"));
      const recoveryOrder = new Uint8Array(65);
      recoveryOrder[0] = bolt11Order[64];
      recoveryOrder.set(bolt11Order.subarray(0, 64), 1);
      recoveredPayeePubkey = toHex(secp256k1.recoverPublicKey(recoveryOrder, messageHash, { prehash: false }));
      // Without an `n` tag the recovered key is the only identity available, so a decoded
      // signature is valid by construction; callers that need assurance must check the `n` tag.
      if (!fields.payeePubkey) signatureValid = true;
    } catch {
      recoveredPayeePubkey = undefined;
    }
    if (!signatureValid) throw new Bolt11Error("invalid_signature", "invoice signature does not match the payee public key");
  }

  const expirySeconds = fields.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  return {
    invoice: normalised.toLowerCase(),
    network,
    amountMsat,
    timestamp,
    paymentHash: fields.paymentHash ?? "",
    paymentSecret: fields.paymentSecret,
    payeePubkey: fields.payeePubkey,
    recoveredPayeePubkey,
    signatureValid,
    description: fields.description,
    descriptionHash: fields.descriptionHash,
    paymentMetadata: fields.paymentMetadata,
    expirySeconds,
    expiresAt: timestamp + expirySeconds,
    minFinalCltvExpiry: fields.minFinalCltvExpiry ?? DEFAULT_MIN_FINAL_CLTV_EXPIRY,
    features: fields.features ?? 0n,
    fallbackAddress: fields.fallbackAddress,
    routingHints: fields.routingHints,
    signature,
    unknownTags: fields.unknownTags,
  } as DecodedInvoice;
}

type MutableInvoiceFields = {
  paymentHash?: string;
  paymentSecret?: string;
  payeePubkey?: string;
  description?: string;
  descriptionHash?: string;
  paymentMetadata?: string;
  expirySeconds?: number;
  minFinalCltvExpiry?: number;
  features?: bigint;
  fallbackAddress?: string;
  routingHints: RoutingHint[];
  unknownTags: Array<{ type: number; words: number[] }>;
};

function assignOnce(fields: MutableInvoiceFields, key: keyof MutableInvoiceFields, value: unknown, tagName: string) {
  if (fields[key] !== undefined) throw new Bolt11Error("duplicate_field", `invoice contains more than one ${tagName} field`);
  (fields as Record<string, unknown>)[key] = value;
}

function readTag(fields: MutableInvoiceFields, type: number, words: number[], network: Bolt11Network): void {
  switch (type) {
    case TAG.p:
      assignOnce(fields, "paymentHash", toHex(wordsToBytes(words)), "payment hash (p)");
      return;
    case TAG.s:
      assignOnce(fields, "paymentSecret", toHex(wordsToBytes(words)), "payment secret (s)");
      return;
    case TAG.n:
      assignOnce(fields, "payeePubkey", toHex(wordsToBytes(words)), "payee pubkey (n)");
      return;
    case TAG.d:
      assignOnce(fields, "description", Buffer.from(wordsToBytes(words)).toString("utf8"), "description (d)");
      return;
    case TAG.h:
      assignOnce(fields, "descriptionHash", toHex(wordsToBytes(words)), "description hash (h)");
      return;
    case TAG.m:
      assignOnce(fields, "paymentMetadata", toHex(wordsToBytes(words)), "payment metadata (m)");
      return;
    case TAG.x:
      assignOnce(fields, "expirySeconds", Number(wordsToInteger(words)), "expiry (x)");
      return;
    case TAG.c:
      assignOnce(fields, "minFinalCltvExpiry", Number(wordsToInteger(words)), "min_final_cltv_expiry (c)");
      return;
    case TAG.features:
      assignOnce(fields, "features", wordsToInteger(words), "features (9)");
      return;
    case TAG.f: {
      if (!words.length) throw new Bolt11Error("invalid_encoding", "empty fallback address (f)");
      const address = decodeWitnessAddress(network, words);
      assignOnce(fields, "fallbackAddress", address ?? `raw:${words.join(",")}`, "fallback address (f)");
      return;
    }
    case TAG.r: {
      if (words.length % 51 !== 0) throw new Bolt11Error("invalid_encoding", "routing hint (r) must be a multiple of 51 words");
      for (let offset = 0; offset < words.length; offset += 51) {
        const chunk = words.slice(offset, offset + 51);
        const pubkey = toHex(wordsToBytes(chunk.slice(0, 53)));
        const bytes = convertBits(chunk.slice(53), 5, 8, false);
        fields.routingHints.push({
          pubkey,
          shortChannelId: Buffer.from(bytes.slice(0, 8)).toString("hex"),
          feeBaseMsat: BigInt("0x" + Buffer.from(bytes.slice(8, 12)).toString("hex") || "0"),
          feeProportionalMillionths: BigInt("0x" + Buffer.from(bytes.slice(12, 16)).toString("hex") || "0"),
          cltvExpiryDelta: Number(BigInt("0x" + Buffer.from(bytes.slice(16, 18)).toString("hex") || "0")),
        });
      }
      return;
    }
    default:
      fields.unknownTags.push({ type, words });
  }
}

/* ------------------------------------------------------------------ encode */

/**
 * Build a real, signed BOLT11 invoice. Field order matches the specification's examples
 * (s, p, d/h, x, c, 9, f) so that encoder output is byte-identical to the reference vectors
 * for the same inputs, which is what the test suite asserts.
 */
export function encodeInvoice(input: EncodeInvoiceInput): DecodedInvoice {
  const { network } = input;
  const prefix = NETWORK_PREFIX[network];
  if (!prefix) throw new Bolt11Error("unsupported_network", `unsupported network ${String(network)}`);
  const amountWords = input.amountMsat != null ? encodeAmount(input.amountMsat) : "";
  const hrp = `${prefix}${amountWords}`;

  const paymentHash = hexToBytes(input.paymentHash, 32, "paymentHash");
  const privateKey = hexToBytes(input.payeePrivateKey, 32, "payeePrivateKey");
  if (input.description && input.descriptionHash) {
    throw new Bolt11Error("invalid_encoding", "provide either a description or a description hash, not both");
  }

  const words: number[] = timestampToWords(input.timestamp ?? Math.floor(Date.now() / 1000));
  if (input.paymentSecret) words.push(...tagWords("s", bytesToWords(hexToBytes(input.paymentSecret, 32, "paymentSecret"))));
  words.push(...tagWords("p", bytesToWords(paymentHash)));
  if (input.descriptionHash) {
    words.push(...tagWords("h", bytesToWords(hexToBytes(input.descriptionHash, 32, "descriptionHash"))));
  } else {
    const description = input.description ?? "";
    words.push(...tagWords("d", bytesToWords(Uint8Array.from(Buffer.from(description, "utf8")))));
  }
  if (input.paymentMetadata) {
    words.push(...tagWords("m", bytesToWords(typeof input.paymentMetadata === "string" ? Uint8Array.from(Buffer.from(input.paymentMetadata, "hex")) : input.paymentMetadata)));
  }
  if (input.expirySeconds !== undefined) {
    if (!Number.isInteger(input.expirySeconds) || input.expirySeconds <= 0) {
      throw new Bolt11Error("invalid_encoding", "expirySeconds must be a positive integer");
    }
    words.push(...tagWords("x", integerToWords(BigInt(input.expirySeconds))));
  }
  if (input.minFinalCltvExpiry !== undefined) {
    words.push(...tagWords("c", integerToWords(BigInt(input.minFinalCltvExpiry))));
  }
  const features = input.features ?? DEFAULT_FEATURES;
  words.push(...tagWords("features", integerToWords(features)));
  if (input.includePayeePubkey !== false) {
    const payeePubkey = Uint8Array.from(secp256k1.getPublicKey(privateKey, true));
    words.push(...tagWords("n", bytesToWords(payeePubkey)));
  }
  if (input.fallbackAddress) {
    const [version, program] = decodeAddress(input.fallbackAddress);
    words.push(...tagWords("f", [version, ...bytesToWords(program)]));
  }

  const messageHash = sha256(invoiceSigningBytes(hrp, words));
  const noble = Uint8Array.from(secp256k1.sign(messageHash, privateKey, { prehash: false, lowS: true, format: "recovered" }));
  if (noble.length !== 65) throw new Bolt11Error("invalid_signature", "expected a 65-byte recoverable signature");
  // noble returns recovery || r || s; BOLT11 specifies r || s || recovery. Byte order matters:
  // a signature in the wrong order fails every other implementation's verification.
  const signature = new Uint8Array(65);
  signature.set(noble.subarray(1), 0);
  signature[64] = noble[0];
  const invoice = bech32Encode(hrp, [...words, ...bytesToWords(signature)]);
  return decodeInvoice(invoice, { verifySignature: true });
}

/**
 * Parse a fallback on-chain address into (witness version, program). BIP-350 splits these by
 * checksum constant: v0 uses bech32, v1+ uses bech32m. Accepting the wrong constant would let
 * an unspendable or mistyped address be committed into a signed invoice, so the pairing is
 * enforced rather than tolerated.
 */
function decodeAddress(address: string): [number, Uint8Array] {
  let decoded: ReturnType<typeof bech32Decode> | undefined;
  let constant = 1;
  for (const candidate of [1, BECH32M_CONST]) {
    try {
      decoded = bech32Decode(address, candidate);
      constant = candidate;
      break;
    } catch {
      decoded = undefined;
    }
  }
  if (!decoded || !decoded.data.length) throw new Bolt11Error("invalid_encoding", `invalid fallback address ${address}`);
  const version = decoded.data[0];
  if (version > 16) throw new Bolt11Error("invalid_encoding", `invalid witness version in ${address}`);
  const expectedConstant = version === 0 ? 1 : BECH32M_CONST;
  if (constant !== expectedConstant) {
    throw new Bolt11Error("invalid_encoding", `witness v${version} address must use ${version === 0 ? "bech32" : "bech32m"}`);
  }
  const program = wordsToBytes(decoded.data.slice(1));
  if (program.length < 2 || program.length > 40) throw new Bolt11Error("invalid_encoding", `invalid witness program length in ${address}`);
  return [version, program];
}

/* ------------------------------------------------------------------ helpers */

export function isExpired(invoice: DecodedInvoice, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return invoice.expiresAt <= nowSeconds;
}

export function hasFeature(invoice: DecodedInvoice, bit: number): boolean {
  return ((invoice.features >> BigInt(bit)) & 1n) === 1n;
}

/** Present the amount in the amount the invoice commits to, or throw when it is amountless. */
export function requireAmountMsat(invoice: DecodedInvoice): bigint {
  if (invoice.amountMsat === null) throw new Bolt11Error("not_payable", "invoice is amountless and cannot be matched to a fixed amount");
  return invoice.amountMsat;
}

export { Bech32Error } from "./bech32.js";
