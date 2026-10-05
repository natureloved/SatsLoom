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
import { BitcoinCoreRpcClient, Keystore, WalletAggregator, getNetwork } from "@tachibtc/taurus-wallet-aggregator";
import type { DaemonStatus, Validator, VaultSummary, VerificationResult } from "@satsloom/shared";

export type TachiAdapterConfig = {
  daemonRpcUrl: string;
  bitcoinRpcUrl: string;
  bitcoinRpcUsername?: string;
  bitcoinRpcPassword?: string;
  bitcoinFundingWallet: string;
  network: "regtest";
  explorerUrl: string;
  timeoutMs: number;
};

export function loadTachiConfig(): TachiAdapterConfig {
  const daemonRpcUrl = process.env.TACHI_DAEMON_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
  const bitcoinRpcUrl = process.env.BITCOIN_RPC_URL ?? daemonRpcUrl;
  const parsed = new URL(daemonRpcUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TACHI_DAEMON_RPC_URL must use http or https");
  }
  return {
    daemonRpcUrl: parsed.toString().replace(/\/$/, ""),
    bitcoinRpcUrl: new URL(bitcoinRpcUrl).toString().replace(/\/$/, ""),
    bitcoinRpcUsername: process.env.BITCOIN_RPC_USERNAME,
    bitcoinRpcPassword: process.env.BITCOIN_RPC_PASSWORD,
    bitcoinFundingWallet: process.env.BITCOIN_FUNDING_WALLET ?? "dev",
    network: "regtest",
    explorerUrl: (process.env.TACHI_EXPLORER_URL ?? "https://regtest.tachibtcscan.com").replace(/\/$/, ""),
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
  prepareRegtestFunding(vaultId: string, minimumSats: bigint): Promise<{ funded: boolean; txid?: string }>;
  mineRegtestBlocks(count: number): Promise<void>;
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
    const validatorResponse = await this.client.getValidators();
    const nodePubkeys = validatorResponse.validators.map((validator) => validator.pub_key_hex).filter(Boolean);
    if (nodePubkeys.length === 0) throw new Error("Daemon returned an empty validator set");
    const vault = await createTaurusVault({
      network: this.config.network,
      userWallet,
      nodePubkeys,
      threshold: Math.min(5, nodePubkeys.length),
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
    await context.wallet.sync();
    const result = await depositTaurusVault({
      vault,
      userWallet: context.wallet,
      rpc: context.rpc,
      amountSats,
      feeRateSatVb: 2,
      maxFeeRateSatVb: 10,
    });
    return { txid: result.txid, amountSats: result.amountSats };
  }

  async findConfirmedVaultDeposit(vaultId: string, minimumSats: bigint) {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("Unknown vault; create it before querying deposits");
    let unspents: Array<{ txid: string; amount: number; confirmations?: number }> = [];
    try {
      const root = new BitcoinCoreRpcClient({
        url: this.config.bitcoinRpcUrl,
        username: this.config.bitcoinRpcUsername,
        password: this.config.bitcoinRpcPassword,
      });
      const scan = await root.call<{
        success: boolean;
        unspents: Array<{ txid: string; amount: number; confirmations?: number }>;
      }>("scantxoutset", ["start", [{ desc: `addr(${vault.p2tr.address})` }]]);
      unspents = scan.unspents ?? [];
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

  async prepareRegtestFunding(vaultId: string, minimumSats: bigint) {
    const context = this.depositContexts.get(vaultId);
    if (!context) throw new Error("Unknown vault; create it before funding");
    await context.wallet.sync();
    if (context.wallet.balance.confirmed >= minimumSats) return { funded: false };
    const fundingRpc = await this.ensureFundingWallet();
    const address = context.wallet.receiveAddress;
    const txid = await fundingRpc.call<string>("sendtoaddress", [address, Number(minimumSats) / 100_000_000]);
    await this.mineRegtestBlocks(1);
    await context.wallet.sync();
    return { funded: true, txid };
  }

  async mineRegtestBlocks(count: number) {
    if (!Number.isInteger(count) || count <= 0) throw new Error("Block count must be a positive integer");
    const fundingRpc = await this.ensureFundingWallet();
    const address = await fundingRpc.call<string>("getnewaddress");
    await fundingRpc.call("generatetoaddress", [count, address]);
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
