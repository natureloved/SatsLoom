/**
 * LND over its REST interface.
 *
 * Why REST and not gRPC: the repo already depends on `node:https` (webhook delivery), and a REST
 * client is auditable in one file with no protobuf toolchain. The tradeoff is real and worth
 * stating: LND's REST is served by `lnd` only when `restlisten` is enabled, it needs the macaroon
 * in a header, and the connection is typically to a self-signed certificate — hence the explicit
 * `caCertPath` option rather than a blanket "ignore certificate errors".
 *
 * Security posture:
 *   - https is required unless `allowInsecureHttp` is set for a node on a private/local network;
 *   - redirects are never followed (an injected redirect must not be able to move a payment);
 *   - the macaroon is sent per request and never logged;
 *   - a timeout is enforced on every call.
 *
 * HONEST STATUS: this client is unit-tested against a stub HTTP server that speaks LND's request
 * and response shapes, which proves the paths, headers, base64/hex conversions and state mapping.
 * It has NOT been exercised against a real LND node from this repository — see the liveness audit
 * (`npm run audit:liveness`) which reports exactly that.
 */
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import type {
  BackendInvoice,
  BackendInvoiceStatus,
  LightningNodeBackend,
  PaymentState,
  RailHealth,
  RailLiquidity,
  RailNetwork,
} from "./index.js";
import { RailUnavailableError } from "./index.js";

export type LndRestBackendOptions = {
  /** e.g. https://127.0.0.1:8080 */
  baseUrl: string;
  /** Hex-encoded macaroon. Use the smallest macaroon that can issue invoices and read them. */
  macaroonHex: string;
  network: RailNetwork;
  timeoutMs?: number;
  /** PEM file for LND's self-signed TLS certificate. Strongly preferred over disabling verification. */
  caCertPath?: string;
  /** Only for a node reachable exclusively over a private network or Tor. Never for a public host. */
  allowInsecureHttp?: boolean;
};

type LndResponse = Record<string, unknown>;

const STATE_MAP: Record<string, PaymentState> = {
  OPEN: "pending",
  ACCEPTED: "pending",
  SETTLED: "paid",
  CANCELED: "cancelled",
};

export class LndRestBackend implements LightningNodeBackend {
  readonly kind = "lnd-rest";
  readonly network: RailNetwork;
  private readonly baseUrl: string;
  private readonly macaroonHex: string;
  private readonly timeoutMs: number;
  private readonly ca: Buffer | undefined;
  private readonly allowInsecureHttp: boolean;

  constructor(options: LndRestBackendOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new RailUnavailableError(`LND baseUrl is not a URL: ${options.baseUrl}`);
    }
    if (parsed.protocol !== "https:" && !(options.allowInsecureHttp && parsed.protocol === "http:")) {
      throw new RailUnavailableError(
        "LND baseUrl must use https (set allowInsecureHttp only for a node on a private network you control)",
      );
    }
    if (!/^[0-9a-fA-F]+$/.test(options.macaroonHex) || options.macaroonHex.length < 32) {
      throw new RailUnavailableError("LND macaroonHex must be a hex-encoded macaroon");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.macaroonHex = options.macaroonHex;
    this.network = options.network;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.ca = options.caCertPath ? readFileSync(options.caCertPath) : undefined;
  }

  /**
   * A backend is live when it can move real value: that is mainnet and nothing else. A signet or
   * regtest node is real infrastructure with worthless coins, and saying so is the whole point of
   * having this method.
   */
  isLive(): boolean {
    return this.network === "mainnet";
  }

  async getInfo(): Promise<RailHealth> {
    const info = await this.call("GET", "/v1/getinfo");
    return {
      reachable: true,
      synced: Boolean(info.synced_to_chain),
      blockHeight: typeof info.block_height === "number" ? info.block_height : undefined,
      nodePubkey: typeof info.identity_pubkey === "string" ? info.identity_pubkey : undefined,
      version: typeof info.version === "string" ? info.version : undefined,
      detail: `LND over REST (${this.network})`,
    };
  }

  async createInvoice(input: { amountMsat: bigint; description: string; expirySeconds: number }): Promise<BackendInvoice> {
    // LND accepts `value_msat` as a string, so sub-satoshi amounts survive the round trip.
    const body: Record<string, unknown> = {
      value_msat: input.amountMsat.toString(),
      memo: input.description,
      expiry: String(input.expirySeconds),
      private: true,
    };
    const response = await this.call("POST", "/v1/invoices", body);
    const paymentHash = typeof response.r_hash === "string" ? Buffer.from(response.r_hash, "base64").toString("hex") : undefined;
    const bolt11 = typeof response.payment_request === "string" ? response.payment_request : undefined;
    if (!paymentHash || !bolt11) throw new RailUnavailableError("LND did not return r_hash and payment_request for a new invoice");
    const creationDate = Number(response.creation_date ?? 0);
    const expiry = Number(response.expiry ?? input.expirySeconds);
    const expiresAt = creationDate > 0 ? creationDate + expiry : Math.floor(Date.now() / 1000) + input.expirySeconds;
    return { paymentHash, bolt11, expiresAt };
  }

  async lookupInvoice(paymentHash: string): Promise<BackendInvoiceStatus> {
    if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) throw new RailUnavailableError("payment hash must be 64 hex characters");
    let response: LndResponse;
    try {
      response = await this.call("GET", `/v1/invoice/${paymentHash.toLowerCase()}`);
    } catch (error) {
      // LND answers 404 for an unknown payment hash; that is a fact about the payment, not an outage.
      if (error instanceof RailUnavailableError && error.status === 404) return { state: "unknown" };
      throw error;
    }
    const rawState = typeof response.state === "string" ? response.state : "OPEN";
    const state = STATE_MAP[rawState] ?? "unknown";
    const paidMsat = response.amt_paid_msat !== undefined ? BigInt(String(response.amt_paid_msat)) : undefined;
    const settledAt = response.settle_date !== undefined && String(response.settle_date) !== "0" ? Number(response.settle_date) : undefined;
    // LND returns an empty preimage until the payment settles, which is exactly the signal the
    // credit path is designed to fail closed on.
    const preimage = typeof response.r_preimage === "string" && response.r_preimage.length > 0
      ? Buffer.from(response.r_preimage, "base64").toString("hex")
      : undefined;
    return { state, paidMsat, settledAt, preimage: preimage && /^[0-9a-f]{64}$/.test(preimage) ? preimage : undefined };
  }

  async liquidity(): Promise<RailLiquidity> {
    const response = await this.call("GET", "/v1/channels");
    const channels = Array.isArray(response.channels) ? (response.channels as LndResponse[]) : [];
    let outboundSats = 0n;
    let inboundSats = 0n;
    let active = 0;
    for (const channel of channels) {
      if (channel.active !== true) continue;
      active += 1;
      outboundSats += BigInt(String(channel.local_balance ?? "0"));
      // Inbound capacity for a single channel is bounded by what the peer can push to us. This is
      // a lower bound (the peer's balance), not the true routable inbound across the graph, which
      // is why the plan calls for a real inbound-liquidity strategy rather than trusting a number.
      inboundSats += BigInt(String(channel.remote_balance ?? "0"));
    }
    return {
      inboundSats,
      outboundSats,
      detail: `${active} active channel(s). Inbound is the peers' side of our own channels, a lower bound on receivables.`,
    };
  }

  private call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<LndResponse> {
    const url = new URL(this.baseUrl + path);
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const headers: Record<string, string> = {
      "grpc-metadata-macaroon": this.macaroonHex,
      accept: "application/json",
    };
    if (payload) headers["content-type"] = "application/json";
    if (payload) headers["content-length"] = String(payload.length);

    return new Promise<LndResponse>((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
          ca: this.ca,
          // Certificate verification stays on unless a CA was supplied; http is only reachable
          // when the constructor explicitly allowed it.
          rejectUnauthorized: url.protocol === "https:",
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              reject(new RailUnavailableError("LND returned a redirect; refusing to follow it", { details: { status, redirected: true } }));
              return;
            }
            if (status !== 200) {
              reject(new RailUnavailableError(`LND ${method} ${path} failed with HTTP ${status}: ${text.slice(0, 300)}`, { details: { status } }));
              return;
            }
            try {
              resolve(text ? (JSON.parse(text) as LndResponse) : {});
            } catch (error) {
              reject(new RailUnavailableError(`LND returned non-JSON for ${path}`, { cause: error }));
            }
          });
        },
      );
      request.setTimeout(this.timeoutMs, () => request.destroy(new RailUnavailableError(`LND request to ${path} timed out after ${this.timeoutMs}ms`)));
      request.on("error", (error) => {
        reject(new RailUnavailableError(`LND request to ${path} failed: ${error.message}`, { cause: error }));
      });
      if (payload) request.write(payload);
      request.end();
    });
  }
}

export type { BackendInvoice, LightningNodeBackend };
