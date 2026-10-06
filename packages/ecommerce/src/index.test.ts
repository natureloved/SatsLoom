import { afterEach, describe, expect, it, vi } from "vitest";
import { SatsLoomMerchantClient } from "./index.js";

afterEach(() => vi.restoreAllMocks());

describe("SatsLoomMerchantClient checkout links", () => {
  it("marks returned invoice status as simulation-only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      demo: true,
      data: { id: "invoice-1", amountSats: "500", status: "confirmed", lifecycle: "PAYMENT_CONFIRMED" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SatsLoomMerchantClient("https://api.example");

    const status = await client.checkPaymentStatus("invoice-1");

    expect(status.simulation).toBe(true);
  });

  it("resolves the demo SPA checkout against the configured frontend origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      simulation: true,
      data: { checkoutSessionId: "session-1", invoiceId: "invoice-1", paymentUrl: "/#checkout/invoice-1" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SatsLoomMerchantClient("https://api.example", "https://checkout.example");

    const checkout = await client.createCheckout({ orderId: "order-001", amountSats: 500 });

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example/api/checkout/session");
    expect(checkout.paymentUrl).toBe("https://checkout.example/#checkout/invoice-1");
    expect(checkout.simulation).toBe(true);
  });
});

describe("SatsLoomMerchantClient x402 demo helper", () => {
  it("never sends a SatsLoom demo receipt to a different origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new SatsLoomMerchantClient("https://api.example");

    await expect(client.fetchWithX402("https://attacker.example/resource")).rejects.toThrow("will not be sent to another host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a signed demo receipt only for the same-origin SatsLoom challenge", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", {
        status: 402,
        headers: {
          "www-authenticate": 'SatsLoom-Demo invoice="invoice-1", simulation="true"',
          "x-402-invoice-id": "invoice-1",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { proofToken: "SatsLoom-Demo payload.signature" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("sample", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SatsLoomMerchantClient("https://api.example");
    const response = await client.fetchWithX402("/api/x402/resource");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example/api/x402/resource");
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.example/api/x402/resource");
    const replayInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(new Headers(replayInit.headers).get("authorization")).toBe("SatsLoom-Demo payload.signature");
  });

  it("does not treat arbitrary HTTP 402 responses as SatsLoom challenges", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 402, headers: { "x-402-invoice-id": "invoice-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SatsLoomMerchantClient("https://api.example");

    await expect(client.fetchWithX402("/api/x402/resource")).rejects.toThrow("not a SatsLoom signed-receipt simulation challenge");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
