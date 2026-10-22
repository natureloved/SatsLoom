import { TachiClient, type ValidatorInfo } from "@tachibtc/tachi-sdk-ts";
import {
  createVault as createTaurusVault,
  depositToVault as depositTaurusVault,
  buildTachiTxDeposit,
  buildVtxoPsbt,
  broadcastTachiTx,
  getVtxo,
  getAccountNonce,
  signTachiTx,
  signVtxoPsbtAsUser,
  buildUnilateralExitPsbt,
  finalizeUnilateralExitPsbt,
  signUnilateralExitPsbtAsUser,
  vtxoIdFromDeposit,
  waitForVtxoCommit,
  verifyVtxoPsbt,
  verifyUnilateralExitPsbt,
  verifyVaultP2tr,
  type Vault,
} from "@tachibtc/taurus-vault-core";
import {
  BitcoinCoreRpcClient,
  Keystore,
  SAFE_DUST_THRESHOLD_SATS,
  WalletAggregator,
  getNetwork,
  listNetworks,
} from "@tachibtc/taurus-wallet-aggregator";
import type { DaemonStatus, Validator, VaultSummary, VerificationResult } from "@satsloom/shared";

/**
 * Chains the wallet aggregator actually registers. The vault SDK's own
 * `VaultNetworkName` is wider than this (it also names mainnet/testnet for
 * address encoding), but a vault can only be *funded* through a wallet, and a
 * wallet only exists on these two chains. Refusing anything else here is the
 * honest boundary: asking for mainnet would produce an address that no
 * supported wallet could ever pay into.
 */
export const SUPPORTED_TACHI_NETWORKS = ["signet", "regtest"] as const;
export type TachiNetwork = (typeof SUPPORTED_TACHI_NETWORKS)[number];

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function isSupportedTachiNetwork(value: string): value is TachiNetwork {
  return (SUPPORTED_TACHI_NETWORKS as readonly string[]).includes(value);
}

/** Per-chain defaults, so the network choice and the endpoints cannot drift apart. */
const NETWORK_DEFAULTS: Record<TachiNetwork, { daemonRpcUrl: string; explorerUrl: string; faucetUrl: string }> = {
  signet: {
    daemonRpcUrl: "https://rpc-signet.tachibtc.com",
    explorerUrl: "https://signet.tachibtcscan.com",
    // Public, no-auth Bitcoin signet faucet. Tachi runs on the same chain, so a
    // wallet funded here can pay a Tachi vault's P2TR output. The Tachi-hosted
    // faucet (https://faucet.tachibtc.com) also exists but requires GitHub/X
    // sign-in, so it cannot be driven from a script.
    faucetUrl: "https://faucet.rgbmap.org/v1/faucet",
  },
  regtest: {
    daemonRpcUrl: "https://rpc-regtest.tachibtc.com",
    explorerUrl: "https://regtest.tachibtcscan.com",
    faucetUrl: "https://faucet.rgbmap.org/v1/faucet",
  },
};

export type TachiAdapterConfig = {
  daemonRpcUrl: string;
  bitcoinRpcUrl: string;
  bitcoinRpcUsername?: string;
  bitcoinRpcPassword?: string;
  bitcoinFundingWallet: string;
  network: TachiNetwork;
  explorerUrl: string;
  faucetUrl: string;
  /** Fee rate the adapter asks the SDK to build a vault deposit at. */
  depositFeeRateSatVb: number;
  timeoutMs: number;
};

function requireHttpUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return parsed.toString().replace(/\/$/, "");
}

/** A fee rate must be a positive number; a typo here silently misprices a deposit. */
function parseFeeRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Fee rate must be a positive number, got "${value}"`);
  }
  return parsed;
}

export function loadTachiConfig(): TachiAdapterConfig {
  const networkRaw = process.env.TACHI_NETWORK?.trim();
  if (networkRaw && !isSupportedTachiNetwork(networkRaw)) {
    throw new Error(
      `TACHI_NETWORK="${networkRaw}" is not a supported Tachi wallet chain. ` +
        `Supported: ${SUPPORTED_TACHI_NETWORKS.join(", ")} (the wallet aggregator registers only these).`,
    );
  }
  // Signet is the default: it is the publicly demonstrable chain, and the SDK's
  // own DEFAULT_WALLET_NETWORK is already SIGNET.
  const network: TachiNetwork = networkRaw ?? "signet";
  const defaults = NETWORK_DEFAULTS[network];

  const daemonRpcUrl = requireHttpUrl(process.env.TACHI_DAEMON_RPC_URL ?? defaults.daemonRpcUrl, "TACHI_DAEMON_RPC_URL");
  const bitcoinRpcUrl = requireHttpUrl(process.env.BITCOIN_RPC_URL ?? daemonRpcUrl, "BITCOIN_RPC_URL");
  return {
    daemonRpcUrl,
    bitcoinRpcUrl,
    bitcoinRpcUsername: process.env.BITCOIN_RPC_USERNAME,
    bitcoinRpcPassword: process.env.BITCOIN_RPC_PASSWORD,
    bitcoinFundingWallet: process.env.BITCOIN_FUNDING_WALLET ?? "dev",
    network,
    explorerUrl: requireHttpUrl(process.env.TACHI_EXPLORER_URL ?? defaults.explorerUrl, "TACHI_EXPLORER_URL"),
    faucetUrl: requireHttpUrl(process.env.TACHI_FAUCET_URL ?? defaults.faucetUrl, "TACHI_FAUCET_URL"),
    depositFeeRateSatVb: parseFeeRate(process.env.TACHI_DEPOSIT_FEE_RATE_SAT_VB, 2),
    timeoutMs: Number(process.env.TACHI_RPC_TIMEOUT_MS ?? 30_000),
  };
}

export interface TachiAdapter {
  getStatus(): Promise<DaemonStatus>;
  getValidators(): Promise<Validator[]>;
  createVault(input: { mnemonic: string }): Promise<VaultSummary>;
  verifyVault(vault: VaultSummary): Promise<VerificationResult>;
  depositToVault(vaultId: string, amountSats: bigint): Promise<{ txid: string; amountSats: bigint }>;
  findConfirmedVaultDeposit(vaultId: string, minimumSats: bigint): Promise<{ txid: string; amountSats: bigint } | null>;
  registerDeposit(vaultId: string, amountSats: bigint): Promise<{ broadcastHash: string; vtxoId: string; vtxo: unknown; feeSats: bigint }>;
  buildAndSignUserTransfer(vaultId: string, vtxoId: string, fundingTxid: string): Promise<{ signed: boolean; feeSats: bigint }>;
  buildAndSignUnilateralExit(vaultId: string, fundingTxid: string): Promise<{ signed: boolean; finalized: boolean; feeSats: bigint; csvBlocks: number }>;
  /** Regtest only: sends from a local bitcoind wallet and mines a block. */
  prepareLocalFunding(vaultId: string, minimumSats: bigint): Promise<{ funded: boolean; txid?: string }>;
  mineLocalBlocks(count: number): Promise<void>;
  /**
   * Signet funding: claims test coins from the public faucet into the vault's
   * P2WPKH wallet. Returns the faucet txid, or null when the faucet declines.
   */
  claimFaucetFunds(vaultId: string, amountBtc: number): Promise<{ txid: string; sats: bigint } | null>;
  /** True when the adapter's network can be funded from a public faucet. */
  readonly faucetAvailable: boolean;
  /** Chain this adapter is bound to. */
  readonly network: TachiNetwork;
  /** Waits for a public-chain deposit to reach `minConfirmations`. */
  waitForSignetDepositConfirmation(txid: string, minConfirmations?: number): Promise<void>;
  getExplorerUrl(txid: string): string;
}

export class TachiSdkAdapter implements TachiAdapter {
  private readonly client: TachiClient;
  private readonly vaults = new Map<string, Vault>();
  private readonly depositContexts = new Map<string, { wallet: any; rpc: BitcoinCoreRpcClient }>();
  private readonly signers = new Map<string, any>();
  private readonly config: TachiAdapterConfig;

  constructor(config = loadTachiConfig()) {
    this.config = config;
    // A chain the wallet aggregator has not registered cannot fund a vault, so
    // fail here rather than at the first deposit.
    const registered = listNetworks();
    if (!registered.includes(config.network)) {
      throw new Error(
        `Tachi network "${config.network}" is not registered by the wallet aggregator (registered: ${registered.join(", ")}). ` +
          `Supported: ${SUPPORTED_TACHI_NETWORKS.join(", ")}.`,
      );
    }
    this.client = new TachiClient({ baseUrl: config.daemonRpcUrl, timeoutMs: config.timeoutMs });
  }

  async getStatus(): Promise<DaemonStatus> {
    try {
      const [health, status] = await Promise.all([this.client.getHealth(), this.client.getStatus()]);
      const raw = status as Record<string, any>;
      return {
        reachable: health.status.toLowerCase() === "ok" || health.status.toLowerCase() === "healthy",
        network: raw.result?.node_info?.network ?? raw.node_info?.network ?? this.config.network,
        version: raw.result?.node_info?.version ?? raw.node_info?.version,
        mode: "live",
      };
    } catch {
      return { reachable: false, network: this.config.network, mode: "degraded" };
    }
  }

  async getValidators(): Promise<Validator[]> {
    try {
      const response = await this.client.getValidators();
      return response.validators.map((validator: ValidatorInfo) => ({
        id: validator.pub_key_hex || validator.peer_id,
        endpoint: validator.rpc_addr || validator.host,
        online: true,
      }));
    } catch {
      return [];
    }
  }

  async createVault(input: { mnemonic: string }): Promise<VaultSummary> {
    const rpc = new BitcoinCoreRpcClient({
      url: this.config.bitcoinRpcUrl,
      username: this.config.bitcoinRpcUsername,
      password: this.config.bitcoinRpcPassword,
    });
    const aggregator = WalletAggregator.fromMnemonic(input.mnemonic, { network: this.config.network, rpc });
    // TAURUS deposits require a SegWit wallet so the funding transaction is non-malleable.
    // Vault Core 0.3.3 resolves its own 0.4.3 wallet type; the runtime API is
    // compatible with the root 0.4.4 package, so keep this boundary explicit.
    const userWallet: any = aggregator.addAccount({ addressType: "p2wpkh" });
    const keystore = Keystore.fromMnemonic(input.mnemonic, "", getNetwork(this.config.network), "p2wpkh", 0);
    const userSigner = keystore.signerFor(false, 0);
    // Derive the quorum from the live daemon rather than a hard-coded set. The
    // `validators` fetch is chain-bound: the daemon must advertise a chain id
    // carrying this network as a token, or the fetch fails, so a vault can never
    // be derived from a foreign-network quorum. Passing `nodePubkeys` as well
    // would bypass that guard (and the SDK rejects both together anyway).
    const validatorResponse = await this.client.getValidators();
    const nodePubkeyCount = validatorResponse.validators.filter((validator) => validator.pub_key_hex).length;
    if (nodePubkeyCount === 0) throw new Error("Daemon returned an empty validator set");
    const vault = await createTaurusVault({
      network: this.config.network,
      userWallet,
      threshold: Math.min(5, nodePubkeyCount),
      validators: {
        endpoint: `${this.config.daemonRpcUrl}/tachi_validators`,
        expectedChainId: this.config.network,
        nodeInfoBaseUrl: this.config.daemonRpcUrl,
        timeoutMs: this.config.timeoutMs,
        allowInsecureHttp: this.config.bitcoinRpcUrl.startsWith("http://") && isLoopback(this.config.daemonRpcUrl),
      },
    });
    const id = vault.p2tr.address;
    this.vaults.set(id, vault);
    this.depositContexts.set(id, { wallet: userWallet, rpc });
    this.signers.set(id, userSigner);
    return {
      id,
      address: vault.p2tr.address,
      cooperativeLeaf: {
        scriptHex: vault.p2tr.cooperativeLeaf.script.toString("hex"),
        leafHashHex: vault.p2tr.cooperativeLeafHash.toString("hex"),
        validatorCount: vault.nodeKeys.length,
      },
      exitLeaf: {
        scriptHex: vault.p2tr.exitLeaf.script.toString("hex"),
        leafHashHex: vault.p2tr.exitLeafHash.toString("hex"),
      },
      csvDelay: vault.p2tr.exitLeaf.csvBlocks,
    };
  }

  async depositToVault(vaultId: string, amountSats: bigint) {
    const vault = this.vaults.get(vaultId);
    const context = this.depositContexts.get(vaultId);
    if (!vault || !context) throw new Error("Unknown vault; create it before depositing");
    // The public signet daemon holds a global `scantxoutset` lock, so any other
    // user's in-flight scan makes this fail with "Scan already in progress"
    // (rpc -8). The wallet's own sync retries that a few times, which is not
    // enough on a shared public endpoint — retry here too, with backoff, so a
    // neighbour's scan does not fail our deposit.
    await this.withScanLockRetry(() => context.wallet.sync());

    // A faucet pays a fixed amount, so the requested deposit can easily exceed
    // what the wallet holds. Depositing the whole spendable balance is the
    // useful interpretation here: the caller asked for "as much as we have",
    // and failing with a confusing "insufficient funds" against a wallet that
    // plainly has funds helps nobody.
    //
    // The fee has to come out of that balance, not on top of it. Worse, the
    // SDK's coin selection will not build a change output below its 1000-sat
    // dust floor — it only accepts a change-less spend when the inputs happen
    // to cover amount + the smaller no-change fee exactly. So the amount that
    // actually lands has to leave room for the fee *and* a spendable change
    // output, or the selection fails even though the balance looks sufficient.
    const spendable = context.wallet.balance?.confirmed ?? 0n;
    const estimatedFeeSats = BigInt(Math.ceil((10.5 + 68 + 31 + 31) * this.config.depositFeeRateSatVb));
    const effectiveAmount = amountSats > spendable ? spendable - estimatedFeeSats - SAFE_DUST_THRESHOLD_SATS : amountSats;

    const result = await depositTaurusVault({
      vault,
      userWallet: context.wallet,
      rpc: context.rpc,
      amountSats: effectiveAmount,
      feeRateSatVb: this.config.depositFeeRateSatVb,
      maxFeeRateSatVb: 10,
    });
    return { txid: result.txid, amountSats: result.amountSats };
  }

  /**
   * Runs `operation`, retrying only the "scan already in progress" failure the
   * public daemon raises while another caller's `scantxoutset` holds the global
   * lock. Every other error is rethrown unchanged: a wrong signature or an
   * empty wallet must not be retried into looking like a lock problem.
   *
   * The budget is deliberately generous. The public signet daemon is shared, and
   * a live run showed the lock being held more or less continuously by other
   * callers — 8 attempts with a 30s ceiling (~4 minutes of waiting) cleared it,
   * and a tighter budget failed a deposit that was otherwise ready to go.
   */
  private async withScanLockRetry<T>(
    operation: () => Promise<T>,
    attempts = 20,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/scan already in progress/i.test(message)) throw error;
        lastError = error;
        // 2s, 4s, 8s … capped at 30s; a full scan of signet takes about a minute.
        await sleep(Math.min(2_000 * 2 ** attempt, 30_000));
      }
    }
    throw lastError;
  }

  async findConfirmedVaultDeposit(vaultId: string, minimumSats: bigint) {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("Unknown vault; create it before querying deposits");
    let unspents: Array<{ txid: string; amount: number; confirmations?: number }> = [];
    try {
      unspents = await this.withScanLockRetry(async () => {
        const root = new BitcoinCoreRpcClient({
          url: this.config.bitcoinRpcUrl,
          username: this.config.bitcoinRpcUsername,
          password: this.config.bitcoinRpcPassword,
        });
        const scan = await root.call<{
          success: boolean;
          unspents: Array<{ txid: string; amount: number; confirmations?: number }>;
        }>("scantxoutset", ["start", [{ desc: `addr(${vault.p2tr.address})` }]]);
        return scan.unspents ?? [];
      });
    } catch (localError) {
      // Fallback to Tachi daemon's proxied Bitcoin RPC
      try {
        const scan = await this.client.bitcoinRPC<{
          success: boolean;
          unspents: Array<{ txid: string; amount: number; confirmations?: number }>;
        }>({
          method: "scantxoutset",
          params: ["start", [{ desc: `addr(${vault.p2tr.address})` }]],
        });
        if (scan.error) {
          throw new Error(scan.error.message || JSON.stringify(scan.error));
        }
        unspents = scan.result?.unspents ?? [];
      } catch (proxyError) {
        throw new Error(
          `Bitcoin RPC scan failed both locally (${localError instanceof Error ? localError.message : String(localError)}) and via Tachi proxy (${proxyError instanceof Error ? proxyError.message : String(proxyError)})`,
          { cause: localError },
        );
      }
    }
    const match = unspents.find((utxo) => BigInt(Math.round(utxo.amount * 100_000_000)) >= minimumSats);
    return match ? { txid: match.txid, amountSats: BigInt(Math.round(match.amount * 100_000_000)) } : null;
  }

  async registerDeposit(vaultId: string, amountSats: bigint) {
    const vault = this.vaults.get(vaultId);
    const signer = this.signers.get(vaultId);
    if (!vault || !signer) throw new Error("Unknown vault; create it before registering a deposit");
    const existing = await this.client.getAddressVtxos(vault.userKey.xOnly.toString("hex"), true);
    const matching = existing.vtxos.find((item) => !item.spent && BigInt(item.amount) === amountSats);
    if (matching) {
      return {
        broadcastHash: "",
        vtxoId: matching.id,
        vtxo: await getVtxo(matching.id, { baseUrl: this.config.daemonRpcUrl, timeoutMs: this.config.timeoutMs }),
        feeSats: 0n,
      };
    }
    const nonce = await getAccountNonce(vault.userKey.xOnly, {
      baseUrl: this.config.daemonRpcUrl,
      requestTimeoutMs: this.config.timeoutMs,
    });
    const estimate = await this.client.getFeeEstimate();
    const feeSats = BigInt(Math.max(estimate.recommended_fee_sat, estimate.min_fee_sat));
    const maxFeeSats = BigInt(process.env.TACHI_MAX_FEE_SATS ?? "1000");
    if (feeSats > maxFeeSats) {
      throw new Error(`Daemon recommended fee ${feeSats} sats exceeds TACHI_MAX_FEE_SATS=${maxFeeSats}`);
    }
    const draft = buildTachiTxDeposit({
      userXOnly: vault.userKey.xOnly,
      amountSats,
      nonce,
      feeSats,
    });
    const signed = await signTachiTx(draft, signer);
    const broadcast = await broadcastTachiTx(signed, {
      url: `${this.config.daemonRpcUrl}/tachi_txBroadcastSync`,
      timeoutMs: this.config.timeoutMs,
      treatDuplicateAsAccepted: true,
    });
    const vtxoId = vtxoIdFromDeposit(signed);
    await waitForVtxoCommit(vtxoId, {
      baseUrl: this.config.daemonRpcUrl,
      requestTimeoutMs: this.config.timeoutMs,
      overallTimeoutMs: 90_000,
      pollIntervalMs: 1_000,
    });
    const vtxo = await getVtxo(vtxoId, {
      baseUrl: this.config.daemonRpcUrl,
      timeoutMs: this.config.timeoutMs,
    });
    return { broadcastHash: broadcast.tendermintTxHash, vtxoId: vtxoId.toString("hex"), vtxo, feeSats };
  }

  async buildAndSignUserTransfer(vaultId: string, vtxoId: string, fundingTxid: string) {
    const vault = this.vaults.get(vaultId);
    const signer = this.signers.get(vaultId);
    if (!vault || !signer) throw new Error("Unknown vault; create it before building a transfer");
    const vtxo = await getVtxo(vtxoId, { baseUrl: this.config.daemonRpcUrl, timeoutMs: this.config.timeoutMs });
    if (vtxo.spent) throw new Error("VTXO is already spent");
    const root = new BitcoinCoreRpcClient({
      url: this.config.bitcoinRpcUrl,
      username: this.config.bitcoinRpcUsername,
      password: this.config.bitcoinRpcPassword,
    });
    const raw = await root.call<any>("getrawtransaction", [fundingTxid, true]);
    const scriptHex = vault.p2tr.output.toString("hex");
    const output = raw.vout.find((item: any) => item.scriptPubKey?.hex === scriptHex);
    if (!output) throw new Error("Vault funding output was not found in the deposit transaction");
    const fundingValueSats = BigInt(Math.round(Number(output.value) * 100_000_000));
    if (fundingValueSats < vtxo.amountSats) {
      throw new Error(`Funding output ${fundingValueSats} sats is below VTXO amount ${vtxo.amountSats} sats`);
    }
    const feeSats = BigInt(process.env.TACHI_TRANSFER_FEE_SATS ?? "500");
    const maxFeeSats = BigInt(process.env.TACHI_MAX_FEE_SATS ?? "1000");
    if (feeSats <= 0n || feeSats > maxFeeSats || feeSats >= fundingValueSats) {
      throw new Error(`Invalid transfer fee ${feeSats}; max is ${maxFeeSats} and it must be below the VTXO amount`);
    }
    const built = buildVtxoPsbt({
      vault,
      inputs: [{
        txid: fundingTxid,
        vout: output.n,
        valueSats: fundingValueSats,
        scriptPubKey: scriptHex,
        vtxoId: Buffer.from(vtxoId, "hex"),
      }],
      outputs: [{ address: vault.p2tr.address, valueSats: fundingValueSats - feeSats }],
      feeSats,
    });
    const options = { maxFeeSats, maxFeeRateSatVb: 10 };
    verifyVtxoPsbt(built.psbt, vault, options);
    await signVtxoPsbtAsUser(built.psbt, signer, vault, options);
    verifyVtxoPsbt(built.psbt, vault, options);
    const signed = built.psbt.data.inputs.every((input) =>
      (input.tapScriptSig ?? []).some((sig) => Buffer.from(sig.leafHash).equals(vault.p2tr.cooperativeLeafHash))
    );
    if (!signed) throw new Error("User signer did not attach a cooperative-leaf tapScriptSig");
    return { signed: true, feeSats };
  }

  async buildAndSignUnilateralExit(vaultId: string, fundingTxid: string) {
    const vault = this.vaults.get(vaultId);
    const signer = this.signers.get(vaultId);
    const context = this.depositContexts.get(vaultId);
    if (!vault || !signer || !context) throw new Error("Unknown vault; create it before preparing an exit");
    const root = new BitcoinCoreRpcClient({
      url: this.config.bitcoinRpcUrl,
      username: this.config.bitcoinRpcUsername,
      password: this.config.bitcoinRpcPassword,
    });
    const raw = await root.call<any>("getrawtransaction", [fundingTxid, true]);
    const scriptHex = vault.p2tr.output.toString("hex");
    const output = raw.vout.find((item: any) => item.scriptPubKey?.hex === scriptHex);
    if (!output) throw new Error("Vault funding output was not found in the deposit transaction");
    const fundingValueSats = BigInt(Math.round(Number(output.value) * 100_000_000));
    const feeSats = BigInt(process.env.TACHI_EXIT_FEE_SATS ?? "300");
    const maxFeeSats = BigInt(process.env.TACHI_MAX_FEE_SATS ?? "1000");
    if (feeSats <= 0n || feeSats > maxFeeSats || feeSats >= fundingValueSats) {
      throw new Error(`Invalid unilateral-exit fee ${feeSats}; max is ${maxFeeSats}`);
    }
    const built = buildUnilateralExitPsbt({
      vault,
      funding: {
        txid: fundingTxid,
        vout: output.n,
        valueSats: fundingValueSats,
        scriptPubKey: scriptHex,
      },
      outputs: [{
        address: context.wallet.receiveAddress,
        valueSats: fundingValueSats - feeSats,
      }],
      feeSats,
    });
    const options = {
      maxFeeSats,
      maxFeeRateSatVb: 10,
      expectedUserKey: vault.userKey.xOnly,
      minCsvBlocks: vault.p2tr.exitLeaf.csvBlocks,
    };
    verifyUnilateralExitPsbt(built.psbt, vault, options);
    await signUnilateralExitPsbtAsUser(built.psbt, signer, vault, options);
    verifyUnilateralExitPsbt(built.psbt, vault, options);
    const signed = built.psbt.data.inputs.some((input) =>
      (input.tapScriptSig ?? []).some((sig) => Buffer.from(sig.leafHash).equals(vault.p2tr.exitLeafHash))
    );
    if (!signed) throw new Error("User signer did not attach the unilateral-exit tapScriptSig");
    const rawTxHex = finalizeUnilateralExitPsbt(built.psbt, vault, options);
    if (!/^[0-9a-f]+$/i.test(rawTxHex)) throw new Error("Finalized unilateral exit is not valid transaction hex");
    return { signed: true, finalized: true, feeSats, csvBlocks: vault.p2tr.exitLeaf.csvBlocks };
  }

  async prepareLocalFunding(vaultId: string, minimumSats: bigint) {
    if (this.config.network !== "regtest") {
      throw new Error(
        `prepareLocalFunding needs a local bitcoind wallet and is regtest-only; this adapter runs on ${this.config.network}. ` +
          `Fund the wallet from the faucet (https://faucet.tachibtc.com) instead.`,
      );
    }
    const context = this.depositContexts.get(vaultId);
    if (!context) throw new Error("Unknown vault; create it before funding");
    await context.wallet.sync();
    if (context.wallet.balance.confirmed >= minimumSats) return { funded: false };
    const fundingRpc = await this.ensureFundingWallet();
    const address = context.wallet.receiveAddress;
    const txid = await fundingRpc.call<string>("sendtoaddress", [address, Number(minimumSats) / 100_000_000]);
    await this.mineLocalBlocks(1);
    await context.wallet.sync();
    return { funded: true, txid };
  }

  async mineLocalBlocks(count: number) {
    if (this.config.network !== "regtest") {
      throw new Error(
        `mineLocalBlocks is regtest-only; signet blocks are produced by the public network (~10 min cadence). ` +
          `This adapter runs on ${this.config.network}.`,
      );
    }
    if (!Number.isInteger(count) || count <= 0) throw new Error("Block count must be a positive integer");
    const fundingRpc = await this.ensureFundingWallet();
    const address = await fundingRpc.call<string>("getnewaddress");
    await fundingRpc.call("generatetoaddress", [count, address]);
  }

  /**
   * Public faucet funding, for signet. The faucet is rate-limited to one payout
   * per address per day, so a wallet that has already claimed returns the
   * existing balance rather than a new txid.
   *
   * The faucet is claimed into the wallet's P2WPKH receive address, never
   * straight into the vault: a deposit must be *spent from* a wallet into the
   * vault's P2TR output, because `registerVault` (TxVaultOpen) needs the funding
   * outpoint of a transaction the vault owner controls. Faucet coins sitting on
   * the vault address itself have no registration path.
   */
  async claimFaucetFunds(vaultId: string, amountBtc: number): Promise<{ txid: string; sats: bigint } | null> {
    const context = this.depositContexts.get(vaultId);
    if (!context) throw new Error("Unknown vault; create it before claiming faucet funds");
    if (!Number.isFinite(amountBtc) || amountBtc <= 0) {
      throw new Error("Faucet amount must be a positive BTC amount");
    }
    const address = context.wallet.receiveAddress;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.config.faucetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, amountBtc }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        | { txid?: string; sats?: number; error?: string }
        | null;
      if (!response.ok || !body?.txid) {
        // A rate-limited or declined claim is not a failure of the system; the
        // caller decides whether an already-funded wallet is enough.
        return null;
      }
      return { txid: body.txid, sats: BigInt(body.sats ?? Math.round(amountBtc * 100_000_000)) };
    } finally {
      clearTimeout(timer);
    }
  }

  get faucetAvailable(): boolean {
    // Regtest has its own faucet semantics and is normally funded locally; the
    // public no-auth faucet is a Bitcoin signet facility.
    return this.config.network === "signet";
  }

  get network(): TachiNetwork {
    return this.config.network;
  }

  /**
   * Blocks until a public-chain deposit is confirmed. On signet there is no
   * `generatetoaddress`, so the only honest option is to poll a Bitcoin indexer.
   *
   * The Tachi explorer is deliberately NOT used here: it indexes the Tachi
   * *ledger* (epochs, vaults, vtxos) at `/api/v1/tachi/...` and carries no
   * Bitcoin block/tx confirmation state. Bitcoin-layer confirmation comes from
   * mempool.space's signet API, which is the same chain the vault is funded on.
   */
  async waitForSignetDepositConfirmation(txid: string, minConfirmations = 1): Promise<void> {
    if (this.config.network !== "signet") {
      throw new Error(`waitForSignetDepositConfirmation is signet-only; this adapter runs on ${this.config.network}`);
    }
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error(`Not a txid: ${txid}`);
    // Signet blocks average ~10 minutes and occasionally much longer, so the
    // generic RPC timeout is far too short here. A caller that wants a different
    // ceiling can raise TACHI_RPC_TIMEOUT_MS; the floor below keeps the common
    // case from failing while a block is merely slow.
    const deadline = Date.now() + Math.max(this.config.timeoutMs, 30 * 60_000);
    let lastStatus = "unknown";
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`, {
          signal: controller.signal,
        });
        if (response.ok) {
          const body = (await response.json().catch(() => null)) as { confirmed?: boolean } | null;
          lastStatus = body?.confirmed ? "confirmed" : "in mempool";
          if (body?.confirmed) return;
        } else {
          lastStatus = `HTTP ${response.status}`;
        }
      } catch {
        lastStatus = "indexer unreachable";
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Deposit ${txid} was not confirmed within ${this.config.timeoutMs}ms (last status: ${lastStatus}). ` +
            `Signet blocks average ~10 minutes; rerun once it has a confirmation.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }

  private createFundingWalletRpc() {
    const base = new URL(this.config.bitcoinRpcUrl);
    base.pathname = `${base.pathname.replace(/\/$/, "")}/wallet/${encodeURIComponent(this.config.bitcoinFundingWallet)}`;
    return new BitcoinCoreRpcClient({
      url: base.toString(),
      username: this.config.bitcoinRpcUsername,
      password: this.config.bitcoinRpcPassword,
    });
  }

  private async ensureFundingWallet(): Promise<BitcoinCoreRpcClient> {
    const root = new BitcoinCoreRpcClient({
      url: this.config.bitcoinRpcUrl,
      username: this.config.bitcoinRpcUsername,
      password: this.config.bitcoinRpcPassword,
    });
    try {
      const wallets = await root.call<string[]>("listwallets");
      if (!wallets.includes(this.config.bitcoinFundingWallet)) {
        try {
          await root.call("loadwallet", [this.config.bitcoinFundingWallet]);
        } catch (error) {
          throw new Error(`Bitcoin Core is reachable but wallet '${this.config.bitcoinFundingWallet}' is not loaded. Run bitcoin-cli loadwallet ${this.config.bitcoinFundingWallet}.`, { cause: error });
        }
      }
      return this.createFundingWalletRpc();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("RPC_TRANSPORT_ERROR")) {
        throw new Error(`Bitcoin Core RPC is unavailable at ${this.config.bitcoinRpcUrl}. Start bitcoind with -regtest -server -txindex=1 -rpcport=18443, then rerun the spike.`, { cause: error });
      }
      throw error;
    }
  }

  async verifyVault(vault: VaultSummary): Promise<VerificationResult> {
    const nativeVault = this.vaults.get(vault.id);
    if (!nativeVault) return { valid: false, details: "Vault was not created by this adapter instance" };
    try {
      verifyVaultP2tr(nativeVault.p2tr);
      return { valid: true, details: "verifyVaultP2tr passed" };
    } catch (error) {
      return { valid: false, details: error instanceof Error ? error.message : "Vault verification failed" };
    }
  }

  getExplorerUrl(txid: string): string {
    return `${this.config.explorerUrl}/tx/${encodeURIComponent(txid)}`;
  }
}
