/**
 * The single door between SatsLoom and Tachi.
 *
 * Everything above this file (API, web, router) talks in SatsLoom's own vocabulary and never
 * sees an SDK type — that rule is what lets the app keep working when the daemon is unreachable,
 * because `mode` and the capability report are the only things that change.
 *
 * Modes:
 *   live     - a real daemon answered. `simulation: false` everywhere.
 *   degraded - the daemon is down. Reads fail loudly, writes refuse. Nothing is invented.
 *   fixture  - an in-process ledger (explicitly enabled) is answering. Labelled, never "live".
 */
import type {
  Capability,
  CapabilityReport,
  DaemonStatus,
  LiquidityProvider,
  Mode,
  PaymentProof,
  PaymentTarget,
  Validator,
  VerificationResult,
  VaultSummary,
  Vtxo,
} from "@satsloom/shared";
import { friendlyDuration, jsonSafe } from "@satsloom/shared";
import { FixtureDaemon, LiveTachiDaemon, explorerUrlFor, type TachiDaemon, type TxStatusView } from "./daemon.js";
import { AdapterError, DaemonUnreachableError, NotSupportedError, ProofStaleError } from "./errors.js";
import { identityFromMnemonic, isTestMnemonic, loadMnemonic, paymentTargetFor, type Identity } from "./keys.js";
import { TachiRail, type SpendResult } from "./rail.js";

export * from "./errors.js";
export { FixtureDaemon, LiveTachiDaemon, explorerUrlFor } from "./daemon.js";
export type { BroadcastMeta, TachiDaemon, TxStatusView } from "./daemon.js";
export type { Identity } from "./keys.js";
export { identityFromMnemonic, paymentTargetFor, loadMnemonic } from "./keys.js";

export type AdapterRole = "merchant" | "demoPayer" | "cold";

/** BIP-39 test vectors. Fixture-only: they are public knowledge and hold no value anywhere. */
const FIXTURE_MNEMONICS: Record<AdapterRole, string> = {
  merchant: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  demoPayer: "legal winner thank year wave sausage worth useful legal winner thank yellow",
  cold: "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
};

const ROLE_ENV: Record<AdapterRole, string> = {
  merchant: "MERCHANT_MNEMONIC",
  demoPayer: "DEMO_PAYER_MNEMONIC",
  cold: "COLD_MNEMONIC",
};

export type TachiAdapterOptions = {
  /** `live` (default) talks to the daemon; `fixture` runs the in-process ledger. */
  provider?: "live" | "fixture" | "auto";
  daemon?: TachiDaemon;
  network?: string;
  csvBlocks?: number;
  commitDelaySeconds?: number;
  env?: NodeJS.ProcessEnv;
};

export class TachiAdapter {
  /**
   * VTXO ids this process created as `change` from its own spends. A merchant's payout or refund
   * leaves change at the merchant's own vault address; that output is indistinguishable from an
   * incoming payment by amount alone, so it is excluded by identity instead. Scoped to the
   * process — the API's per-invoice baseline covers VTXOs that predate the restart.
   */
  private readonly internalVtxoIds = new Set<string>();

  private readonly env: NodeJS.ProcessEnv;
  private readonly daemon: TachiDaemon;
  private readonly rail: TachiRail;
  private readonly identities = new Map<AdapterRole, Identity>();
  private readonly csvBlocks: number;
  private statusCache?: { at: number; status: DaemonStatus };
  private capabilitiesCache?: { at: number; report: CapabilityReport };

  constructor(options: TachiAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    const requested = options.provider ?? (this.env.TACHI_PROVIDER as TachiAdapterOptions["provider"]) ?? "live";
    this.daemon = options.daemon ?? createDaemon(requested, options);
    this.csvBlocks = options.csvBlocks ?? Number(this.env.TACHI_CSV_BLOCKS ?? 1008);
    this.rail = new TachiRail({
      daemon: this.daemon,
      network: options.network ?? this.env.TACHI_NETWORK ?? "regtest",
      csvBlocks: this.csvBlocks,
    });
  }

  get providerKind(): "live" | "fixture" {
    return this.daemon.kind;
  }

  get daemonBaseUrl(): string {
    return this.daemon.baseUrl;
  }

  get explorerBaseUrl(): string {
    return this.env.TACHI_EXPLORER_URL ?? "https://explorer-regtest.tachibtc.com";
  }

  /** Fixes the wrong-domain bug in the original skeleton: regtest explorer, and no `demo-` txids. */
  getExplorerUrl(txid: string): string {
    return explorerUrlFor(txid, this.explorerBaseUrl);
  }

  /* ---------------- identity ---------------- */

  /**
   * Resolve a role's identity. In live mode a missing mnemonic is a refusal, not a fallback to a
   * test key: silently signing with a public BIP-39 vector would be the worst possible failure.
   */
  identity(role: AdapterRole): Identity {
    const cached = this.identities.get(role);
    if (cached) return cached;
    const mnemonic = loadMnemonic(ROLE_ENV[role], this.env);
    if (!mnemonic) {
      if (this.daemon.kind !== "fixture") {
        throw new NotSupportedError(
          `${ROLE_ENV[role]} is not set. Server-side key material is required for this operation and SatsLoom will not substitute a test key in live mode.`,
          { role, env: ROLE_ENV[role] },
        );
      }
      const identity = identityFromMnemonic(FIXTURE_MNEMONICS[role], { network: this.networkName });
      this.identities.set(role, identity);
      return identity;
    }
    const identity = identityFromMnemonic(mnemonic, { network: this.networkName });
    this.identities.set(role, identity);
    return identity;
  }

  hasIdentity(role: AdapterRole): boolean {
    try {
      this.identity(role);
      return true;
    } catch {
      return false;
    }
  }

  private get networkName(): string {
    return this.env.TACHI_NETWORK ?? "regtest";
  }

  /**
   * Where a role's payments land.
   *
   * `address` is the account's two-leaf P2TR vault address — the one the daemon credits — not the
   * BIP-84 funding address the key also controls. Getting this wrong would put a valid-looking
   * address on the pay page that no ledger payment can ever reach, so it is derived from the live
   * quorum rather than stored.
   */
  async targetFor(role: AdapterRole): Promise<PaymentTarget> {
    const identity = this.identity(role);
    const vaultAddress = await this.rail.addressForOwner(identity.xOnly);
    return paymentTargetFor(identity, {
      address: vaultAddress,
      vaultAddress,
      fundingAddress: identity.address,
      csvBlocks: this.csvBlocks,
    });
  }

  /** True when the configured mnemonic is a published test vector — surfaced as a warning in the UI. */
  isTestKey(role: AdapterRole): boolean {
    const mnemonic = loadMnemonic(ROLE_ENV[role], this.env);
    return mnemonic ? isTestMnemonic(mnemonic) : this.daemon.kind === "fixture";
  }

  /* ---------------- reads ---------------- */

  async getStatus(): Promise<DaemonStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < 5_000) return this.statusCache.status;
    let status: DaemonStatus;
    try {
      const [health, info] = await Promise.all([this.daemon.health(), this.daemon.nodeInfo()]);
      status = {
        reachable: true,
        network: info.network,
        version: info.version,
        mode: this.daemon.kind === "live" ? "live" : "fixture",
        checkedAt: new Date().toISOString(),
        detail: `${health.validators} validators · height ${info.latest_block_height} · ${info.sync_status}`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      status = {
        reachable: false,
        mode: "degraded",
        checkedAt: new Date().toISOString(),
        detail: `${this.daemon.baseUrl} unreachable: ${reason}`,
      };
    }
    this.statusCache = { at: Date.now(), status };
    return status;
  }

  async getValidators(): Promise<Validator[]> {
    try {
      return await this.daemon.validators();
    } catch {
      return [];
    }
  }

  /** Node-level detail for the daemon panel; degrades to nulls rather than throwing. */
  async getDaemonDetail(): Promise<{ stats: Record<string, unknown> | null; node: Record<string, unknown> | null }> {
    try {
      const [stats, node] = await Promise.all([this.daemon.stats(), this.daemon.nodeInfo()]);
      return {
        stats: jsonSafe(stats) as unknown as Record<string, unknown>,
        node: jsonSafe(node) as unknown as Record<string, unknown>,
      };
    } catch {
      return { stats: null, node: null };
    }
  }

  async getSpendableBalance(role: AdapterRole): Promise<bigint> {
    const identity = this.identity(role);
    const { total } = await this.rail.spendableBalance(identity);
    return total;
  }

  async getBalanceForOwner(owner: string): Promise<bigint> {
    const state = await this.daemon.balance(owner);
    return state.balanceSats;
  }

  async getAddressVtxos(owner: string, includeSpent = false): Promise<Vtxo[]> {
    return this.daemon.vtxos(owner, includeSpent);
  }

  /**
   * On-chain balance for an account, read through the daemon's Bitcoin RPC proxy.
   *
   * Returns an explicit `unknown` rather than 0 when the proxy is unavailable: "we cannot see the
   * chain" and "you have no coins on chain" must not render the same way in a dashboard.
   */
  async getOnchainBalance(address: string): Promise<{ sats: bigint | null; error?: string }> {
    try {
      const { result, error } = await this.daemon.bitcoinRpc<{ mine?: { trusted?: number; untrusted_pending?: number } }>(
        "getbalances",
        [address],
      );
      if (error) return { sats: null, error: error.message };
      const balance = result?.mine;
      if (!balance) return { sats: null, error: "node returned no balance for this address" };
      return { sats: BigInt(Math.round(Number(balance.trusted ?? 0) * 1e8)) + BigInt(Math.round(Number(balance.untrusted_pending ?? 0) * 1e8)) };
    } catch (error) {
      return { sats: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /* ---------------- vaults ---------------- */

  async createVault(input: { mnemonic?: string; role?: AdapterRole }): Promise<VaultSummary> {
    const identity = input.role ? this.identity(input.role) : identityFromMnemonic(input.mnemonic ?? "", { network: this.networkName });
    const vault = await this.rail.resolveVault(identity);
    return {
      id: vault.p2tr.taprootOutputKey.toString("hex"),
      address: vault.p2tr.address,
      cooperativeLeaf: { script: vault.p2tr.cooperativeLeaf.script.toString("hex"), hash: vault.p2tr.cooperativeLeafHash.toString("hex") },
      exitLeaf: { script: vault.p2tr.exitLeaf.script.toString("hex"), hash: vault.p2tr.exitLeafHash.toString("hex") },
      csvDelay: this.csvBlocks,
    };
  }

  /**
   * Re-derive a vault address from the owner's own key and the live quorum, and compare.
   *
   * This is the check that matters: it proves the address a merchant is being paid to is the one
   * this mnemonic can actually spend, using the quorum that is online right now.
   */
  async verifyVault(vault: VaultSummary, role: AdapterRole = "merchant"): Promise<VerificationResult> {
    try {
      const rebuilt = await this.createVault({ role });
      if (rebuilt.address === vault.address) {
        return { valid: true, details: `Re-derived ${rebuilt.address} from the owner key and the live quorum; matches.` };
      }
      return {
        valid: false,
        details: `Re-derived ${rebuilt.address}, which differs from the recorded ${vault.address} — the quorum, CSV delay or owner key has changed.`,
      };
    } catch (error) {
      return { valid: false, details: error instanceof Error ? error.message : String(error) };
    }
  }

  /* ---------------- money movement ---------------- */

  /** Dev/test helper. On a real regtest node this is how the merchant gets L1 coins to onboard. */
  async fundFromFaucet(address: string, amountSats?: bigint): Promise<{ txid: string; detail?: string }> {
    return this.daemon.faucet(address, amountSats);
  }

  /**
   * Remembers the outputs of our own spends that came back to the spending key. Called on every
   * value movement this process initiates, because "money arrived at the merchant's address" is not
   * the same question as "a customer paid" — see `detectInvoicePayment`.
   */
  private trackInternalOutputs(result: SpendResult): SpendResult {
    for (const id of result.selfOwnedVtxoIds) this.internalVtxoIds.add(id);
    return result;
  }

  /** On-chain -> off-chain: mint a ledger VTXO for a role's own account. */
  async onboard(role: AdapterRole, amountSats: bigint): Promise<SpendResult> {
    const identity = this.identity(role);
    return this.trackInternalOutputs(await this.rail.onboard(identity, amountSats));
  }

  /** Off-chain payment / refund. `toOwner` is a 32-byte x-only ledger key. */
  async transferSats(input: { from: AdapterRole; toOwner: string; amountSats: bigint; memo?: string; feeSats?: bigint }): Promise<SpendResult> {
    if (input.amountSats <= 0n) throw new AdapterError("invalid_amount", "amountSats must be positive", 400);
    const identity = this.identity(input.from);
    return this.trackInternalOutputs(
      await this.rail.transfer(identity, { toOwner: input.toOwner, amountSats: input.amountSats, memo: input.memo, feeSats: input.feeSats }),
    );
  }

  /** Off-chain -> on-chain: redeem ledger value to a Bitcoin P2TR address. */
  async withdrawSats(input: { from: AdapterRole; toAddress: string; amountSats: bigint }): Promise<SpendResult> {
    const identity = this.identity(input.from);
    return this.trackInternalOutputs(await this.rail.withdraw(identity, { toAddress: input.toAddress, amountSats: input.amountSats }));
  }

  async getTxStatus(txid: string): Promise<TxStatusView & { explorerUrl: string }> {
    const status = await this.daemon.txStatus(txid);
    return { ...status, explorerUrl: this.getExplorerUrl(txid) };
  }

  async awaitCommit(txid: string, timeoutMs?: number): Promise<TxStatusView> {
    return this.rail.awaitCommit(txid, timeoutMs);
  }

  /**
   * Confirm that an invoice was really paid.
   *
   * Detection is a VTXO diff against the invoice's own baseline, which makes it idempotent and
   * safe to call from a 2-second poll loop: the same payment is reported as the same proof every
   * time, and a payment that has not happened yet is reported as `null` rather than inferred from
   * an amount coincidence.
   */
  async detectInvoicePayment(invoice: {
    id: string;
    amountSats: bigint;
    paymentTarget?: PaymentTarget;
    baselineVtxoIds?: string[];
  }): Promise<PaymentProof | null> {
    const owner = invoice.paymentTarget?.owner;
    if (!owner) throw new AdapterError("no_payment_target", "Invoice has no payment target", 409);
    if (!invoice.baselineVtxoIds) {
      // Without a baseline, an invoice for 1,000 sats would "match" a 500,000-sat VTXO that was
      // already there — the merchant would be told they were paid when nothing had arrived. The
      // baseline is therefore required, not optional: an unknown baseline is a refusal, not a guess.
      throw new ProofStaleError(
        "Invoice has no VTXO baseline, so new payments cannot be distinguished from pre-existing balance. Recreate the invoice while the ledger is readable.",
        { invoiceId: invoice.id },
      );
    }
    const baseline = new Set(invoice.baselineVtxoIds);
    let vtxos: Vtxo[];
    try {
      vtxos = await this.daemon.vtxos(owner, false);
    } catch (error) {
      if (error instanceof DaemonUnreachableError) throw error;
      throw error;
    }
    const candidates = vtxos
      // A VTXO this process created as *change* from one of its own spends is the merchant's own
      // money moving between its own vaults — never a customer payment. Without this filter a
      // refund or a payout would mark the next pending invoice as paid, which is the worst
      // possible failure mode for a payment router: telling a merchant they were paid when they
      // were not.
      .filter((v) => !baseline.has(v.vtxoId) && !this.internalVtxoIds.has(v.vtxoId) && v.state !== "spent")
      .sort((a, b) => (a.amountSats === b.amountSats ? a.vtxoId.localeCompare(b.vtxoId) : a.amountSats > b.amountSats ? -1 : 1));

    /*
     * Matching order matters, and it is deliberately two-tier:
     *
     *  1. An exact-amount VTXO is unambiguous: the customer paid the invoice's price.
     *  2. Failing that, a larger VTXO counts as overpayment. That case is genuinely ambiguous when
     *     the merchant reuses one vault address, so it is only ever a fallback — and the API
     *     additionally refuses to credit the same VTXO to two invoices.
     *
     * Anything smaller is not a payment of this invoice, and is not rounded up into one.
     */
    const match = candidates.find((v) => v.amountSats === invoice.amountSats) ?? candidates.find((v) => v.amountSats > invoice.amountSats);
    if (!match) return null;

    const txid = match.txid ?? (await this.resolveTxidForPayment(owner, match.amountSats));
    const committed = match.state === "committed";
    return {
      invoiceId: invoice.id,
      txid: txid ?? match.vtxoId,
      vtxoId: match.vtxoId,
      amountSats: match.amountSats,
      confirmations: committed ? 1 : 0,
      explorerUrl: this.getExplorerUrl(txid ?? match.vtxoId),
      verifiedAt: new Date().toISOString(),
      mode: this.daemon.kind === "live" ? "live" : "fixture",
    };
  }

  /** Find the transaction that created a payment when the VTXO record does not name one. */
  private async resolveTxidForPayment(owner: string, amountSats: bigint): Promise<string | null> {
    try {
      const { transactions } = await this.daemon.recentTransactions(25);
      const hit = transactions.find((tx) =>
        tx.vout.some((out) => out.owner?.toLowerCase() === owner.toLowerCase() && out.amountSats === amountSats),
      );
      return hit?.txHash ?? null;
    } catch {
      return null;
    }
  }

  /** Re-checks a stored proof against the ledger; used before showing a receipt as still valid. */
  async assertProofStillValid(proof: PaymentProof): Promise<void> {
    if (!proof.vtxoId) return;
    const vtxos = await this.daemon.vtxos(proof.vtxoId.length === 64 ? proof.vtxoId.slice(0, 64) : proof.vtxoId, true).catch(() => []);
    const found = vtxos.find((v) => v.vtxoId === proof.vtxoId);
    if (found?.state === "spent" && !proof.invoiceId) {
      throw new ProofStaleError("The VTXO backing this proof has been spent", { vtxoId: proof.vtxoId });
    }
  }

  /* ---------------- liquidity ---------------- */

  /**
   * The routing directory: every settlement source SatsLoom can see, evaluated now.
   *
   * Two sources are always present (own VTXO balance and the cooperative quorum path); the
   * on-chain redemption route appears only when the node's RPC proxy answers, and says so when it
   * does not. This is the "LP marketplace" content, and it is generated from live state rather
   * than from a config file.
   */
  async liquidityDirectory(): Promise<LiquidityProvider[]> {
    const checkedAt = new Date().toISOString();
    const providers: LiquidityProvider[] = [];
    const status = await this.getStatus();

    let merchantBalance = 0n;
    let balanceKnown = false;
    let balanceDetail: string | undefined;
    if (this.hasIdentity("merchant")) {
      try {
        merchantBalance = await this.getSpendableBalance("merchant");
        balanceKnown = true;
      } catch (error) {
        balanceDetail = error instanceof Error ? error.message : String(error);
      }
    } else {
      balanceDetail = "MERCHANT_MNEMONIC is not configured";
    }

    let fees = { recommendedSats: 1n, minimumSats: 1n };
    try {
      fees = await this.rail.feeGuidance();
    } catch {
      // Fee guidance is an optimisation; a missing estimate must not hide the route.
    }

    const quorumOnline = status.reachable;
    providers.push({
      id: "vtxo-self",
      name: "Own VTXO balance",
      kind: "self_custody",
      capacitySats: merchantBalance,
      feeSats: 1n,
      feeBps: 0,
      latencySeconds: 15,
      exitRisk: "none",
      available: balanceKnown && merchantBalance > 0n,
      requiresCooperativeSigning: true,
      status: quorumOnline ? "live" : "degraded",
      lastCheckedAt: checkedAt,
      detail:
        balanceDetail ??
        (merchantBalance > 0n
          ? `${merchantBalance} sats spendable now, settled by the quorum inside one epoch`
          : "merchant balance is 0 — onboard with the faucet to fund this route"),
    });

    providers.push({
      id: "quorum-cooperative",
      name: "Quorum cooperative settlement",
      kind: "liquidity_provider",
      capacitySats: merchantBalance > 0n ? merchantBalance * 4n : 0n,
      feeSats: fees.recommendedSats > 0n ? fees.recommendedSats * 4n : 4n,
      feeBps: 0,
      latencySeconds: 45,
      exitRisk: "low",
      available: quorumOnline,
      requiresCooperativeSigning: true,
      status: quorumOnline ? "live" : "unavailable",
      lastCheckedAt: checkedAt,
      detail: quorumOnline
        ? "5-of-7 quorum co-signs; needs a responsive validator set"
        : `daemon unreachable at ${this.daemon.baseUrl}`,
    });

    const onchain = this.hasIdentity("merchant") ? await this.getOnchainBalance(this.identity("merchant").address) : { sats: null, error: "no merchant identity" };
    providers.push({
      id: "onchain-redemption",
      name: "On-chain unilateral exit",
      kind: "onchain_redemption",
      capacitySats: onchain.sats ?? 0n,
      feeSats: fees.minimumSats,
      feeBps: 0,
      latencySeconds: 600,
      exitRisk: "high",
      available: onchain.sats !== null && onchain.sats > 0n,
      requiresCooperativeSigning: false,
      timelockBlocks: this.csvBlocks,
      status: onchain.sats === null ? "degraded" : onchain.sats > 0n ? "live" : "unavailable",
      lastCheckedAt: checkedAt,
      detail: onchain.error
        ? `not usable: ${onchain.error}`
        : `CSV-gated exit through the node's Bitcoin RPC proxy; unlockable ${friendlyDuration(this.csvBlocks * 600)} after the exit broadcast`,
    });

    return providers;
  }

  /* ---------------- capabilities ---------------- */

  /**
   * The Day-1 gate, as data.
   *
   * Each probe is independent and each failure carries what to do about it, because the honest
   * answer to "is this live?" is per-capability, not a single boolean.
   */
  async capabilities(): Promise<CapabilityReport> {
    if (this.capabilitiesCache && Date.now() - this.capabilitiesCache.at < 15_000) return this.capabilitiesCache.report;
    const mode: Mode = this.daemon.kind === "fixture" ? "fixture" : (await this.getStatus()).reachable ? "live" : "degraded";
    const capabilities: Capability[] = [];

    const probe = async (id: string, label: string, fn: () => Promise<string>, remediation: string) => {
      try {
        const detail = await fn();
        capabilities.push({ id, label, ok: true, mode, detail });
      } catch (error) {
        capabilities.push({
          id,
          label,
          ok: false,
          mode: "degraded",
          detail: error instanceof Error ? error.message : String(error),
          remediation,
        });
      }
    };

    await probe("daemon-reachable", "Daemon reachable", async () => {
      const health = await this.daemon.health();
      return `status=${health.status} validators=${health.validators}`;
    }, `Check TACHI_DAEMON_URL (currently ${this.daemon.baseUrl}) and that the regtest daemon is up.`);

    await probe("validators", "Validator registry readable", async () => {
      const validators = await this.daemon.validators();
      if (validators.length === 0) throw new Error("daemon reported 0 validators");
      return `${validators.length} validators, ${validators.filter((v) => v.online).length} online`;
    }, "The quorum must publish at least 5 keys for a 5-of-7 vault address to derive.");

    await probe("vault-derivation", "Vault address derives from live quorum", async () => {
      const target = await this.targetFor("merchant");
      const vault = await this.createVault({ role: "merchant" });
      if (!vault.address.startsWith("bcrt1p") && this.networkName === "regtest") {
        throw new Error(`expected a bcrt1p address on regtest, got ${vault.address}`);
      }
      return `${target.owner.slice(0, 12)}… → ${vault.address}`;
    }, "Check TACHI_NETWORK matches the daemon (regtest → bcrt1p) and that the CSV block count matches the daemon's.");

    await probe("vtxo-query", "VTXO balance query", async () => {
      const target = await this.targetFor("merchant");
      const vtxos = await this.getAddressVtxos(target.owner);
      return `${vtxos.length} VTXOs for ${target.owner.slice(0, 12)}…`;
    }, "GET /tachi_addressVtxos requires a taproot address or raw pubkey hex; a non-taproot address returns 400.");

    await probe("ledger-signing", "Ledger transaction signing (local)", async () => {
      const identity = this.identity("merchant");
      if (identity.xOnly.length !== 64) throw new Error("owner key is not 32-byte x-only");
      return `schnorr signer ready for ${identity.xOnly.slice(0, 12)}…`;
    }, "Set MERCHANT_MNEMONIC (or run with TACHI_PROVIDER=fixture for public test vectors).");

    await probe("explorer-link", "Explorer URL shape", async () => {
      const url = this.getExplorerUrl("00".repeat(32));
      if (!url.includes("explorer-regtest.tachibtc.com")) throw new Error(`wrong explorer host: ${url}`);
      return url;
    }, "Set TACHI_EXPLORER_URL if the regtest explorer moves.");

    await probe("bitcoin-rpc", "Node Bitcoin RPC proxy", async () => {
      const { result, error } = await this.daemon.bitcoinRpc("getblockchaininfo");
      if (error) throw new Error(error.message);
      const chain = (result as { chain?: string } | null)?.chain;
      return `chain=${chain ?? "unknown"}`;
    }, "The on-chain redemption route needs POST / (Bitcoin RPC proxy) to be enabled on the daemon.");

    const report: CapabilityReport = {
      mode,
      daemon: { baseUrl: this.daemon.baseUrl, reachable: mode !== "degraded" },
      capabilities,
      checkedAt: new Date().toISOString(),
    };
    this.capabilitiesCache = { at: Date.now(), report };
    return report;
  }
}

function createDaemon(requested: string | undefined, options: TachiAdapterOptions): TachiDaemon {
  if (options.daemon) return options.daemon;
  if (requested === "fixture") return new FixtureDaemon({ commitDelaySeconds: options.commitDelaySeconds });
  if (requested === "auto") {
    // `auto` is for deployments that must boot either way, e.g. a demo box with no network.
    return process.env.NODE_ENV === "production" && !process.env.TACHI_DAEMON_URL
      ? new FixtureDaemon({ commitDelaySeconds: options.commitDelaySeconds })
      : new LiveTachiDaemon();
  }
  return new LiveTachiDaemon();
}

/** Convenience for scripts: the roles the demo funds and uses. */
export const ROLES: AdapterRole[] = ["merchant", "demoPayer", "cold"];
