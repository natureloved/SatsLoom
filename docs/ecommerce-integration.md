# E-commerce integration

SatsLoom exposes a small checkout API and an open-source client package at `packages/ecommerce`.

```ts
import { SatsLoomMerchantClient } from "@satsloom/ecommerce";

const satsloom = new SatsLoomMerchantClient("http://merchant-server:3001");
const checkout = await satsloom.createCheckout({
  orderId: "shop-order-42",
  amountSats: 50_000,
  memo: "Order 42",
});

const events = satsloom.subscribeToPayment(checkout.invoiceId, (payment) => {
  console.log("Payment confirmed", payment);
  events.close();
});
```

HTTP-only integrations can call `POST /api/checkout/session`, then subscribe to `GET /api/invoices/:id/events` using Server-Sent Events. Confirmation in the current demo is simulated and visibly labeled; the event transport and merchant lifecycle are real application behavior.
