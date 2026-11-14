# SatsLoom

SatsLoom is a merchant payment product for Bitcoin signet: it issues invoices and settles them as BTC signet payments into the merchant's Tachi vault — the customer pays L1 BTC to the merchant's vault address, the API watches for the deposit, registers it as a VTXO, and marks the invoice paid, with an explorer link for every transaction. A Lightning rail stays live as a second option (real BOLT11 invoices on its own node, credited only on a valid preimage), but it is no longer the settlement story.

Settlement is real. Run the API and a payment you make is a payment that lands in the merchant's vault on signet — not a button that says it worked. Signet coins have no monetary value, so nothing here can move mainnet funds. The simulation surface (invoice lifecycle, refunds, payouts, liquidity views) is still present and still labelled `simulation` in every response envelope, so a caller is never confused about which path produced a result.

Pay-to-vault is settlement *into* the merchant's vault, not a Tachi transfer to a third party: a transfer would need 5-of-7 quorum cosignatures and the SDK exposes only `cosignRefund`, so no code here claims one. A deposit needs no cosign at all — it is a plain Bitcoin transaction the customer's wallet signs alone.

## Live rail

| Capability | Status | How it is verified |
|---|---|---|
| Pay-to-vault settlement on signet | ✅ live | `POST /api/tachi/invoices/:id/pay-vault` → deposit confirmed on Bitcoin, registration committed on the Tachi ledger |
| Merchant Tachi vault | ✅ live | `POST /api/tachi/merchant-vault` → persistent P2TR vault from the live 7-validator quorum |
| Deposit → VTXO registration | ✅ live | deposit tx on mempool.space; `TxVaultOpen` committed, code 0, on `signet.tachibtcscan.com` |
| Real BOLT11 invoice on signet | ✅ live | `POST /api/live/invoices` → `lntbs…` |
| Lightning payment settled and credited | ✅ live | paid by a second node, `settled: true` |
| Preimage proof | ✅ live | `sha256(preimage) == paymentHash` |
| L402 paywall | ✅ live | `402 → pay → 200` with `proof: preimage-sha256` |
| LND REST backend | ✅ implemented | `SATSLOOM_RAIL=lnd` |
| Fixture backend for CI | ✅ implemented | `SATSLOOM_RAIL=fixture` |
| Route scoring on live liquidity | partial | scored from the rail's node view; single route, no multi-path |
| Refunds, payouts | simulation | records only; no transfer is executed |

The credit path is deliberately conservative: a rail reporting `paid` without a valid preimage is treated as a bug or an attack and fails closed rather than crediting. The pay-to-vault path is equally strict: a deposit only settles an invoice when its amount equals the invoice amount exactly and its txid has not already been settled, and a registration that would attribute an older payment's VTXO fails loudly instead of crediting the wrong one.

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

From the homepage, open the **PAY IT FOR REAL** section and pay with BTC (signet): set an amount, start the payment, and send exactly that amount in L1 BTC to the merchant vault address shown. The API watches the address, registers the deposit as a VTXO, and marks the invoice paid — verify the deposit on mempool.space and the registration on the Tachi Explorer. Or pay over Lightning with the panel below it, using any signet wallet or the two-node proof:

```sh
node scripts/live-signet-proof.mts
```

It issues an invoice, pays it from a second node, and checks the returned preimage against the payment hash.

No wallet? The site's onboarding panel lists signet faucets — `arkfaucet.com` pays a fresh `lntbs` invoice with no account, API key, or CAPTCHA. See the note on wallet connections below.

## Run locally

Requirements: Node.js 22.6 or newer and npm.

```sh
npm ci
npm test          # 136 tests, fixture rail pinned in vitest.config.ts
npm run typecheck
npm run build
npm run dev       # API :3001, web :5174
npm run smoke:api
```

## UI

The interface has light and dark themes. Both are token-driven: every palette value is a CSS custom property, so a theme is one attribute on `<html>`. The initial value is set before first paint (no flash), follows the OS while you have not chosen explicitly, and persists your choice in `localStorage`. Contrast in both themes is measured against WCAG AA — the light palette keeps body text at 17.3:1 and accents at 4.7:1.

The layout is mobile-first and verified overflow-free at 320, 360, 390, 414, 600, 768, 1024, 1280, and 1600 px.

### Why there is no wallet-connection widget

SatsLoom is a merchant: it owns its vault and its node, issues invoices, and never holds a user's keys. For pay-to-vault, the merchant vault address *is* the payment primitive — a payer needs a signet wallet with test coins rather than a connection to this site. For the Lightning rail, the BOLT11 invoice is the payment primitive. Cold-start instructions are on the page next to the invoice. No connect-button integration against an unexercised wallet provider is shipped, because unverified payment code is worse than a clear "bring your own wallet."

## Simulation surface

This is deliberate and stays visible. `SATSLOOM_DEMO_MODE=true` enables the simulated lifecycle endpoints; production defaults it to `false`. The simulation and live paths run side by side, and every envelope names its rail, so the two cannot be mistaken for each other.

- Invoice lifecycle, refunds, payouts, liquidity, transactions: simulated records.
- x402: **live** L402 when a node is configured; the signed HMAC demo receipt remains as a fallback when one is not.
- Route quotes: sample capacities when no node is configured; scored from the rail's node view when one is.

## Deployment

`vercel.json` wires the static bundle (`apps/web`) and the API (`apps/api`, whose entrypoint
default-exports a `req`/`res` handler for the Vercel runtime). Locally the same module listens on a
port, so `npm run dev` gets the invoice watcher, the pay-to-vault watcher, and a real Lightning node. Any `.env` variable that
must be visible to the serverless functions has to be set in Vercel — the local `.env` file that
backs `.env.example` is not shipped to the Function.

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

Licensed under the MIT License. See [LICENSE](LICENSE).
