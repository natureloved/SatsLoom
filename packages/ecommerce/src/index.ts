export type SatsLoomCheckoutInput = {
  orderId: string;
  amountSats: string | number | bigint;
  memo?: string;
  webhookUrl?: string;
};

export type SatsLoomCheckoutSession = {
  checkoutSessionId: string;
  invoiceId: string;
  amountSats: string;
  memo?: string;
  paymentStatus: string;
  paymentUrl: string;
  qrPayload?: string | null;
  simulation?: boolean;
};

export type InvoiceStatusResponse = {
  id: string;
  amountSats: string;
  memo?: string;
  status: "created" | "pending" | "confirmed" | "failed" | "refunded";
  lifecycle: string;
  simulation?: boolean;
  settlement?: {
    status: string;
    txid?: string;
    simulation: boolean;
  };
};

export class SatsLoomMerchantClient {
  /** Pass an API origin for server-side use; browsers default to their own origin. */
  constructor(
    private readonly baseUrl = "",
    private readonly checkoutBaseUrl = baseUrl,
  ) {}

  private get normalizedBase(): string {
    return this.baseUrl.replace(/\/$/, "");
  }

  async createCheckout(input: SatsLoomCheckoutInput): Promise<SatsLoomCheckoutSession> {
    const response = await fetch(`${this.normalizedBase}/api/checkout/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `checkout:${input.orderId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 150)}`,
      },
      body: JSON.stringify({ ...input, amountSats: input.amountSats.toString() }),
    });
    const envelope = await response.json();
    if (!response.ok) throw new Error(envelope.error ?? "SatsLoom checkout creation failed");
    const checkoutBase = this.checkoutBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");
    const paymentUrl = checkoutBase ? new URL(envelope.data.paymentUrl, checkoutBase).href : envelope.data.paymentUrl;
    return { ...envelope.data, paymentUrl, simulation: envelope.simulation === true || envelope.data.simulation === true };
  }

  async checkPaymentStatus(invoiceId: string): Promise<InvoiceStatusResponse> {
    const response = await fetch(`${this.normalizedBase}/api/invoices/${encodeURIComponent(invoiceId)}`);
    const envelope = await response.json();
    if (!response.ok) throw new Error(envelope.error ?? "Failed to fetch invoice status");
    return { ...envelope.data, simulation: envelope.data.simulation === true || envelope.demo === true };
  }

  /** Subscribe to demo application events only; never fulfill an order from these events. */
  subscribeToPayment(invoiceId: string, onConfirmed: (event: unknown) => void): EventSource {
    const source = new EventSource(`${this.normalizedBase}/api/invoices/${encodeURIComponent(invoiceId)}/events`);
    source.addEventListener("payment.confirmed", (event) => onConfirmed(JSON.parse((event as MessageEvent).data)));
    return source;
  }

  /**
   * Demonstration helper only. It consumes the SatsLoom signed demo receipt;
   * it is not a Bitcoin payment client and must not be used to fulfill orders.
   */
  async fetchWithX402(url: string, init?: RequestInit): Promise<Response> {
    const configuredOrigin = this.normalizedBase
      ? new URL(this.normalizedBase).origin
      : typeof window !== "undefined" ? window.location.origin : null;
    if (!configuredOrigin) throw new Error("Pass an API origin when using the x402 demo helper outside a browser");

    let resourceUrl: URL;
    try { resourceUrl = new URL(url, configuredOrigin); }
    catch { throw new Error("x402 demo resource URL must be valid"); }
    if (resourceUrl.origin !== configuredOrigin) {
      throw new Error("The SatsLoom demo receipt is restricted to the configured API origin and will not be sent to another host");
    }

    const firstAttempt = await fetch(resourceUrl.href, init);
    if (firstAttempt.status !== 402) return firstAttempt;

    const challenge = firstAttempt.headers.get("www-authenticate") ?? "";
    const invoiceId = firstAttempt.headers.get("x-402-invoice-id");
    if (!challenge.startsWith("SatsLoom-Demo ") || !challenge.includes('simulation="true"') || !invoiceId) {
      throw new Error("HTTP 402 response is not a SatsLoom signed-receipt simulation challenge");
    }

    // Mark the sample invoice as paid in demo application state only.
    const payResponse = await fetch(new URL("/api/x402/agent-pay", configuredOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoiceId }),
    });
    const payEnvelope = await payResponse.json();
    const proofToken = payEnvelope?.data?.proofToken;
    if (!payResponse.ok || typeof proofToken !== "string") {
      throw new Error(`Failed to obtain a signed simulation receipt for x402 demo invoice ${invoiceId}`);
    }

    // Replay only to the same configured host with a signed demo receipt—not payment proof.
    const headers = new Headers(init?.headers);
    headers.set("Authorization", proofToken);
    return fetch(resourceUrl.href, { ...init, headers });
  }
}
