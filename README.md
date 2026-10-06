# SatsLoom

SatsLoom is a TypeScript/Node.js and React demonstration of a merchant-invoice state machine, deterministic single-route scoring, and an HTTP 402-style agent workflow. **The public demo is not a Bitcoin payment processor.** Invoice confirmation, settlement, refunds, payouts, liquidity, and x402 agent-pay are simulated records; no sats are received, verified, transferred, refunded, or broadcast.

For what it would take to make this a real product — rail choice, the current Tachi/Ark/Lightning options, engineering workstreams, liquidity, compliance, cost, and a 90-day plan — see [`docs/live-product-plan.md`](docs/live-product-plan.md). That document is a plan, not a change in status: until it is executed, everything below still holds.

## Status and limitations

- The API returns `simulation: true` on simulated flows and uses a degraded mode.
- Checkout does not issue a BOLT11/BOLT12 invoice, Bitcoin payment URI, payment address, or QR code. It provides an app checkout link and an explicit simulation button.
- Route quotes use hard-coded sample capacities and fees. The router selects one route; multi-path splitting and atomic multi-route delivery are not implemented.
- The domain package records a fallback after an explicit safe-to-retry route failure. An ambiguous execution error is not retried, because the first attempt may have moved funds.
- The x402 sandbox returns a short-lived HMAC-signed **demo receipt**. The signature prevents tampering; it is not a Bitcoin payment proof or an external settlement verification.
- The Tachi adapter and `scripts/spike-tachi.ts` are optional integration work. The public API does not query Tachi or call vault, deposit, transfer, or broadcast methods. SDK dependencies are isolated to the development spike, which can contact regtest services and should be reviewed before enabling any mutating option.
- Local API state is written to a single-process JSON file using an atomic rename. On Vercel it is process-memory only. Neither is shared, transactional, or reliable for multi-instance production use; use a managed database before relying on durable state.
- Outgoing webhooks are disabled unless the API has an exact HTTPS origin allow-list and a signing secret. At delivery time, the hostname is resolved and pinned to public IPv4 addresses to reduce DNS-rebinding SSRF risk; redirects are not followed and requests include an HMAC signature.
- Production defaults disable simulated payment mutations. Setting `SATSLOOM_DEMO_MODE=true` explicitly enables simulations only; it does not enable real payments.
- The optional Tachi SDK spike currently pulls development-only packages with unresolved high-severity npm audit advisories and no upstream automatic fix. These dependencies are not imported by the production API; keep the spike isolated to disposable regtest data and credentials.
- This repository does not include a license file or declare a license.

## Run locally

Requirements: Node.js 22.6 or newer and npm.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

The development script starts the API at `http://localhost:3001` and the web app at `http://localhost:5174`. The web dev server proxies `/api` requests to the API. The API defaults to demo mode outside production, with no live Bitcoin payment integration.

In another terminal, verify the local API route:

```sh
npm run smoke:api -- http://localhost:3001
```

After deploying, verify the actual deployment separately:

```sh
npm run smoke:api -- https://your-deployment.example
```

A successful local build does not prove a Vercel deployment is healthy.

## Vercel deployment

`vercel.json` defines separate `web` and `api` services. The API service has `apps/api/src/server.ts` as its Node entrypoint and `/api/*` requests are rewritten to that service. The API build runs a TypeScript check. After deploying, run the smoke command above against the deployed domain and confirm that `GET /api/health` returns JSON with `data.ok: true`.

Vercel's function filesystem and process memory are not a shared persistent database. The API reports its persistence mode from `/api/health`; use a managed database and an idempotent job/outbox design before exposing durable merchant workflows. Do not enable demo mode on a public deployment unless you intend to offer simulations only.

## Environment variables

See `.env.example`. Important settings:

- `SATSLOOM_DEMO_MODE=true` — explicitly enables simulation endpoints; still moves no funds. Production defaults to `false`.
- `SATSLOOM_PROOF_SECRET` — required for signed x402 demo receipts in production.
- `SATSLOOM_ADMIN_TOKEN` — required to access non-public API routes when demo mode is disabled. Store it in a secret manager; do not commit it.
- `SATSLOOM_WEBHOOK_ALLOWED_ORIGINS` and `SATSLOOM_WEBHOOK_SECRET` — both required before webhook destinations are accepted. Origins must match exactly and use HTTPS.
- `SATSLOOM_DATA_FILE` — optional path for local single-process JSON persistence. This is not suitable for serverless or multi-instance deployment.
- `WEB_ORIGIN` — optional exact browser origin for local API CORS.

## Repository layout

```text
apps/web/                 React/Vite demo UI
apps/api/                 Fastify API, demo endpoints, single-process storage
packages/domain/          Invoice lifecycle and settlement state machine
packages/router/          Deterministic single-route scoring
packages/tachi-adapter/   Tachi SDK adapter and integration spike surface
packages/ecommerce/       Merchant client example (simulation-aware)
scripts/spike-tachi.ts    Opt-in Tachi/regtest integration spike
```

## Route fallback semantics

The domain package selects one eligible route. If that route is unavailable before execution, it may select another eligible route. After an execution attempt, a retry is permitted only when the adapter throws `RetryableSettlementError`, which means the adapter has positively confirmed that no funds moved. Generic/ambiguous failures are recorded and are not retried. This is a state-machine behavior; the public API currently exercises it only with simulated routes.

## Webhooks

Configure both `SATSLOOM_WEBHOOK_ALLOWED_ORIGINS` (comma-separated exact HTTPS origins) and `SATSLOOM_WEBHOOK_SECRET` before providing `webhookUrl` on an invoice. The API rejects non-HTTPS or non-allow-listed origins, query strings, IP-literal/local hosts, and never follows redirects. Only configure trusted, publicly reachable webhook origins; do not allow-list internal services. Deliveries carry `x-satsloom-signature: sha256=<hex HMAC>` over the raw JSON body. Webhook delivery is best-effort and is not backed by a durable queue.

## License

No license is currently declared in this repository. Do not assume permission to redistribute or use it under MIT or another open-source license.
