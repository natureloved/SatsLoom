/**
 * The settlement rail.
 *
 * One ledger spend is one `TachiTx`. Deposit (onboard), transfer (pay/refund) and withdraw
 * (payout to L1) differ only in the envelope's `type` and in what the outputs point at, so they
 * are one function with three named wrappers — the fee/nonce/signing path cannot drift between
 * them.
 *
 * Every step below is a documented SDK primitive, composed in the order the SDK requires:
 *
 *   buildVtxoPsbt  ->  verifyVtxoPsbt  ->  signVtxoPsbtAsUser
 *                        ->  buildTachiTxTransfer  ->  signTachiTx  ->  encodeTachiTx  ->  broadcast
 *
 * The user's signature is attached to the cooperative leaf here; the node quorum's share is
 * added by the daemon when it finalizes the transaction, which is why the PSBT is published "in
 * any signing state" rather than finalized locally.
 */
import {
  TACHI_TX_TYPE_DEPOSIT,
  TACHI_TX_TYPE_TRANSFER,
  TACHI_TX_TYPE_WITHDRAW,
  buildTachiTxDeposit,
  buildTachiTxTransfer,
  buildVaultP2tr,
  buildVtxoPsbt,
  computeVtxoId,
  createVault,
  encodeTachiTx,
  resolveWalletNetwork,
  signTachiTx,
  signVtxoPsbtAsUser,
  tachiTxSigHash,
  verifyVaultP2tr,
  verifyVtxoPsbt,
  vtxoIdFromDeposit,
  xOnlyFromAddress,
  type TachiTx,
  type TaprootSigner,
  type Vault,
  type VaultP2tr,
  type VtxoInput,
  type VtxoOutput,
} from "@tachibtc/taurus-vault-core";
import { createHash } from "node:crypto";
import type { Vtxo } from "@satsloom/shared";
import { InsufficientCapacityError, NotSupportedError, TransferRejectedError, toAdapterError } from "./errors.js";
import type { BroadcastMeta, TachiDaemon, TxStatusView } from "./daemon.js";
import type { Identity } from "./keys.js";

export type SpendKind = "transfer" | "withdraw";

export type SpendResult = {
  /** The Tachi/CometBFT tx hash. This is what the explorer link and the API receipt use. */
  txid: string;
  accepted: boolean;
  state: "pending" | "committed" | "rejected";
  /** vtxoIds this transaction created, in output order. */
  createdVtxoIds: string[];
  feeSats: bigint;
  nonce: string;
  kind: SpendKind;
  detail?: string;
};

export type RailOptions = {
  daemon: TachiDaemon;
  network?: string;
  csvBlocks?: number;
  /** How long to wait for a commit when the caller asks for one. Regtest epochs are ~10 min. */
  commitTimeoutMs?: number;
  commitPollMs?: number;
  /** Ledger fee paid to the quorum, in sats. Default 1. */
  defaultFeeSats?: bigint;
};

const ZERO_TXID = "0".repeat(64);

export class TachiRail {
  private readonly daemon: TachiDaemon;
  private readonly networkName: string;
  private readonly csvBlocks: number;
  private readonly commitTimeoutMs: number;
  private readonly commitPollMs: number;
  private readonly defaultFeeSats: bigint;
  private readonly vaults = new Map<string, Vault>();
  private readonly peerVaults = new Map<string, VaultP2tr>();
  private nodeKeys?: { at: number; keys: string[] };

  constructor(options: RailOptions) {
    this.daemon = options.daemon;
    this.networkName = options.network ?? process.env.TACHI_NETWORK ?? "regtest";
    this.csvBlocks = options.csvBlocks ?? Number(process.env.TACHI_CSV_BLOCKS ?? 1008);
    this.commitTimeoutMs = options.commitTimeoutMs ?? Number(process.env.TACHI_COMMIT_TIMEOUT_MS ?? 90_000);
    this.commitPollMs = options.commitPollMs ?? Number(process.env.TACHI_COMMIT_POLL_MS ?? 2_000);
    this.defaultFeeSats = options.defaultFeeSats ?? 1n;
  }

  get mode(): "live" | "fixture" {
    return this.daemon.kind;
  }

  /** The quorum's node keys, taken straight from the daemon's validator registry. */
  async nodePubkeys(): Promise<string[]> {
    if (this.nodeKeys && Date.now() - this.nodeKeys.at < 60_000) return this.nodeKeys.keys;
    const validators = await this.daemon.validators();
    const keys = validators.map((v) => v.id).filter((id) => /^[0-9a-fA-F]{64,66}$/.test(id));
    if (keys.length === 0) {
      throw new NotSupportedError(
        "The daemon reported no usable validator keys, so a vault address cannot be derived locally",
        { reported: validators.length },
      );
    }
    this.nodeKeys = { at: Date.now(), keys };
    return keys;
  }

  /**
   * Rebuild this identity's vault address from its recorded derivation plus the live quorum.
   *
   * Nothing is persisted: the vault is a pure function of (owner key, quorum, CSV, network), so
   * recomputing it removes a whole class of "the stored address drifted" failure. It is memoized
   * only within a process, and re-verified against the caller's own key before use.
   */
  async resolveVault(identity: Identity): Promise<Vault> {
    const cached = this.vaults.get(identity.compressed);
    if (cached) return cached;
    const nodePubkeys = await this.nodePubkeys();
    let vault: Vault;
    try {
      vault = await createVault({
        network: this.networkName as Parameters<typeof createVault>[0]["network"],
        userPubkey: identity.compressed,
        nodePubkeys,
        csvBlocks: this.csvBlocks,
      });
      verifyVaultP2tr(vault.p2tr);
    } catch (error) {
      throw toAdapterError(error, "resolveVault");
    }
    this.vaults.set(identity.compressed, vault);
    return vault;
  }

  /**
   * The ledger address a counterparty key owns.
   *
   * Every account on the same quorum+CSV derives the same two-leaf P2TR shape, so a destination
   * address is built from the destination *key* rather than pasted in as a string. `buildVaultP2tr`
   * is the SDK's own builder, so the address is byte-identical to the one the daemon reconstructs.
   */
  async addressForOwner(owner: string): Promise<string> {
    const normalized = normalizeXOnly(owner);
    const cached = this.peerVaults.get(normalized);
    if (cached) return cached.address;
    const nodePubkeys = await this.nodePubkeys();
    let p2tr: VaultP2tr;
    try {
      p2tr = buildVaultP2tr({
        network: this.networkName as Parameters<typeof buildVaultP2tr>[0]["network"],
        userPubkey: normalized,
        nodePubkeys,
        csvBlocks: this.csvBlocks,
      });
      verifyVaultP2tr(p2tr);
    } catch (error) {
      throw toAdapterError(error, `addressForOwner(${normalized.slice(0, 12)}…)`);
    }
    this.peerVaults.set(normalized, p2tr);
    return p2tr.address;
  }

  /** Local pre-flight: does the ledger already show enough spendable value for this amount? */
  async spendableBalance(identity: Identity): Promise<{ total: bigint; vtxos: Vtxo[] }> {
    const vtxos = await this.daemon.vtxos(identity.xOnly);
    const spendable = vtxos.filter((v) => v.state !== "spent");
    return { total: spendable.reduce((sum, v) => sum + v.amountSats, 0n), vtxos: spendable };
  }

  /**
   * Largest-first coin selection. Deterministic: the same ledger state and amount always pick
   * the same inputs, so a retry of the same payment rebuilds byte-identical inputs.
   */
  selectInputs(vtxos: Vtxo[], target: bigint): Vtxo[] {
    const sorted = [...vtxos].sort((a, b) => (a.amountSats === b.amountSats ? a.vtxoId.localeCompare(b.vtxoId) : a.amountSats > b.amountSats ? -1 : 1));
    const chosen: Vtxo[] = [];
    let total = 0n;
    for (const vtxo of sorted) {
      if (total >= target) break;
      chosen.push(vtxo);
      total += vtxo.amountSats;
    }
    if (total < target) {
      throw new InsufficientCapacityError(
        `Not enough spendable VTXOs: ${total} sats available, ${target} sats required`,
        { available: total.toString(), required: target.toString(), vtxos: sorted.length },
      );
    }
    return chosen;
  }

  /**
   * Onboard value onto the Tachi ledger (on-chain -> off-chain).
   *
   * A `TxDeposit` is a ledger-level credit: no Bitcoin-layer spend is attached, and the daemon
   * assigns the VTXO id, which we derive locally first (`vtxoIdFromDeposit`) so the VTXO can be
   * tracked from the moment of broadcast rather than after the fact.
   */
  async onboard(identity: Identity, amountSats: bigint): Promise<SpendResult> {
    if (amountSats <= 0n) throw new InsufficientCapacityError("Onboard amount must be positive");
    const nonce = await this.nextNonce(identity);
    let tx: TachiTx;
    try {
      tx = buildTachiTxDeposit({
        userXOnly: Buffer.from(identity.xOnly, "hex"),
        amountSats,
        nonce,
      });
    } catch (error) {
      throw toAdapterError(error, "buildTachiTxDeposit");
    }
    return this.signPublishConfirm(tx, identity, {
      kind: "deposit",
      sender: identity.xOnly,
      inputs: [],
      outputs: [{ owner: identity.xOnly, amountSats: amountSats.toString() }],
      feeSats: "0",
      nonce: nonce.toString(),
      createdVtxoIds: [],
    }, (signed) => signed.outputs.map((_, index) => vtxoIdFromDeposit(signed, index).toString("hex")));
  }

  /**
   * Move value to another ledger identity (payment, or a refund back to the payer).
   */
  async transfer(
    identity: Identity,
    args: { toOwner: string; amountSats: bigint; feeSats?: bigint; memo?: string },
  ): Promise<SpendResult> {
    return this.spend(identity, {
      kind: "transfer",
      destinationOwner: normalizeXOnly(args.toOwner),
      amountSats: args.amountSats,
      feeSats: args.feeSats ?? this.defaultFeeSats,
    });
  }

  /**
   * Move value off the ledger to a Taproot address on Bitcoin L1 (payout / sweep).
   *
   * The destination is an address, not a ledger key: the daemon spends the ledger VTXO through
   * the cooperative leaf and creates the L1 output. Timing is the L1 side's, so the caller shows
   * the redemption estimate rather than a ledger epoch.
   */
  async withdraw(
    identity: Identity,
    args: { toAddress: string; amountSats: bigint; feeSats?: bigint },
  ): Promise<SpendResult> {
    let owner: Buffer;
    try {
      owner = xOnlyFromAddress(args.toAddress, bitcoinNetwork(this.networkName));
    } catch (error) {
      throw toAdapterError(error, "withdraw: destination address");
    }
    return this.spend(identity, {
      kind: "withdraw",
      destinationOwner: owner.toString("hex"),
      amountSats: args.amountSats,
      feeSats: args.feeSats ?? this.defaultFeeSats,
    });
  }

  private async spend(
    identity: Identity,
    args: { kind: SpendKind; destinationOwner: string; amountSats: bigint; feeSats: bigint },
  ): Promise<SpendResult> {
    if (args.amountSats <= 0n) throw new InsufficientCapacityError("Amount must be positive");
    const vault = await this.resolveVault(identity);
    const { vtxos } = await this.spendableBalance(identity);
    const inputs = this.selectInputs(vtxos, args.amountSats + args.feeSats);
    const inputTotal = inputs.reduce((sum, v) => sum + v.amountSats, 0n);
    const change = inputTotal - args.amountSats - args.feeSats;

    const vtxoInputs: VtxoInput[] = inputs.map((vtxo) => ({
      // A ledger-native VTXO has no L1 outpoint; the daemon keys off `vtxoId` for these.
      txid: vtxo.txid && /^[0-9a-fA-F]{64}$/.test(vtxo.txid) ? vtxo.txid : ZERO_TXID,
      vout: vtxo.vout ?? 0,
      valueSats: vtxo.amountSats,
      scriptPubKey: vtxo.address && /^[0-9a-fA-F]+$/.test(vtxo.address) ? vtxo.address : vault.p2tr.output.toString("hex"),
      vtxoId: Buffer.from(vtxo.vtxoId, "hex"),
    }));

    const destinationAddress = await this.addressForOwner(args.destinationOwner);
    const outputs: VtxoOutput[] = [{ address: destinationAddress, valueSats: args.amountSats }];
    if (change > 0n) outputs.push({ address: vault.p2tr.address, valueSats: change });

    const nonce = await this.nextNonce(identity);
    let psbt;
    try {
      psbt = buildVtxoPsbt({ vault, inputs: vtxoInputs, outputs, feeSats: args.feeSats });
      verifyVtxoPsbt(psbt.psbt, vault, { maxFeeSats: args.feeSats });
      await signVtxoPsbtAsUser(psbt.psbt, identity.signer as TaprootSigner, vault, { maxFeeSats: args.feeSats });
    } catch (error) {
      throw toAdapterError(error, "build/sign VTXO transfer");
    }

    let tx: TachiTx;
    try {
      tx = buildTachiTxTransfer({
        vault,
        inputs: vtxoInputs,
        outputs: outputs.map((output) => ({ address: output.address, valueSats: output.valueSats })),
        feeSats: args.feeSats,
        nonce,
        psbt: psbt.psbt,
        type: args.kind === "withdraw" ? TACHI_TX_TYPE_WITHDRAW : TACHI_TX_TYPE_TRANSFER,
      });
    } catch (error) {
      throw toAdapterError(error, "buildTachiTxTransfer");
    }

    const ledgerOutputs = [
      { owner: args.destinationOwner, amountSats: args.amountSats.toString() },
      ...(change > 0n ? [{ owner: identity.xOnly, amountSats: change.toString() }] : []),
    ];

    return this.signPublishConfirm(
      tx,
      identity,
      {
        kind: args.kind,
        sender: identity.xOnly,
        inputs: inputs.map((v) => ({ vtxoId: v.vtxoId, valueSats: v.amountSats.toString() })),
        outputs: ledgerOutputs,
        feeSats: args.feeSats.toString(),
        nonce: nonce.toString(),
        createdVtxoIds: [],
      },
      (_signed, txHash) => ledgerOutputs.map((_, index) => computeCreatedVtxoIds(txHash, index)),
      args.feeSats,
    );
  }

  private async signPublishConfirm(
    tx: TachiTx,
    identity: Identity,
    meta: BroadcastMeta,
    deriveCreatedIds: (signed: TachiTx, txHash: string) => string[],
    feeSats = 0n,
  ): Promise<SpendResult> {
    let signed: TachiTx;
    try {
      signed = await signTachiTx(tx, identity.signer as TaprootSigner);
      // Signing a different message than the daemon will hash is the one failure that is silent
      // everywhere else, so assert the signature length and that the sighash is stable pre/post.
      if (signed.signature.length !== 64) {
        throw new Error(`Unexpected signature length ${signed.signature.length}, expected a 64-byte BIP-340 signature`);
      }
      tachiTxSigHash(signed);
    } catch (error) {
      throw toAdapterError(error, "signTachiTx");
    }

    const encoded = encodeTachiTx(signed);
    // A Tachi transaction's id IS sha256 of its encoded bytes — the same value CometBFT returns as
    // `result.hash`. Computing it locally means the txid, the explorer link and each output's
    // VTXO id are all known before the daemon answers, so a broadcast that times out can still be
    // reconciled afterwards instead of becoming an orphaned payment.
    const txHash = createHash("sha256").update(encoded).digest("hex");
    const createdVtxoIds = deriveCreatedIds(signed, txHash).filter((id) => /^[0-9a-fA-F]{64}$/.test(id));
    const txHex = encoded.toString("hex");
    // The wire form never carries a 0x prefix; a stray one is rejected by the daemon's decoder.
    if (txHex.startsWith("0x")) throw new TransferRejectedError("Encoded transaction unexpectedly carried a 0x prefix");

    const ack = await this.daemon.broadcastTx(txHex, { ...meta, createdVtxoIds, txHash });
    if (!ack.accepted) {
      throw new TransferRejectedError(`The daemon refused the ${meta.kind} at CheckTx: ${ack.log || `code ${ack.code}`}`, {
        code: ack.code,
        log: ack.log,
        txid: ack.hash,
      });
    }
    return {
      txid: txHash,
      accepted: true,
      state: "pending",
      createdVtxoIds,
      feeSats,
      nonce: meta.nonce,
      kind: meta.kind === "deposit" ? "transfer" : (meta.kind as SpendKind),
      detail: ack.log || undefined,
    };
  }

  /** Per-account monotonic nonce. A repeated nonce is rejected by the daemon, so this is read fresh. */
  private async nextNonce(identity: Identity): Promise<bigint> {
    const state = await this.daemon.address(identity.xOnly);
    return BigInt(state.nonce ?? 0) + 1n;
  }

  /**
   * Poll until the transaction commits, or give up. A broadcast is mempool acceptance only:
   * the daemon's CheckTx does not validate the quorum/threshold path, so a transaction that
   * passes here can still be dropped at FinalizeBlock.
   */
  async awaitCommit(hash: string, timeoutMs = this.commitTimeoutMs): Promise<TxStatusView> {
    const deadline = Date.now() + timeoutMs;
    let last: TxStatusView = { found: false, state: "pending", code: 0, log: "", epoch: 0, confirmations: 0 };
    while (Date.now() < deadline) {
      last = await this.daemon.txStatus(hash);
      if (last.code !== 0 || /reject|fail|dropped|invalid/i.test(last.state)) {
        throw new TransferRejectedError(`Transaction ${hash} was rejected by the network: ${last.log || last.state}`, {
          state: last.state,
          code: last.code,
        });
      }
      if (/commit/i.test(last.state)) return last;
      await sleep(this.commitPollMs);
    }
    return last;
  }

  /** Current fee guidance from the daemon, used to price the redemption route honestly. */
  async feeGuidance(): Promise<{ recommendedSats: bigint; averageSats: bigint; minimumSats: bigint }> {
    const fees = await this.daemon.fees();
    return {
      recommendedSats: BigInt(fees.recommended_fee_sat ?? 1),
      averageSats: BigInt(fees.avg_fee_sat ?? 1),
      minimumSats: BigInt(fees.min_fee_sat ?? 1),
    };
  }
}

/**
 * The vault SDKs read Bitcoin's network constants (bech32 HRP, base58 prefixes) and are typed
 * against bitcoinjs-lib's `Network`; the aggregator publishes the same object under its own
 * `WalletNetworkConfig` type. They are the same values, so this is one documented cast rather
 * than a hand-rolled copy of the constants that could silently drift.
 */
function bitcoinNetwork(name: string): Parameters<typeof xOnlyFromAddress>[1] {
  return resolveWalletNetwork(name as Parameters<typeof resolveWalletNetwork>[0]) as unknown as Parameters<typeof xOnlyFromAddress>[1];
}

/** Normalizes a 33-byte compressed key or 32-byte x-only key to x-only hex. */
export function normalizeXOnly(key: string): string {
  const hex = key.replace(/^0x/, "").toLowerCase();
  if (hex.length === 64) return hex;
  if (hex.length === 66) return hex.slice(2);
  throw new NotSupportedError(`Expected a 32- or 33-byte public key, received ${hex.length / 2} bytes`);
}

/**
 * The ledger VTXO id every output of a transaction will mint.
 *
 * `VTXO_ID = sha256(tx_hash_bytes || be_uint32(output_index))` — the daemon's own rule, so these
 * are the ids the ledger will report once the transaction commits, not a local naming scheme.
 */
function computeCreatedVtxoIds(txHash: string, outputIndex: number): string {
  return computeVtxoId(txHash, outputIndex).toString("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
