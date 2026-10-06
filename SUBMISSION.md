# SatsLoom — prototype status

> **This repository is a TypeScript/React/Fastify demo, not a production Bitcoin payment gateway.**

SatsLoom explores an invoice state machine, deterministic single-route scoring, route fallback rules, an HTTP 402-style challenge, and a Tachi SDK adapter/spike. The UI and API are designed to make the simulated portions explicit.

## What the demo currently does

- Creates local invoice and checkout-session records.
- Provides a frontend checkout hash route, with no BOLT11/BOLT12 request, Bitcoin address, BIP21 URI, or payment QR.
- Scores three hard-coded sample routes and selects one candidate.
- Demonstrates pre-execution fallback and records safe retryable fallback semantics in the domain package. Generic/ambiguous execution errors are not retried.
- Emits SSE events when demo application state changes.
- Demonstrates an HTTP 402 challenge and a short-lived HMAC-signed simulation receipt. The signature is not payment proof.
- Includes a separate Tachi adapter and opt-in integration spike; the demo settlement route does not invoke Tachi settlement methods.

## What is not implemented

The demo does not receive or verify Bitcoin payments, move sats, create or transfer VTXOs, broadcast transactions, execute multi-path atomic payments, perform refunds or payouts, or provide production-grade persistence. All such UI/API actions are simulations. The repository does not include a license file.

## Status table

| Area | Status |
|---|---|
| TypeScript API and React UI | Implemented for local/demo use |
| Invoice lifecycle and single-route scoring | Implemented in application state |
| Settlement fallback | State-machine behavior with conservative safe-retry rule; public API executor remains simulated |
| Checkout payment request | Not implemented; no payable address or QR is issued |
| Bitcoin/Tachi payment settlement | Not implemented in the public API |
| Refunds, payouts, liquidity | Demo records and hard-coded values only |
| x402 payment verification | Not implemented; signed demo receipt only |
| Shared production database | Not configured |
| Deployment health | Must be checked after deployment with `npm run smoke:api -- <deployed-url>` |

## Local run

```sh
npm ci
npm test
npm run dev
```

The web UI runs on port 5174 and the API on port 3001. For Tachi/regtest work, review `.env.example` and `scripts/spike-tachi.ts` first. Do not enable mutating spike options on a network with funds.
