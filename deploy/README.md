# Deploying SatsLoom

Three supported shapes, smallest first. All of them keep key material server-side: the browser
never sees a mnemonic, and it never talks to the Tachi daemon directly (the daemon has no browser
CORS, and the quorum keys live in the API process).

| Target | Command | Notes |
| --- | --- | --- |
| Local, two processes | `npm run dev` | API on `:3001`, Vite on `:5173` with `/api` proxied |
| Docker Compose | `docker compose -f deploy/docker-compose.yml up --build` | Web on `:8080`, nginx proxies `/api` to the API container |
| Vercel (web) + Fly (api) | `vercel --prod` with `deploy/vercel.json`, `fly deploy --config deploy/fly.toml` | Set `VITE_API_URL` or edit the rewrite target in `vercel.json` |

## Environment

`cp .env.example .env` and fill it in. The important switches:

- `TACHI_PROVIDER` — `live` talks to a real daemon, `fixture` runs the in-process ledger (real
  crypto, no network). Fixture mode exists so CI and screenshots do not need regtest access; the
  UI labels it loudly and the API never reports `mode: "live"` in that mode.
- `MERCHANT_MNEMONIC`, `DEMO_PAYER_MNEMONIC`, `COLD_MNEMONIC` — server-side only. Each also accepts
  a `*_FILE` variant for Docker/Fly secrets. In `live` mode, missing key material is a hard error:
  SatsLoom will not silently fall back to a published test vector.
- `PAYOUT_ADDRESS` — a Taproot (`bcrt1p…`) address. Without it the on-chain redemption route
  reports itself unavailable rather than pretending to work.
- `CORS_ORIGINS` — `*` for a demo, or the exact origins allowed to call the API (your shop's
  origin, your Vercel app).
- `ENABLE_DEMO_ROUTES` — set to `false` for anything that is not a demo; it removes
  `/api/demo/fund-merchant` and `/api/demo/pay-invoice/:id`.
- `SATSLOOM_API_KEY` — when set, write endpoints require `X-Api-Key`. Recommended for anything
  reachable from the internet.

## Cold start on regtest

Regtest commits roughly every 10 minutes, so fund before you demo:

```bash
npm run preflight -- --wait     # faucet -> onboard merchant + demo payer -> wait for the epoch
npm run spike:tachi             # verify every capability is green
```

## Verifying a deployment

```bash
curl https://your-api/api/tachi/capabilities | jq '.data.capabilities[] | select(.ok == false)'
```

A capability that is red prints what to do about it. A deployment that cannot reach the daemon
serves `mode: "degraded"` and refuses to create invoices, rather than minting a payment request
nothing could ever confirm.
