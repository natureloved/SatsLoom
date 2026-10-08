# Architecture and execution boundary

## Components

- `apps/web` is the React/Vite UI with live Signet checkout (`LiveSignetCheckout`), real QR codes, theme toggling, and dashboard operations.
- `apps/api` is a Fastify API exposing live payment routes (`/api/live/*`), live L402 paywall, and parallel simulation endpoints.
- `packages/rails` is the payment rail abstraction: contains `LightningRail`, `LndRestBackend`, `FixtureLightningBackend`, `InvoiceWatcher`, and pure `verifyPayment()` credit rules.
- `packages/bolt11` is the native BOLT11 invoice encoder/decoder/verifier with secp256k1 signature validation.
- `packages/domain` contains the invoice lifecycle and settlement state machine.
- `packages/router` ranks eligible routes and selects one route; it does not split an amount across multiple routes.
- `packages/tachi-adapter` contains SDK-facing integration methods and is exercised separately through the opt-in development spike.
- `apps/api/src/storage.ts` implements atomic-rename JSON persistence for a single local process. On Vercel, the default is process memory. Neither option is a shared transactional database.

## Demo behavior

The API defaults to demo mode outside production. Production requires `SATSLOOM_DEMO_MODE=true` to enable the simulation routes; the production default is false. Every simulated mutation represents application state only. No endpoint in the public demo detects a Bitcoin payment or moves, refunds, or pays out sats.

Checkout intentionally returns no Bitcoin address, payment URI, or QR payload. The checkout link is a frontend hash route (`/#checkout/:id`) backed by the demo invoice endpoint.

The x402 demo uses an HMAC-signed, short-lived `SatsLoom-Demo` receipt. The resource endpoint verifies the signature, expiry, and matching demo invoice state. This is a signed application receipt—not an invoice preimage, Bitcoin transaction proof, or payment processor result.

## Lifecycle

```text
CREATED → QUOTED → PAYMENT_CONFIRMED → ROUTE_SELECTED → SETTLING → SETTLED
                                                       └→ SETTLEMENT_FAILED
                                                       └→ FALLBACK_SELECTED
                                                           └→ SETTLING
                                                           └→ REFUND_REQUIRED
```

The diagram describes local state transitions only. Simulated `SETTLED` does not mean Bitcoin settlement.

## Route and fallback rules

The router filters by invoice/quote expiry, route availability, capacity, fee ceiling, and latency ceiling, then selects one route deterministically. A route unavailable before execution can be replaced by another eligible route.

During execution, fallback is allowed only when the adapter throws `RetryableSettlementError`. That error must mean the provider positively confirmed that no funds moved. A generic connection or execution error is ambiguous, so the domain records failure and does not retry. This boundary avoids risking a duplicate payment if an adapter actually executed before losing its response. The API's built-in executor is simulated and does not currently produce provider failures.

## Security boundaries

- Private API routes require a Bearer `SATSLOOM_ADMIN_TOKEN` when demo mode is disabled. Use a secret manager and rotate tokens. The in-memory token-bucket limiter is a basic per-process guard, not a distributed rate limiter.
- Webhook registration requires HTTPS, an exact configured origin, and `SATSLOOM_WEBHOOK_SECRET`; IP-literal/local hosts are rejected, DNS is resolved and pinned to public IPv4 at dispatch, and redirects are not followed. The receiver can verify `x-satsloom-signature` as HMAC-SHA256 over the exact JSON body. Delivery is best-effort and not durably queued.
- `WEB_ORIGIN` is an exact browser origin for CORS; it is not an API authentication mechanism.
- The local JSON file is not safe for concurrent writers, serverless persistence, or production financial records. Use a shared transactional database, unique idempotency constraints, and a durable webhook/outbox before production use.
