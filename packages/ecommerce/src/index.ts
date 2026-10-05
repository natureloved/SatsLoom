export type SatsLoomCheckoutInput = {
  orderId: string;
  amountSats: string | number | bigint;
  memo?: string;
  webhookUrl?: string;
  redirectUrl?: string;
};

export type SatsLoomCheckoutSession = {
  checkoutSessionId: string;
  invoiceId: string;
  amountSats: string;
  memo?: string;
  paymentStatus: string;
  paymentUrl: string;
  qrPayload?: string;
};

export type InvoiceStatusResponse = {
  id: string;
  amountSats: string;
  memo?: string;
  status: "created" | "pending" | "confirmed" | "failed" | "refunded";
  lifecycle: string;
  settlement?: {
    status: string;
    txid?: string;
    simulation: boolean;
  };
};

export class SatsLoomMerchantClient {
  constructor(private readonly baseUrl = "http://127.0.0.1:3001") {}

  private get normalizedBase(): string {
    return this.baseUrl.replace(/\/$/, "");
  }

  async createCheckout(input: SatsLoomCheckoutInput): Promise<SatsLoomCheckoutSession> {
    const response = await fetch(`${this.normalizedBase}/api/checkout/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, amountSats: input.amountSats.toString() }),
    });
    const envelope = await response.json();
    if (!response.ok) throw new Error(envelope.error ?? "SatsLoom checkout creation failed");
    return envelope.data;
  }

  async checkPaymentStatus(invoiceId: string): Promise<InvoiceStatusResponse> {
    const response = await fetch(`${this.normalizedBase}/api/invoices/${encodeURIComponent(invoiceId)}`);
    const envelope = await response.json();
    if (!response.ok) throw new Error(envelope.error ?? "Failed to fetch invoice status");
    return envelope.data;
  }

  subscribeToPayment(invoiceId: string, onConfirmed: (event: unknown) => void): EventSource {
    const source = new EventSource(`${this.normalizedBase}/api/invoices/${encodeURIComponent(invoiceId)}/events`);
    source.addEventListener("payment.confirmed", (event) => onConfirmed(JSON.parse((event as MessageEvent).data)));
    return source;
  }

  /**
   * Helper for autonomous AI agents to interact with x402 endpoints
   */
  async fetchWithX402(url: string, init?: RequestInit): Promise<Response> {
    const firstAttempt = await fetch(url, init);
    if (firstAttempt.status !== 402) {
      return firstAttempt;
    }

    const invoiceId = firstAttempt.headers.get("x-402-invoice-id");
    if (!invoiceId) {
      throw new Error("HTTP 402 returned without x-402-invoice-id header");
    }

    // Auto-settle via agent pay
    const payResponse = await fetch(`${this.normalizedBase}/api/x402/agent-pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoiceId }),
    });
    if (!payResponse.ok) {
      throw new Error(`Failed to auto-settle x402 invoice ${invoiceId}`);
    }

    // Replay request with authorization proof
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `L402 ${invoiceId}:simulated-preimage`);
    headers.set("X-Payment-Invoice", invoiceId);

    return fetch(url, { ...init, headers });
  }
}
