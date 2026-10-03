/**
 * Daemon transports.
 *
 * `TachiDaemon` is the seam between SatsLoom and Tachi. Two implementations satisfy it:
 *
 *  - `LiveTachiDaemon`  — the official SDK (`@tachibtc/tachi-sdk-ts@0.2.1`) against a real daemon.
 *  - `FixtureDaemon`    — an in-process ledger used for tests, local development and the demo
 *                         fallback. It implements the daemon's rules (nonce ordering, VTXO
 *                         ownership, conservation of value) so the rail above it runs the same
 *                         code path, and it reports `kind: "fixture"` so nothing can mistake it
 *                         for live money.
 *
 * The seam exists because the daemon is the one thing SatsLoom does not control: when it is
 * down or a route 404s, the honest answer is `mode: "degraded"`, and that is decided here.
 */
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { Keystore } from "@tachibtc/taurus-wallet-aggregator";
import { resolveWalletNetwork } from "@tachibtc/taurus-vault-core";
import type {
  AddressResponse,
  AddressVTXOsResponse,
  CometRPCResponse,
  FeeEstimateResponse,
  GetTransactionResponse,
  HealthResponse,
  MempoolResponse,
  NodeInfoResponse,
  StatsResponse,
  ValidatorInfo,
  ValidatorsResponse,
} from "@tachibtc/tachi-sdk-ts";
import type { Validator, Vtxo } from "@satsloom/shared";
import { DaemonRejectedError, DaemonUnreachableError, toAdapterError } from "./errors.js";

/** What a broadcast tells the daemon about a transaction, decoded locally by the rail. */
export type BroadcastMeta = {
  kind: "deposit" | "transfer" | "withdraw" | "vault_open";
  /** x-only owner key that signed this transaction. */
  sender: string;
  inputs: { vtxoId: string; valueSats?: string }[];
  outputs: { owner: string; amountSats: string }[];
  feeSats: string;
  nonce: string;
  /** vtxoIds the sender computed locally for this tx's outputs, in output order. */
  createdVtxoIds: string[];
  /**
   * sha256 of the encoded transaction — the id CometBFT will report. Supplied by the caller so
   * the fixture and the live daemon agree on txids and on every derived VTXO id.
   */
  txHash?: string;
};

export type BroadcastAck = { hash: string; accepted: boolean; code: number; log?: string };

/** The subset of a transaction the adapter reads when proving a payment. */
export type RecentTransaction = {
  txHash: string;
  type?: string;
  state?: string;
  epoch?: number;
  time?: number;
  vout: { owner: string; amountSats: bigint }[];
};

export type TxStatusView = {
  found: boolean;
  state: string;
  code: number;
  log: string;
  epoch: number;
  blockHash?: string;
  timeSec?: number;
  type?: string;
  txid?: string;
  confirmations: number;
};

export interface TachiDaemon {
  readonly kind: "live" | "fixture";
  readonly baseUrl: string;
  health(): Promise<HealthResponse>;
  nodeInfo(): Promise<NodeInfoResponse>;
  stats(): Promise<StatsResponse>;
  validators(): Promise<Validator[]>;
  /** Spendable ledger balance in sats for an x-only owner key (or a taproot address). */
  balance(owner: string): Promise<{ owner: string; balanceSats: bigint; nonce: number; vtxoCount: number }>;
  address(owner: string): Promise<AddressResponse>;
  vtxos(owner: string, includeSpent?: boolean): Promise<Vtxo[]>;
  mempool(): Promise<MempoolResponse>;
  /**
   * Recent chain transactions, newest first. Used to resolve the txid behind a payment when the
   * VTXO record itself does not name one — the difference between an explorer link that works and
   * one that 404s.
   */
  recentTransactions(pageSize?: number): Promise<{ transactions: RecentTransaction[] }>;
  fees(): Promise<FeeEstimateResponse>;
  /** Submit a signed, encoded TachiTx. `meta` is only consulted by the fixture ledger. */
  broadcastTx(txHex: string, meta: BroadcastMeta): Promise<BroadcastAck>;
  txStatus(hash: string): Promise<TxStatusView>;
  bitcoinRpc<T = unknown>(method: string, params?: unknown[]): Promise<{ result: T | null; error: { code: number; message: string } | null }>;
  /** Dev/test helper: ask the Tachi faucet for on-chain regtest funds. */
  faucet(address: string, amountSats?: bigint): Promise<{ txid: string; detail?: string }>;
}

const REGTEST_EXPLORER = "https://explorer-regtest.tachibtc.com";
const REGTEST_FAUCET = "https://faucet.tachibtc.com";

/* ------------------------------------------------------------------ *
 * Live                                                              *
 * ------------------------------------------------------------------ */

export type LiveDaemonOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected by tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export class LiveTachiDaemon implements TachiDaemon {
  readonly kind = "live" as const;
  readonly baseUrl: string;
  private readonly client: TachiClient;

  constructor(options: LiveDaemonOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.TACHI_DAEMON_URL ?? "https://rpc-regtest.tachibtc.com";
    this.client = new TachiClient({
      baseUrl: this.baseUrl,
      timeoutMs: options.timeoutMs ?? Number(process.env.TACHI_TIMEOUT_MS ?? 20_000),
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  }

  private async guard<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toAdapterError(error, label);
    }
  }

  health() {
    return this.guard("health", () => this.client.getHealth());
  }

  nodeInfo() {
    return this.guard("nodeInfo", () => this.client.getNodeInfo());
  }

  stats() {
    return this.guard("stats", () => this.client.getStats());
  }

  async validators(): Promise<Validator[]> {
    const response: ValidatorsResponse = await this.guard("validators", () => this.client.getValidators());
    let live = new Set<string>();
    try {
      const liveResponse = await this.client.getLiveValidators();
      live = new Set(liveResponse.validators.map((v: ValidatorInfo) => v.pub_key_hex));
    } catch {
      // Live-validator listing is a nicety; the registry view is the source of truth for keys.
    }
    return (response.validators ?? []).map((v) => ({
      id: v.pub_key_hex,
      endpoint: v.rpc_addr || `${v.host}:${v.p2p_port}`,
      online: live.size === 0 ? true : live.has(v.pub_key_hex),
    }));
  }

  async balance(owner: string) {
    const response = await this.guard("balance", () => this.client.getBalance(owner));
    return {
      owner: response.pubkey,
      balanceSats: BigInt(response.balance_sat ?? 0),
      nonce: 0,
      vtxoCount: 0,
    };
  }

  address(owner: string) {
    return this.guard("address", () => this.client.getAddress(owner));
  }

  async vtxos(owner: string, includeSpent = false): Promise<Vtxo[]> {
    const response: AddressVTXOsResponse = await this.guard("addressVtxos", () =>
      this.client.getAddressVtxos(owner, includeSpent),
    );
    return (response.vtxos ?? []).map((item) => ({
      vtxoId: item.id,
      owner: item.owner,
      amountSats: BigInt(item.amount ?? 0),
      state: item.spent ? ("spent" as const) : ("committed" as const),
      epoch: item.height || undefined,
      address: item.vault_address,
      timelockBlocks: undefined,
    }));
  }

  mempool() {
    return this.guard("mempool", () => this.client.getMempool());
  }

  fees() {
    return this.guard("fees", () => this.client.getFeeEstimate());
  }

  async recentTransactions(pageSize = 25) {
    const response = await this.guard("listTransactions", () => this.client.listTransactions({ pageSize }));
    return {
      transactions: (response.transactions ?? []).map((tx) => ({
        txHash: tx.tx_hash,
        type: tx.type,
        state: tx.state,
        epoch: tx.epoch,
        time: tx.time,
        vout: (tx.vout ?? []).map((out) => ({ owner: out.owner, amountSats: BigInt(out.amount ?? 0) })),
      })),
    };
  }

  /**
   * `meta` is part of the interface for the fixture's benefit (it needs the locally-decoded
   * summary); a real daemon decodes the transaction itself and ignores it.
   */
  async broadcastTx(txHex: string, _meta?: BroadcastMeta): Promise<BroadcastAck> {
    // `broadcastTxSync` waits for CheckTx. A resolved promise is not success: CometBFT reports
    // failures inside an HTTP 200, so `code` and `log` are the real answer.
    const result = await this.guard("broadcastTxSync", () => this.client.broadcastTxSync(txHex));
    const code = Number((result as { result?: { code?: number } }).result?.code ?? 0);
    const log = String((result as { result?: { log?: string } }).result?.log ?? "");
    const hash = String((result as { result?: { hash?: string } }).result?.hash ?? "");
    if (code !== 0) {
      return { hash, accepted: false, code, log };
    }
    // Some builds report the app-level result at the top level instead.
    const topCode = Number((result as { code?: number }).code ?? 0);
    if (topCode !== 0) {
      return { hash, accepted: false, code: topCode, log: String((result as { log?: string }).log ?? "") };
    }
    return { hash, accepted: true, code: 0, log };
  }

  async txStatus(hash: string): Promise<TxStatusView> {
    try {
      const tx: GetTransactionResponse = await this.client.getTransaction(hash);
      const state = String(tx.state ?? "unknown");
      return {
        found: true,
        state,
        code: Number(tx.status?.code ?? 0),
        log: String(tx.status?.log ?? ""),
        epoch: Number(tx.epoch ?? 0),
        blockHash: tx.blockhash || undefined,
        timeSec: tx.time || undefined,
        type: tx.type,
        txid: tx.txid || hash,
        confirmations: /commit/i.test(state) ? 1 : 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A hash the daemon has not indexed yet is 404: "too early", not a failure.
      if (/404|not found/i.test(message)) {
        return { found: false, state: "pending", code: 0, log: "", epoch: 0, confirmations: 0 };
      }
      throw toAdapterError(error, `txStatus(${hash})`);
    }
  }

  async bitcoinRpc<T = unknown>(method: string, params: unknown[] = []) {
    const response = await this.guard("bitcoinRPC", () => this.client.bitcoinRPC<T>({ method, params }));
    return { result: (response.result ?? null) as T | null, error: response.error ?? null };
  }

  /** The faucet is an HTTP service in front of the regtest node, not a daemon route. */
  async faucet(address: string, amountSats?: bigint) {
    const url = process.env.TACHI_FAUCET_URL ?? REGTEST_FAUCET;
    const body: Record<string, unknown> = { address };
    if (amountSats !== undefined) body.amount = Number(amountSats);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw toAdapterError(error, `faucet(${url})`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new DaemonRejectedError(`Faucet responded ${response.status}`, { url, body: text.slice(0, 400) });
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A plain-text faucet reply is still a success; keep the body as the detail.
    }
    const txid = String(parsed.txid ?? parsed.txId ?? parsed.hash ?? "");
    return { txid, detail: Object.keys(parsed).length ? undefined : text.slice(0, 200) };
  }
}

/* ------------------------------------------------------------------ *
 * Fixture                                                           *
 * ------------------------------------------------------------------ */

export type FixtureOptions = {
  /** Seconds a transaction spends in the mempool before committing. 0 commits immediately. */
  commitDelaySeconds?: number;
  /** Starting on-chain (faucet) balance credited to every new address. */
  faucetSats?: bigint;
  /** Validators the fixture pretends to see. */
  validatorCount?: number;
};

type FixtureVtxo = {
  id: string;
  owner: string;
  amountSats: bigint;
  spent: boolean;
  epoch: number;
  commitAt: number;
  txHash: string;
};

type FixtureTx = {
  hash: string;
  code?: number;
  meta: BroadcastMeta;
  commitAt: number;
  accepted: boolean;
  log: string;
  epoch: number;
};

/**
 * In-process implementation of the daemon's observable behaviour.
 *
 * It is a *fixture*, not a simulation of a merchant payment: the cryptographic work above it
 * (key derivation, sighash, BIP-340 signing, VTXO id derivation) is the real thing, and the
 * ledger rules below reject the same transactions a real daemon would (bad nonce, unknown
 * input, output value exceeding inputs, replay).
 */
export class FixtureDaemon implements TachiDaemon {
  readonly kind = "fixture" as const;
  readonly baseUrl = "fixture://in-process";
  private readonly vtxoMap = new Map<string, FixtureVtxo>();
  private readonly txs = new Map<string, FixtureTx>();
  private readonly nonces = new Map<string, bigint>();
  private readonly onchain = new Map<string, bigint>();
  private readonly onchainTxs: { txid: string; address: string; amountSats: bigint; at: number }[] = [];
  private epoch = 1;
  private nodeKeys?: string[];
  private readonly startedAt = Date.now();
  private readonly options: Required<FixtureOptions>;

  constructor(options: FixtureOptions = {}) {
    this.options = {
      commitDelaySeconds: options.commitDelaySeconds ?? Number(process.env.FIXTURE_COMMIT_DELAY_SECONDS ?? 2),
      faucetSats: options.faucetSats ?? 5_000_000n,
      validatorCount: options.validatorCount ?? 7,
    };
  }

  private now(): number {
    return Date.now();
  }

  /** Commits any transaction whose mempool delay has elapsed. */
  private advance(): void {
    const now = this.now();
    for (const tx of this.txs.values()) {
      if (!tx.accepted || tx.epoch !== 0 || tx.commitAt > now) continue;
      tx.epoch = ++this.epoch;
      for (const [index, output] of tx.meta.outputs.entries()) {
        const id = tx.meta.createdVtxoIds[index];
        if (!id) continue;
        this.vtxoMap.set(id, {
          id,
          owner: output.owner,
          amountSats: BigInt(output.amountSats),
          spent: false,
          epoch: tx.epoch,
          commitAt: tx.commitAt,
          txHash: tx.hash,
        });
      }
      for (const input of tx.meta.inputs) {
        const vtxo = this.vtxoMap.get(input.vtxoId);
        if (vtxo) vtxo.spent = true;
      }
    }
  }

  async health(): Promise<HealthResponse> {
    this.advance();
    return { status: "ok", validators: this.options.validatorCount };
  }

  async nodeInfo(): Promise<NodeInfoResponse> {
    this.advance();
    return {
      node_id: "fixture-node",
      moniker: "satsloom-fixture",
      network: "regtest",
      chain_id: "tachi-regtest-fixture",
      version: "0.2.1-fixture",
      latest_block_height: 100 + this.epoch,
      latest_block_time: Math.floor(this.now() / 1000),
      epoch_blocks: 10,
      peers: this.options.validatorCount,
      sync_status: "synced",
    };
  }

  async stats(): Promise<StatsResponse> {
    this.advance();
    let supply = 0n;
    for (const vtxo of this.vtxoMap.values()) if (!vtxo.spent) supply += vtxo.amountSats;
    return {
      chain_id: "tachi-regtest-fixture",
      height: 100 + this.epoch,
      current_epoch: this.epoch,
      latest_block_time: Math.floor(this.now() / 1000),
      node_count: this.options.validatorCount,
      total_accounts: this.nonces.size,
      total_transactions: this.txs.size,
      total_supply_sat: Number(supply),
      vtxo_count: [...this.vtxoMap.values()].filter((v) => !v.spent).length,
    };
  }

  /**
   * The fixture quorum.
   *
   * These are real secp256k1 pubkeys derived from a published BIP-39 test vector, not made-up
   * strings: the vault builder validates curve membership and key length, so a fabricated
   * "fixture-validator-1" would make every vault address unbuildable and hide real bugs behind a
   * fixture-shaped error. They are public knowledge and hold no value anywhere.
   */
  async validators(): Promise<Validator[]> {
    if (!this.nodeKeys) {
      const network = resolveWalletNetwork("regtest");
      const keystore = Keystore.fromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        "",
        network,
        "p2wpkh",
        9,
      );
      this.nodeKeys = Array.from({ length: this.options.validatorCount }, (_, i) =>
        Buffer.from(keystore.signerFor(false, i).publicKey).toString("hex"),
      );
      keystore.lock();
    }
    return this.nodeKeys.map((key, i) => ({ id: key, endpoint: `fixture://validator-${i + 1}`, online: true }));
  }

  async address(owner: string): Promise<AddressResponse> {
    this.advance();
    return {
      pubkey: owner,
      balance_sat: Number(this.ledgerBalance(owner)),
      nonce: Number(this.nonces.get(owner) ?? 0n),
      vtxo_count: [...this.vtxoMap.values()].filter((v) => v.owner === owner && !v.spent).length,
    };
  }

  private ledgerBalance(owner: string): bigint {
    let total = 0n;
    for (const vtxo of this.vtxoMap.values()) {
      if (vtxo.owner === owner && !vtxo.spent) total += vtxo.amountSats;
    }
    return total;
  }

  async balance(owner: string) {
    this.advance();
    return {
      owner,
      balanceSats: this.ledgerBalance(owner),
      nonce: Number(this.nonces.get(owner) ?? 0n),
      vtxoCount: [...this.vtxoMap.values()].filter((v) => v.owner === owner && !v.spent).length,
    };
  }

  async vtxos(owner: string, includeSpent = false): Promise<Vtxo[]> {
    this.advance();
    return [...this.vtxoMap.values()]
      .filter((v) => v.owner === owner && (includeSpent || !v.spent))
      .map((v) => ({
        vtxoId: v.id,
        owner: v.owner,
        amountSats: v.amountSats,
        state: v.epoch === 0 ? ("pending" as const) : v.spent ? ("spent" as const) : ("committed" as const),
        txid: v.txHash,
        epoch: v.epoch || undefined,
      }));
  }

  async mempool(): Promise<MempoolResponse> {
    this.advance();
    const pending = [...this.txs.values()].filter((t) => t.epoch === 0);
    return {
      count: pending.length,
      transactions: pending.map((t) => ({
        tx_hash: t.hash,
        type: t.meta.kind,
        state: "pending",
        direction: "out",
        height: 0,
        block_hash: "",
        epoch: 0,
        time: Math.floor(t.commitAt / 1000),
        fee: Number(t.meta.feeSats),
        size: 0,
        vsize: 0,
        weight: 0,
        is_segwit: true,
        has_rip: false,
        vin: t.meta.inputs.map((i) => ({ txid: "", vout: 0, vtxo_id: i.vtxoId, sig_script: "", value_sats: Number(i.valueSats ?? 0) })),
        vout: t.meta.outputs.map((o) => ({ owner: o.owner, amount: Number(o.amountSats), script: "" })),
      })),
    };
  }

  async fees(): Promise<FeeEstimateResponse> {
    return { recommended_fee_sat: 1, avg_fee_sat: 1, min_fee_sat: 1 };
  }

  async recentTransactions(pageSize = 25) {
    this.advance();
    const sorted = [...this.txs.values()].sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.commitAt - a.commitAt);
    return {
      transactions: sorted.slice(0, pageSize).map((tx) => ({
        txHash: tx.hash,
        type: tx.meta.kind,
        state: tx.epoch === 0 ? "pending" : tx.accepted ? "committed" : "rejected",
        epoch: tx.epoch,
        time: Math.floor(tx.commitAt / 1000),
        vout: tx.meta.outputs.map((out) => ({ owner: out.owner, amountSats: BigInt(out.amountSats) })),
      })),
    };
  }

  async broadcastTx(_txHex: string, meta: BroadcastMeta): Promise<BroadcastAck> {
    this.advance();
    if (this.txs.has(meta.txHash ?? hashOf(meta))) {
      return { hash: meta.txHash ?? hashOf(meta), accepted: false, code: 1, log: "tx already exists in cache" };
    }
    const reject = (log: string): BroadcastAck => {
      const hash = meta.txHash ?? hashOf(meta);
      const tx: FixtureTx = { hash, meta, commitAt: Number.POSITIVE_INFINITY, accepted: false, log, epoch: 0 };
      this.txs.set(hash, tx);
      return { hash, accepted: false, code: 1, log };
    };

    if (meta.kind !== "deposit") {
      const expectedNonce = (this.nonces.get(meta.sender) ?? 0n) + 1n;
      if (BigInt(meta.nonce) !== expectedNonce) {
        return reject(`invalid nonce: got ${meta.nonce}, expected ${expectedNonce}`);
      }
      for (const input of meta.inputs) {
        const vtxo = this.vtxoMap.get(input.vtxoId);
        if (!vtxo) return reject(`vtxo not found: ${input.vtxoId}`);
        if (vtxo.spent) return reject(`vtxo already spent: ${input.vtxoId}`);
        if (vtxo.owner !== meta.sender) return reject(`vtxo ${input.vtxoId} is not owned by ${meta.sender}`);
      }
      const inTotal = meta.inputs.reduce((sum, i) => sum + BigInt(i.valueSats ?? "0"), 0n);
      const outTotal = meta.outputs.reduce((sum, o) => sum + BigInt(o.amountSats), 0n);
      if (outTotal + BigInt(meta.feeSats) > inTotal) {
        return reject(`insufficient inputs: ${inTotal} in, ${outTotal + BigInt(meta.feeSats)} out`);
      }
      for (const output of meta.outputs) {
        if (BigInt(output.amountSats) <= 0n) return reject("output value must be positive");
      }
    }

    const hash = meta.txHash ?? hashOf(meta);
    const commitAt = this.now() + this.options.commitDelaySeconds * 1000;
    this.txs.set(hash, { hash, meta, commitAt, accepted: true, log: "", epoch: 0 });
    this.nonces.set(meta.sender, BigInt(meta.nonce));
    // Pending outputs are visible immediately so the pay page can show "pending" honestly.
    for (const [index, output] of meta.outputs.entries()) {
      const id = meta.createdVtxoIds[index];
      if (!id) continue;
      this.vtxoMap.set(id, {
        id,
        owner: output.owner,
        amountSats: BigInt(output.amountSats),
        spent: false,
        epoch: 0,
        commitAt,
        txHash: hash,
      });
    }
    this.advance();
    return { hash, accepted: true, code: 0, log: "" };
  }

  async txStatus(hash: string): Promise<TxStatusView> {
    this.advance();
    const tx = this.txs.get(hash);
    if (!tx) return { found: false, state: "pending", code: 0, log: "", epoch: 0, confirmations: 0 };
    if (!tx.accepted) {
      return { found: true, state: "rejected", code: tx.code ?? 1, log: tx.log, epoch: 0, confirmations: 0, type: tx.meta.kind, txid: hash };
    }
    const committed = tx.epoch !== 0;
    return {
      found: true,
      state: committed ? "committed" : "pending",
      code: 0,
      log: tx.log,
      epoch: tx.epoch,
      timeSec: Math.floor(tx.commitAt / 1000),
      type: tx.meta.kind,
      txid: hash,
      confirmations: committed ? 1 : 0,
    };
  }

  async bitcoinRpc<T = unknown>(method: string, params: unknown[] = []): Promise<{ result: T | null; error: { code: number; message: string } | null }> {
    switch (method) {
      case "getblockchaininfo":
        return { result: { chain: "regtest", blocks: 100 + this.epoch, headers: 100 + this.epoch, verificationprogress: 1 } as unknown as T, error: null };
      case "getblockcount":
        return { result: (100 + this.epoch) as unknown as T, error: null };
      case "getbalances": {
        // bitcoind reports BTC as a float, so the fixture does too. Returning sats here would make
        // the adapter's unit conversion wrong in exactly the way a real deployment would hide.
        const address = String(params[0] ?? "merchant");
        const trusted = Number(this.onchain.get(address) ?? 0n) / 1e8;
        return { result: { mine: { trusted, untrusted_pending: 0 } } as unknown as T, error: null };
      }
      case "estimatesmartfee":
        return { result: { feerate: 0.00001, blocks: 1 } as unknown as T, error: null };
      default:
        return { result: null, error: { code: -32601, message: `fixture-daemon: ${method} is not implemented` } };
    }
  }

  async faucet(address: string, amountSats?: bigint) {
    const amount = amountSats ?? this.options.faucetSats;
    const txid = `fixturefaucet${(this.onchainTxs.length + 1).toString().padStart(4, "0")}${Math.random().toString(16).slice(2, 10)}`;
    this.onchain.set(address, (this.onchain.get(address) ?? 0n) + amount);
    this.onchainTxs.push({ txid, address, amountSats: amount, at: this.now() });
    return { txid, detail: `fixture credited ${amount} sats to ${address}` };
  }

  /** On-chain balance the fixture has credited via the faucet, for the on/off-chain split. */
  onchainBalance(address: string): bigint {
    return this.onchain.get(address) ?? 0n;
  }

  uptimeSeconds(): number {
    return Math.floor((this.now() - this.startedAt) / 1000);
  }
}

/**
 * Fallback transaction id when the caller did not supply the real one. Only used by fixture
 * traffic that bypasses the rail; every rail-produced transaction carries its true
 * `sha256(encodeTachiTx)`.
 */
function hashOf(meta: BroadcastMeta): string {
  const payload = JSON.stringify([meta.kind, meta.sender, meta.nonce, meta.inputs, meta.outputs, meta.feeSats]);
  let h1 = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h1 ^= payload.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${payload.length.toString(16).padStart(4, "0")}`.padEnd(64, "0").slice(0, 64);
}

export function explorerUrlFor(txid: string, base = process.env.TACHI_EXPLORER_URL ?? REGTEST_EXPLORER): string {
  return `${base.replace(/\/$/, "")}/tx/${encodeURIComponent(txid)}`;
}
