# SatsLoom

**Built for the Tachi OP_Freedom Hackathon — Bounty #11 (Merchant Payments) + Bounty #10 (Liquidity Management).**

Any merchant pastes one button and gets paid in native sats. SatsLoom quotes live liquidity
routes, settles deterministically, shows the proof, and fails over automatically when a route dies.

| | |
| --- | --- |
| **Live demo** | _deploy target — see [Deploying](#deploying)_ |
| **30-second video** | _recorded from the click-path in §[Judge click-path](#judge-click-path)_ — beats in [`docs/VIDEO.md`](docs/VIDEO.md) |
| **What is actually live** | [`PROGRESS.md`](PROGRESS.md) — read this before the checklists |
| **Hackathon status** | regtest-first. Signet is a stretch goal, not a claim. |

```
                    ┌──────────────────────────── browser ────────────────────────────┐
                    │  Merchant dashboard   ·   Customer pay page   ·   Liquidity view │
                    └───────────────────────────────┬─────────────────────────────────┘
                                                    │  same-origin /api only
                                                    │  (never the daemon: no CORS, no keys)
                    ┌───────────────────────────────▼─────────────────────────────────┐
                    │  apps/api · Fastify                                             │
                    │  invoice lifecycle · detection loop · refunds · payouts         │
                    │  webhooks (HMAC + retries) · LP directory · policy             │
                    └───────┬─────────────────────────────────────────────┬───────────┘
                            │  SatsLoom domain types only                 │  key material
                    ┌───────▼───────────────────┐              ┌──────────▼────────────┐
                    │ packages/router           │              │ server-side mnemonics │
                    │ deterministic scoring:    │              │ (.env / *_FILE, never │
                    │ fee · latency · exit risk │              │  to the browser)      │
                    │ · liquidity pressure      │              └───────────────────────┘
                    └───────┬───────────────────┘
                            │
                    ┌───────▼───────────────────────────────────────────────────────────┐
                    │ packages/tachi-adapter  — the only module that knows Tachi        │
                    │  LiveTachiDaemon  → @tachibtc/tachi-sdk-ts@0.2.1 (46/47 routes)   │
                    │  TachiRail        → @tachibtc/taurus-vault-core@0.3.5            │
                    │                     buildVtxoPsbt → signVtxoPsbtAsUser            │
                    │                     → buildTachiTx* → signTachiTx → broadcast      │
                    │  FixtureDaemon    → in-process ledger (tests/demo, never "live")  │
                    └───────────────────────────────────────────────────────────────────┘
```

---

## Bounty #11 — Merchant Payments

Every box links to the code that implements it.

- [x] **Invoice generation** — amount + memo + expiry, customer-facing pay page with QR and countdown.
  [`apps/api/src/server.ts`](apps/api/src/server.ts) (`POST /api/invoices`), QR + countdown in
  [`apps/web/src/pages.tsx`](apps/web/src/pages.tsx) (`PayPage`, `bitcoin:` URI with BigInt-safe amount conversion).
- [x] **Real-time payment confirmation** — a live detection loop moves `created → pending → confirmed`
  from ledger evidence only, with a confirmation feed.
  [`apps/api/src/server.ts`](apps/api/src/server.ts) (`detectOnce`),
  [`packages/tachi-adapter/src/index.ts`](packages/tachi-adapter/src/index.ts) (`detectInvoicePayment`).
- [x] **Merchant dashboard** — invoice list, statuses, totals, refunds, balance split, activity feed.
  [`apps/web/src/pages.tsx`](apps/web/src/pages.tsx) (`Dashboard`), [`GET /api/dashboard/summary`](apps/api/src/server.ts).
- [x] **Self-hosted / open-source deployment** — Docker Compose (api + web), Fly (api), Vercel (web),
  `.env.example`, no secrets in the repo. [`deploy/`](deploy/), [`.env.example`](.env.example).
- [x] **E-commerce plugin** — embeddable `<script>` pay button, redirect pay page, signed webhooks.
  [`apps/web/public/embed.js`](apps/web/public/embed.js), [`/api/webhooks/register`](apps/api/src/server.ts),
  [`apps/api/src/webhooks.ts`](apps/api/src/webhooks.ts), plugin docs in
  [`apps/web/src/pages.tsx`](apps/web/src/pages.tsx) (`PluginPage`).
- [x] **Payout + liquidity management** — merchant sweep to a cold address, on-chain vs off-chain
  balance views. [`POST /api/payouts`](apps/api/src/server.ts), [`TachiRail.withdraw`](packages/tachi-adapter/src/rail.ts).

## Bounty #10 — Liquidity Management

- [x] **On-chain → off-chain flow** — faucet → account → VTXO balance, visible end to end.
  `POST /api/demo/fund-merchant` and `TachiRail.onboard` ([liquid flow](packages/tachi-adapter/src/rail.ts),
  [faucet](packages/tachi-adapter/src/daemon.ts)).
- [x] **Off-chain → on-chain flow** — redemption/payout with a timing estimate.
  `TachiRail.withdraw` (destination must be a P2TR address; converted with `xOnlyFromAddress`),
  `GET /api/routes/liquidity` reports the CSV unlock time.
- [x] **Fee, timing and liquidity-availability display** — the quote table carries all three per route.
  [`packages/router/src/index.ts`](packages/router/src/index.ts) (`evaluateRoutes`),
  [`packages/shared/src/format.ts`](packages/shared/src/format.ts) (`describeTimelock`, `friendlyDuration`).
- [x] **Timelock abstraction** — ordinary users see `instant` / `~10 min`; BIP-68 CSV block counts
  appear only in the Advanced toggle. [`describeTimelock`](packages/shared/src/format.ts),
  [Advanced view](apps/web/src/pages.tsx).
- [x] **LP marketplace with routing logic** — a route directory with ≥2 live-evaluated sources,
  deterministic selection, a published reason, and a fallback demo.
  [`liquidityDirectory`](packages/tachi-adapter/src/index.ts), [`chooseRoute` + `DecisionLog`](packages/router/src/index.ts),
  [fallback demo](apps/web/src/pages.tsx) ("Kill best route → auto-fallback").

### Proof, not claims

- 69 tests pass, including a full `invoice → pay → confirm → proof → refund → payout` loop
  ([`apps/api/src/server.test.ts`](apps/api/src/server.test.ts)) and the cryptography that moves money
  ([`adapter.test.ts`](packages/tachi-adapter/src/adapter.test.ts)).
- Every settlement, refund and payout renders an explorer URL. The URL is derived from the
  transaction hash, which is `sha256(encodeTachiTx)` — computed locally, so the link is known before
  the daemon answers.
- `npm run spike:tachi` prints a per-capability truth table with a fix for each failure. It exits
  non-zero when a capability the merchant loop depends on is red, so it can gate CI.

---

## Quick start

```bash
git clone https://github.com/natureloved/SatsLoom && cd SatsLoom
npm install

# Option A — no daemon needed. Real key derivation, real signing, in-process ledger.
TACHI_PROVIDER=fixture npm run dev
#   → web  http://localhost:5173   api  http://localhost:3001
#   → header shows a blue FIXTURE badge. Nothing claims to be live.

# Option B — live regtest.
cp .env.example .env            # set MERCHANT_MNEMONIC, DEMO_PAYER_MNEMONIC, COLD_MNEMONIC
npm run preflight -- --wait     # faucet → onboard → wait for the epoch (~10 min/block on regtest)
npm run spike:tachi             # Day-1 gate: every capability must be green
npm run dev
```

Then, from the dashboard: **Create invoice** → the pay page opens → **Pay with demo wallet** →
status flips `pending → confirmed` with an explorer link → **Refund** or **Sweep**.

## Judge click-path

1. Open the dashboard — daemon pill is green (or blue for fixture), balances visible.
2. Create an invoice (50,000 sats, memo `Demo order #1`) → the pay page opens with a QR and countdown.
3. Click **Pay with demo wallet** — a real off-chain VTXO transfer from a second funded account.
   Status flips `pending → confirmed` when the epoch commits, with a working explorer link.
4. The dashboard shows `confirmed`, and a signed webhook is in the delivery log.
5. **Liquidity** → the quote table (fee, timing, capacity, exit risk per source) → **Kill best route
   → auto-fallback** re-settles on the runner-up and publishes the new reason and the decision log entry.
6. **Refund** the invoice, then **Sweep** to the cold Taproot address — both return a txid and an
   explorer link.

## The embed button (e-commerce plugin)

```html
<script src="https://your-satsloom.example/embed.js"
        data-satsloom-invoice="INVOICE_ID"
        data-satsloom-api="https://your-api.example"
        data-satsloom-label="Pay with sats"></script>
```

One script tag, no build step, no framework. It renders in a shadow root so your CSS cannot break
it, opens the real pay page in a modal (so there is only ever one payment surface), and falls back
to a plain link if anything fails.

Create the invoice server-side first — the API key and the mnemonics stay on your server:

```js
const invoice = await fetch(`${API}/api/invoices`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": process.env.SATSLOOM_API_KEY },
  body: JSON.stringify({ amountSats: "50000", memo: "Order #1042", orderId: "1042" }),
}).then((r) => r.json());
```

Fulfil on the **webhook**, never on the redirect:

```
SatsLoom-Signature: t=1759489000,v1=<hmac-sha256(secret, "t.body")>
```

Three attempts with backoff; every attempt, its signature and the exact signed body are in
`GET /api/webhooks/deliveries`. A working Node receiver is in the Plugin tab of the web app.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/invoices` | Create an invoice (+ quote). Refuses with 503 while the daemon is unreachable. |
| `GET` | `/api/invoices` · `/api/invoices/:id` | List / fetch with quote, decision, settlement, refunds |
| `GET` | `/api/invoices/:id/routes?refresh=1` | Live quote, per-route evaluations, published reason |
| `POST` | `/api/invoices/:id/select-route` | Run the deterministic router and record the decision |
| `POST` | `/api/invoices/:id/invalidate-best-route` | Fallback demo: kill the best route |
| `POST` | `/api/invoices/:id/settle` | Settle (re-quotes if stale, falls back if the route died) |
| `POST` | `/api/invoices/:id/refund` | Reverse transfer to the payer |
| `POST` | `/api/payouts` | Sweep: ledger transfer (64-hex key) or on-chain redemption (P2TR address) |
| `GET` | `/api/pay/:id` · `/api/pay/:id/status` | **Public** pay-page data — no keys, no internals |
| `GET` | `/api/dashboard/summary` | Totals, counts, on-chain vs off-chain balance, activity |
| `GET` | `/api/routes/liquidity` | LP directory: capacity, fee, latency, status, timelock |
| `GET`/`POST` | `/api/policy` | Read / update settlement weights |
| `POST` | `/api/webhooks/register` · `GET /api/webhooks/deliveries` | Webhook registration + delivery log |
| `GET` | `/api/tachi/status` · `/api/tachi/capabilities` | Daemon status and the capability probe |
| `POST` | `/api/demo/*` | Dev-only faucet/payer helpers (`ENABLE_DEMO_ROUTES=false` to remove) |

Money endpoints are idempotent (`Idempotency-Key`), validate everything server-side, and enforce
invoice expiry. Refunds cannot exceed the invoice, and only a confirmed invoice can be refunded.

## Configuration worth knowing

| Variable | Why it matters |
| --- | --- |
| `TACHI_PROVIDER` | `live` (default) or `fixture`. Fixture mode is labelled in the UI; it never reports `mode: "live"`. |
| `MERCHANT_MNEMONIC` / `DEMO_PAYER_MNEMONIC` / `COLD_MNEMONIC` | Server-side only; also accept `*_FILE` for secrets mounts. In live mode a missing key is a **hard error** — SatsLoom will not silently substitute a published test vector. |
| `PAYOUT_ADDRESS` | Taproot address for sweeps. Unset ⇒ the on-chain route reports itself unavailable instead of pretending. |
| `CORS_ORIGINS` | Needed for the embed button and for a split web/API deploy. |
| `SATSLOOM_API_KEY` | When set, write endpoints require `X-Api-Key`. |
| `TACHI_CSV_BLOCKS` | The relative timelock in the vault's exit leaf. Must match the daemon's expectation or the derived address diverges. |

## Deploying

```bash
# Local, two processes
TACHI_PROVIDER=fixture npm run dev

# Docker Compose — web on :8080, nginx proxies /api to the api container
docker compose -f deploy/docker-compose.yml up --build

# Fly (api) + Vercel (web)
fly deploy --config deploy/fly.toml
vercel --prod --local-config deploy/vercel.json
```

Details, including the cold-start sequence and how to verify a deployment, are in
[`deploy/README.md`](deploy/README.md).

## Repository layout

| Path | What lives there |
| --- | --- |
| [`apps/api`](apps/api) | Fastify API: invoice lifecycle, detection loop, refunds, payouts, webhooks, LP directory |
| [`apps/web`](apps/web) | React dashboard, pay page, liquidity view, policy editor, embed snippet |
| [`packages/tachi-adapter`](packages/tachi-adapter) | The only module that knows Tachi. Live daemon + rail + fixture, typed errors, capability probe |
| [`packages/router`](packages/router) | Deterministic scoring, quote freshness, LP directory → routes, decision log |
| [`packages/shared`](packages/shared) | Domain types + display helpers (timelock abstraction, sat formatting) |
| [`scripts/spike-tachi.ts`](scripts/spike-tachi.ts) | The Day-1 gate: per-capability truth table with remediation |
| [`deploy/`](deploy) | Dockerfiles, Compose, Fly, Vercel, nginx |

## Prior art

SatsLoom started 19 Aug 2026 for Tachi. No Efthesis or DrawBound code is reused here; the
dark-and-gold visual language is shared for brand consistency only. See
[`PROGRESS.md`](PROGRESS.md) for the honest build log, including what is verified and what is not.

## Licence

MIT.
