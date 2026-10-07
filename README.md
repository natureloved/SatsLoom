# SatsLoom

SatsLoom is a merchant payment product for Bitcoin signet: it issues real BOLT11 invoices on its own Lightning node, watches the rail for settlement, and credits a payment only when the node reveals a preimage that hashes to the invoice's payment hash.

Settlement is real. Run the API against an LND node and a payment you make is a payment a Lightning node confirms — not a button that says it worked. Signet coins have no monetary value, so nothing here can move mainnet funds. The simulation surface (invoice lifecycle, refunds, payouts, liquidity views) is still present and still labelled `simulation` in every response envelope, so a caller is never confused about which path produced a result.

## Live rail

| Capability | Status | How it is verified |
|---|---|---|
| Real BOLT11 invoice on signet | ✅ live | `POST /api/live/invoices` → `lntbs…` |
| Lightning payment settled and credited | ✅ live | paid by a second node, `settled: true` |
| Preimage proof | ✅ live | `sha256(preimage) == paymentHash` |
| L402 paywall | ✅ live | `402 → pay → 200` with `proof: preimage-sha256` |
| LND REST backend | ✅ implemented | `SATSLOOM_RAIL=lnd` |
| Fixture backend for CI | ✅ implemented | `SATSLOOM_RAIL=fixture` |
| Route scoring on live liquidity | partial | scored from the rail's node view; single route, no multi-path |
| Refunds, payouts | simulation | records only; no transfer is executed |

The credit path is deliberately conservative: a rail reporting `paid` without a valid preimage is treated as a bug or an attack and fails closed rather than crediting.

### Run it live

```sh
# 1. API on :3001 against your signet LND node
bash scripts/start-live-api.sh

# 2. web on :5174 (proxies /api)
cd apps/web && npm run dev
```

`scripts/start-live-api.sh` sets `SATSLOOM_RAIL=lnd`, points `LND_REST_URL` at `https://127.0.0.1:8080`, loads the macaroon as hex, and pins `SATSLOOM_LIGHTNING_NETWORK=signet`.

Manual configuration:

| Variable | Meaning |
|---|---|
| `SATSLOOM_RAIL` | `lnd` for a real node, `fixture` for CI |
| `LND_REST_URL` / `LND_MACAROON_HEX` / `LND_CA_CERT_PATH` | node endpoint, admin macaroon (hex), TLS CA |
| `LND_ALLOW_INSECURE_HTTP` | set `true` only for a private-network node over plain HTTP |
| `SATSLOOM_LIGHTNING_NETWORK` | `signet` (or `regtest`, `mainnet`) |
| `SATSLOOM_DATA_FILE` | local JSON store path; omitted on Vercel |

A strictly-configured but broken node takes the live routes offline loudly (503 with the reason) instead of silently falling back to fixtures.

### Test a payment end to end

From the homepage, open the **PAY IT FOR REAL** section, set an amount, and issue the invoice. Pay it with any signet wallet, or run the two-node proof:

```sh
node scripts/live-signet-proof.mts
```

It issues an invoice, pays it from a second node, and checks the returned preimage against the payment hash.

No wallet? The site's onboarding panel lists signet faucets — `arkfaucet.com` pays a fresh `lntbs` invoice with no account, API key, or CAPTCHA. See the note on wallet connections below.

## Run locally

Requirements: Node.js 22.6 or newer and npm.

```sh
npm ci
npm test          # 87 tests, fixture rail pinned in vitest.config.ts
npm run typecheck
npm run build
npm run dev       # API :3001, web :5174
npm run smoke:api
```

## UI

The interface has light and dark themes. Both are token-driven: every palette value is a CSS custom property, so a theme is one attribute on `<html>`. The initial value is set before first paint (no flash), follows the OS while you have not chosen explicitly, and persists your choice in `localStorage`. Contrast in both themes is measured against WCAG AA — the light palette keeps body text at 17.3:1 and accents at 4.7:1.

The layout is mobile-first and verified overflow-free at 320, 360, 390, 414, 600, 768, 1024, 1280, and 1600 px.

### Why there is no wallet-connection widget

SatsLoom is a merchant: it owns its node, issues invoices, and never holds a user's keys. The BOLT11 invoice *is* the payment primitive, so a payer needs a signet wallet with test coins rather than a connection to this site. Cold-start instructions are on the page next to the invoice. No connect-button integration against an unexercised wallet provider is shipped, because unverified payment code is worse than a clear "bring your own wallet."

## Simulation surface

This is deliberate and stays visible. `SATSLOOM_DEMO_MODE=true` enables the simulated lifecycle endpoints; production defaults it to `false`. The simulation and live paths run side by side, and every envelope names its rail, so the two cannot be mistaken for each other.

- Invoice lifecycle, refunds, payouts, liquidity, transactions: simulated records.
- x402: **live** L402 when a node is configured; the signed HMAC demo receipt remains as a fallback when one is not.
- Route quotes: sample capacities when no node is configured; scored from the rail's node view when one is.

## Deployment

`vercel.json` defines separate `web` and `api` services; `/api/*` rewrites to the Node entrypoint. Vercel's filesystem and process memory are not a shared database — the API reports its persistence mode from `/api/health`, and durable merchant workflows need a managed database plus an idempotent job/outbox before they are trustworthy.

Other environment variables are listed in `.env.example`, including `SATSLOOM_PROOF_SECRET` and `SATSLOOM_ADMIN_TOKEN` for the simulation routes, and `SATSLOOM_WEBHOOK_*` which must both be set before any webhook destination is accepted.

## Repository layout

```text
apps/web/                  React/Vite UI (light/dark themes)
apps/api/                  Fastify API, live + simulation routes
packages/rails/            PaymentRail abstraction, LND REST + fixture backends, preimage verification
packages/bolt11/           BOLT11 encode/decode/verify, checked against the spec's test vectors
packages/domain/           Invoice lifecycle and settlement state machine
packages/router/           Deterministic single-route scoring
packages/shared/           Shared types
packages/tachi-adapter/    Tachi SDK adapter and integration spike
packages/ecommerce/        Merchant client example
scripts/live-signet-proof.mts   Two-node end-to-end payment proof
scripts/start-live-api.sh        Boots the API against a live signet node
scripts/liveness-audit.ts       Per-capability verification report (npm run audit:liveness)
```

## Security notes

- The rail never credits on trust: it verifies the preimage, and a `paid` state without a matching preimage fails closed.
- Webhooks require an exact HTTPS origin allow-list plus a signing secret; the hostname is pinned to public IPv4 at delivery time to reduce DNS-rebinding SSRF risk, and redirects are never followed.
- Non-public API routes require `SATSLOOM_ADMIN_TOKEN` when demo mode is disabled.
- Secrets are never written into `.git/config`, the remote URL, or commit history. Pass a GitHub token inline (`git -c http.extraHeader='Authorization: Basic …'`) if you contribute commits.

## License

No license is currently declared in this repository. Do not assume permission to redistribute or use it under MIT or another open-source license.
