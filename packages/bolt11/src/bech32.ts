/**
 * bech32 (BIP-0173) with the BOLT11 deviations, implemented here rather than pulled in
 * because BOLT11 needs two things most bech32 libraries do not expose:
 *
 *   1. No 90-character limit. Real invoices are 200-1000+ characters and MUST be readable.
 *   2. Raw access to the 5-bit data words, because BOLT11 puts a 520-bit signature and
 *      variable-width tagged fields inside them.
 *
 * Correctness is proven against the BOLT11 test vectors in index.test.ts, including the
 * spec's own signing-preimage hex and SHA256, so both the checksum and the word handling
 * are checked against the reference implementation's output rather than against itself.
 */

export const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_REV: number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < CHARSET.length; i += 1) table[CHARSET.charCodeAt(i)] = i;
  return table;
})();

const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;

export class Bech32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Bech32Error";
  }
}

function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) checksum ^= GENERATOR[i];
    }
  }
  return checksum >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const output: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) output.push(hrp.charCodeAt(i) >> 5);
  output.push(0);
  for (let i = 0; i < hrp.length; i += 1) output.push(hrp.charCodeAt(i) & 31);
  return output;
}

function checksumWords(hrp: string, data: readonly number[], constant: number): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = (polymod(values) ^ constant) >>> 0;
  const words: number[] = [];
  for (let i = 0; i < 6; i += 1) words.push((mod >> (5 * (5 - i))) & 31);
  return words;
}

/** Encode data words (values 0-31) under `hrp`. Returns lowercase. */
export function bech32Encode(hrp: string, data: readonly number[], constant = BECH32_CONST): string {
  if (!hrp.length || hrp.length > 83) throw new Bech32Error("hrp must be 1-83 characters");
  if (/[^\x21-\x7e]/.test(hrp)) throw new Bech32Error("hrp must be printable ASCII");
  const lowerHrp = hrp.toLowerCase();
  for (const word of data) {
    if (!Number.isInteger(word) || word < 0 || word > 31) throw new Bech32Error("data words must be integers 0-31");
  }
  const words = [...data, ...checksumWords(lowerHrp, data, constant)];
  let output = `${lowerHrp}1`;
  for (const word of words) output += CHARSET[word];
  return output;
}

export type Bech32Decoded = { hrp: string; data: number[]; constant: number };

/**
 * Decode a bech32/bech32m string. Case-insensitive input, lowercase output, no length limit.
 * `data` excludes the 6-character checksum.
 */
export function bech32Decode(input: string, expectedConstant?: number): Bech32Decoded {
  if (typeof input !== "string") throw new Bech32Error("input must be a string");
  if (input.length < 8) throw new Bech32Error("input is too short to be bech32");
  if (input.length > 4096) throw new Bech32Error("input is longer than this implementation accepts (4096)");
  const hasLower = /[a-z]/.test(input);
  const hasUpper = /[A-Z]/.test(input);
  if (hasLower && hasUpper) throw new Bech32Error("mixed-case input is invalid");
  const normalised = input.toLowerCase();
  const separator = normalised.lastIndexOf("1");
  if (separator < 1) throw new Bech32Error("missing bech32 separator");
  if (separator + 7 > normalised.length) throw new Bech32Error("missing bech32 checksum");
  const hrp = normalised.slice(0, separator);
  const words: number[] = [];
  for (let i = separator + 1; i < normalised.length; i += 1) {
    const code = normalised.charCodeAt(i);
    const value = code < 128 ? CHARSET_REV[code] : -1;
    if (value === -1) throw new Bech32Error(`invalid bech32 character at position ${i}`);
    words.push(value);
  }
  const payload = words.slice(0, -6);
  const suppliedChecksum = words.slice(-6);
  const constant = expectedConstant ?? BECH32_CONST;
  const expected = checksumWords(hrp, payload, constant);
  for (let i = 0; i < 6; i += 1) {
    if (suppliedChecksum[i] !== expected[i]) throw new Bech32Error("invalid bech32 checksum");
  }
  return { hrp, data: payload, constant };
}

/**
 * Regroup bits between word sizes. `pad` controls whether trailing bits are padded
 * (8->5 for encoding bytes) or dropped-and-required-to-be-zero (5->8 for decoding).
 */
export function convertBits(data: readonly number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  const maxValue = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (!Number.isInteger(value) || value < 0 || value >> fromBits !== 0) {
      throw new Bech32Error(`value ${value} does not fit in ${fromBits} bits`);
    }
    accumulator = ((accumulator << fromBits) | value) & maxAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      output.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) output.push((accumulator << (toBits - bits)) & maxValue);
  } else if (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue) !== 0) {
    throw new Bech32Error("invalid padding in bech32 data");
  }
  return output;
}

export function bytesToWords(bytes: Uint8Array | readonly number[]): number[] {
  return convertBits(Array.from(bytes), 8, 5, true);
}

/** Convert words back to bytes, rejecting non-zero padding — used for hashes and pubkeys. */
export function wordsToBytes(words: readonly number[]): Uint8Array {
  return Uint8Array.from(convertBits(words, 5, 8, false));
}
