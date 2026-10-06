# Merchant payment capability and compliance status

This document describes the checked-in demo, not a production payment service. **The demo does not accept, verify, send, refund, or settle Bitcoin payments.** Do not use simulated status to fulfill real orders or represent revenue.

| Capability | Current status | Details |
|---|---|---|
| Invoice/session creation | Demo only | Creates local invoice state and a working frontend hash checkout route. Does not create BOLT11/BOLT12 invoices, BIP21 URIs, payment addresses, or QR codes. |
| Customer payment detection | Not implemented | The `simulate-payment` endpoint changes application state and is explicitly marked as simulation. No chain, Lightning, or Tachi payment watcher is connected. |
| Route quotation | Illustrative only | Three hard-coded sample route candidates are used. Capacities and fees are not live liquidity. |
| Route selection | Implemented in the state machine | Selects one eligible route. Multi-path payment splitting and atomic multi-route execution are not implemented. |
| Route fallback | Narrow state-machine behavior | An unavailable pre-execution route may be replaced. Execution retries require an explicit safe-to-retry error; ambiguous failures are not retried. The public API executor is simulation-only. |
| Bitcoin/Tachi settlement | Not implemented in public API | The demo does not call the Tachi adapter to transfer funds, broadcast a Bitcoin transaction, or confirm a VTXO. |
| Refunds and payouts | Simulated records only | No refund or payout transaction is created or broadcast. |
| x402 | Signed simulation receipt only | HMAC signature protects a demo token from modification. The receipt does not verify payment or provide a Bitcoin preimage/transaction proof. |
| Server-Sent Events | Implemented for app state | Events reflect in-process invoice state changes; they are not blockchain confirmation events. |
| Webhooks | Best-effort optional delivery | Requires exact HTTPS origin allow-list and a secret; redirects are rejected and the request is signed. There is no durable outbox/retry queue. |
| Persistence | Local/demo only | Atomic JSON rename is single-process; Vercel defaults to memory. No shared transactional store is configured. |

## Before accepting real customer funds

A production merchant integration still needs, at minimum: a selected Bitcoin/Tachi network, an actual payment request/address integration, verified payment detection, a settlement adapter with explicit retry safety, transactional shared storage, durable idempotency and webhook delivery, authenticated merchant tenancy, operational monitoring, and security/compliance review. Until then, keep `SATSLOOM_DEMO_MODE=false` in production and do not treat a simulated `confirmed` or `settled` state as proof of payment.

## Webhook receiver verification

For accepted webhook requests, the API sends `x-satsloom-signature: sha256=<hex>` computed as HMAC-SHA256 over the exact raw request body, using `SATSLOOM_WEBHOOK_SECRET`. Receivers should compare signatures in constant time and reject stale/replayed delivery IDs according to their own policy.
