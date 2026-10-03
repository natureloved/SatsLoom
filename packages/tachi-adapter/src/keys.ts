/**
 * Key material handling.
 *
 * Rules from docs/architecture.md, enforced here rather than by convention:
 *  - Mnemonics never leave the server. Nothing in this module is exported through the API.
 *  - A derived identity exposes its public material freely and its signer only as an opaque
 *    object that the caller cannot introspect into a mnemonic.
 *  - The same derivation the daemon uses (`m/84'/coin'/0'/0/index`, p2wpkh, BIP-84) is what
 *    produces the account key, so a key derived here is byte-identical to the daemon's view of
 *    the same account. `deriveUserKey()` is the SDK's own implementation of that rule; we do not
 *    re-implement derivation.
 */
import { readFileSync } from "node:fs";
import {
  Keystore,
  normalizeMnemonic,
  SUPPORTED_WALLET_CHAINS,
  validateMnemonic,
  type NetworkConfig,
  type WalletChainName,
} from "@tachibtc/taurus-wallet-aggregator";
import { deriveUserKey, normalizeTaprootSigner, resolveWalletNetwork, userKeyMatches } from "@tachibtc/taurus-vault-core";
import type { PaymentTarget } from "@satsloom/shared";
import { KeyMaterialError } from "./errors.js";

/**
 * The account key pair used for one role (merchant, demo payer, refund target).
 *
 * `xOnly` is the ledger owner key: VTXOs on the Tachi ledger are credited to a 32-byte x-only
 * pubkey, which is also what `outputs[].owner` carries on a transfer.
 */
export type Identity = {
  /** 32-byte x-only owner key, hex. This is the ledger identity. */
  xOnly: string;
  /** 33-byte compressed pubkey, hex. The vault's owner key. */
  compressed: string;
  /** BIP-84 receive address for the same key (p2wpkh) — the funding address. */
  address: string;
  /** Full derivation record; persisted with a vault so it is never ambiguous. */
  descriptor: {
    path: string;
    publicKey: string;
    address: string;
    addressType: string;
    masterFingerprint: string;
    network: string;
    account: number;
    index: number;
  };
  /** Opaque signing handle. Deliberately not typed as anything a caller can unwrap. */
  signer: unknown;
};

/**
 * BIP-39 test vectors are the only mnemonics safe to ship in .env.example, CI or a screenshot.
 * Recognising them lets the UI warn "this is a published test key" instead of implying safety.
 */
export function isTestMnemonic(mnemonic: string): boolean {
  const normalized = normalizeMnemonic(mnemonic.trim());
  return (
    /^abandon( abandon)+ about$/.test(normalized) ||
    /^legal winner thank year wave sausage worth useful legal winner thank yellow$/.test(normalized) ||
    /^letter advice cage absurd amount doctor acoustic avoid letter advice cage above$/.test(normalized)
  );
}

export function assertUsableMnemonic(mnemonic: string): string {
  const normalized = normalizeMnemonic(mnemonic.trim());
  if (!validateMnemonic(normalized)) {
    throw new KeyMaterialError("Mnemonic failed BIP-39 checksum validation", { words: normalized.split(" ").length });
  }
  return normalized;
}

/**
 * Load a mnemonic from either an env var or a `*_FILE` path.
 *
 * File support matters for deployment: Fly/Render secrets and Docker secrets are mounted as
 * files, and an operator should not have to paste a mnemonic into a process listing.
 */
export function loadMnemonic(envName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env[envName];
  if (direct && direct.trim()) return assertUsableMnemonic(direct);
  const file = env[`${envName}_FILE`];
  if (file && file.trim()) {
    try {
      return assertUsableMnemonic(readFileSync(file, "utf8"));
    } catch (error) {
      throw new KeyMaterialError(`Could not read ${envName}_FILE`, { file, cause: String(error) });
    }
  }
  return null;
}

/** Network config for the vault SDKs. Regtest is the hackathon target; signet/mainnet accepted. */
export function walletNetwork(name: string): NetworkConfig {
  const normalized = name.toLowerCase();
  try {
    return resolveWalletNetwork(normalized as WalletChainName);
  } catch {
    throw new KeyMaterialError(
      `Unsupported wallet network "${name}". The Taurus wallet SDK supports ${SUPPORTED_WALLET_CHAINS.join(" and ")}; SatsLoom targets regtest.`,
    );
  }
}

export type IdentityOptions = { index?: number; account?: number; network?: string };

/**
 * Derive an identity from a mnemonic.
 *
 * Uses the aggregator's `Keystore` for signing (the same object the SDK normalises into a
 * BIP-340 signer) and vault-core's `deriveUserKey` for the public record, then cross-checks the
 * two: if they ever disagree, building a vault from this identity would produce an address the
 * daemon cannot reconstruct, so we fail loudly here instead.
 */
export function identityFromMnemonic(mnemonic: string, options: IdentityOptions = {}): Identity {
  const normalized = assertUsableMnemonic(mnemonic);
  const network = walletNetwork(options.network ?? "regtest");
  const account = options.account ?? 0;
  const index = options.index ?? 0;

  let descriptor;
  try {
    descriptor = deriveUserKey(normalized, network, { account, index });
  } catch (error) {
    throw new KeyMaterialError("Could not derive a user key for this mnemonic", { cause: String(error) });
  }

  let keystore: Keystore;
  try {
    keystore = Keystore.fromMnemonic(normalized, "", network, "p2wpkh", account);
  } catch (error) {
    throw new KeyMaterialError("Could not open the keystore for this mnemonic", { cause: String(error) });
  }

  const node = keystore.signerFor(false, index);
  const compressed = Buffer.from(node.publicKey).toString("hex");

  if (!userKeyMatches(descriptor, compressed)) {
    throw new KeyMaterialError(
      "Derivation mismatch: the signing key does not match the derived descriptor. Refusing to operate on an ambiguous identity.",
      { derived: descriptor.publicKey, signer: compressed },
    );
  }

  const signer = normalizeTaprootSigner(node as unknown as Parameters<typeof normalizeTaprootSigner>[0]);
  keystore.lock();

  return {
    xOnly: descriptor.publicKey.length === 66 ? descriptor.publicKey.slice(2) : descriptor.publicKey,
    compressed,
    address: descriptor.address,
    descriptor: {
      path: descriptor.path,
      publicKey: descriptor.publicKey,
      address: descriptor.address,
      addressType: String(descriptor.addressType),
      masterFingerprint: descriptor.masterFingerprint,
      network: descriptor.network,
      account: descriptor.account,
      index: descriptor.index,
    },
    signer,
  };
}

/** Public half of an identity — the only part that may cross into the browser. */
export function paymentTargetFor(identity: Identity, extra: Partial<PaymentTarget> = {}): PaymentTarget {
  return { owner: identity.xOnly, address: identity.address, ...extra };
}

export function shortKey(hex: string, size = 6): string {
  if (hex.length <= size * 2 + 2) return hex;
  return `${hex.slice(0, size)}…${hex.slice(-size)}`;
}
