# E-commerce demo integration

`@satsloom/ecommerce` is an example client for the local demo API. It creates simulated checkout sessions and can replay the sample x402 flow. **It is not a payment SDK and must not be used to mark a real order paid or fulfill goods.**

```ts
import { SatsLoomMerchantClient } from "@satsloom/ecommerce";

// In a browser, the client defaults to the current origin.
// In Node.js, provide the API origin and, when separate, the frontend origin.
const satsloom = new SatsLoomMerchantClient("https://api.example", "https://your-demo.example");
const checkout = await satsloom.createCheckout({
  orderId: "shop-order-101",
  amountSats: 25_000,
  memo: "Sample order",
});

console.log(checkout.paymentUrl); // absolute SPA URL: https://your-demo.example/#checkout/<invoice-id>
console.log(checkout.simulation); // true
console.log(checkout.qrPayload); // null: no payment address is configured
```

The checkout URL is a real frontend route in the SPA. It loads the invoice through the demo API, so it depends on that API instance retaining its in-memory/local state. There is no shared production database behind this link.

The `simulate-payment` API route changes the demo invoice state only. SSE subscribers receive application events, not a Bitcoin confirmation. Never fulfill an order based on these values.

## Webhooks

Webhooks are disabled unless the API operator configures both `SATSLOOM_WEBHOOK_ALLOWED_ORIGINS` and `SATSLOOM_WEBHOOK_SECRET`. The submitted URL must use HTTPS and have an origin exactly present in the allow-list. IP-literal/local hosts are rejected. At delivery time, DNS is resolved and pinned to public IPv4 addresses to reduce SSRF and DNS-rebinding risk. Redirects are not followed. Deliveries are best-effort and do not have a durable retry queue.

## x402 helper

`fetchWithX402` recognizes the `SatsLoom-Demo` challenge, asks the demo endpoint to mark the sample invoice as simulated, then replays the request with a short-lived HMAC-signed demo receipt. This receipt proves only that the demo API issued it; it is not a Bitcoin payment proof or settlement confirmation. Do not use this helper for paid access control or order fulfillment.
