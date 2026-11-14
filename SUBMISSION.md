# SatsLoom — Project Status

> **SatsLoom is a merchant payment product for Bitcoin signet that settles invoices as BTC signet payments into the merchant's Tachi vault, with a live Lightning rail as a second option and a transparent simulation surface.**

SatsLoom issues invoices and settles them by pay-to-vault: the customer deposits L1 BTC (signet) into the merchant's Tachi vault, the API watches the vault address, registers the deposit as a VTXO (TxVaultOpen), and marks the invoice paid — with an explorer link for every transaction. It also runs a live Lightning rail (real BOLT11 invoices on Bitcoin Signet via its own node, credited only when the node reveals a preimage that cryptographically hashes to the invoice's payment hash) and maintains a parallel simulation surface so route selection, state transitions, and liquidity models can be inspected without moving funds.

Pay-to-vault settles *into* the merchant's vault. It is not a Tachi transfer to a third party — that would need 5-of-7 quorum cosignatures and the SDK exposes only `cosignRefund` — and no code here claims one.

## What is Live & Implemented

- **Pay-to-vault merchant settlement on Signet:** `POST /api/tachi/invoices/:id/pay-vault` starts a watcher on the merchant's persistent Tachi vault (`POST /api/tachi/merchant-vault`); an exact-amount L1 BTC deposit to the vault address is registered as a VTXO and the invoice is marked paid, with the deposit linked on mempool.space and the registration on the Tachi Explorer. See `docs/signet-support-plan.md` for the verified proof and its limits (including the same-amount limitation).
- **Real BOLT11 Invoices on Signet:** Native spec-vector-tested BOLT11 codec (`packages/bolt11`) generates valid `lntbs…` invoices over LND's REST API (`POST /api/live/invoices`).
- **Cryptographic Preimage Proof:** Pure fail-closed `verifyPayment()` rule in `packages/rails`: credit requires `sha256(preimage) == paymentHash`. Missing or mismatched preimages fail closed.
- **Single-Claim Deduplication:** Process-level `CreditRegistry` ensures preimages can never be credited twice.
- **Background Invoice Poller:** `InvoiceWatcher` polls LND with exponential backoff on node outages and notifies state changes without customer button clicks.
- **Scannable Checkout UI:** `LiveSignetCheckout` renders scannable BIP21/BOLT11 QR codes, countdown timers, and live settlement indicators with revealed preimages.
- **Live L402 Paywall:** `GET /api/x402/resource` issues real 50-sat BOLT11 invoices and unlocks resources upon receiving `Authorization: L402 <macaroon>:<preimage>`.
- **Outgoing Lightning Payouts:** `POST /api/live/payouts` executes outgoing BOLT11 payments over Lightning on Signet and verifies the resulting proof.
- **Two-Node Automated Proof:** `scripts/live-signet-proof.mts` exercises an invoice, settles it from a second node, and proves preimage equality.
- **Tachi / TAURUS on Signet:** `packages/tachi-adapter` derives a vault from the live 7-validator quorum, funds it from the public signet faucet, deposits into the vault P2TR, and registers the resulting ledger VTXO. See `docs/signet-support-plan.md` for the verified proof and its limits.

## Simulation Surface (Exploration & Sandbox)

- Single-path deterministic route scoring (`packages/router`).
- Demo lifecycle transitions (`CREATED` → `QUOTED` → `PAYMENT_CONFIRMED` → `SETTLED`).
- Demo x402 sandbox with HMAC-signed `SatsLoom-Demo` receipts.

## Networks

Both payment rails run on **Bitcoin signet** by default, so a demonstration happens on a public chain rather than a private regtest one. `regtest` remains available for both via environment (`SATSLOOM_LIGHTNING_NETWORK`, `TACHI_NETWORK`).

| Rail | Network | How it is funded |
|---|---|---|
| Tachi pay-to-vault | signet | customer deposits L1 BTC to the merchant vault P2TR; API registers it as a VTXO |
| Lightning | signet | LND neutrino node + a second paying node |
| Tachi / TAURUS | signet | public no-auth signet faucet → P2WPKH wallet → vault P2TR |

Signet coins have no value. Every surface that reports a rail as live says so.

## Status Table

| Area | Status | Verification |
|---|---|---|
| **Pay-to-Vault Settlement** | ✅ Live | `POST /api/tachi/invoices/:id/pay-vault` → deposit confirmed on Bitcoin; registration committed on the Tachi ledger (`docs/signet-support-plan.md`) |
| **BOLT11 Codec** | ✅ Live | Spec vectors reproduced byte-for-byte in `packages/bolt11/src/index.test.ts` |
| **Signet Lightning Invoices** | ✅ Live | `POST /api/live/invoices` → `lntbs…` |
| **Payment Detection & Proof** | ✅ Live | `verifyPayment()`: `sha256(preimage) == paymentHash` |
| **Live Checkout UI** | ✅ Live | `LiveSignetCheckout.tsx` with QR & live settlement |
| **Live L402 Paywall** | ✅ Live | HTTP 402 → BOLT11 → Preimage proof → 200 OK |
| **Lightning Payouts** | ✅ Live | `POST /api/live/payouts` via LND REST |
| **Tachi Vault Funding** | ✅ Live on signet | Deposit tx confirmed on Bitcoin; matching ledger VTXO (`docs/signet-support-plan.md`) |
| **Tachi Cooperative Transfer** | ⚠️ Partial | User-signed and verified; needs 5-of-7 validator cosignatures, which the spike does not obtain |
| **Route Scoring** | Hybrid | Scored from active rail liquidity; single route |
| **Simulated Lifecycle** | Active | Available side-by-side with live routes (`mode: "fixture"`) |
| **Production Persistence** | In Progress | JSON file locally, memory on Vercel; Postgres planned |
| **Multi-tenant Auth / KMS** | Future Roadmap | Planned for production scale (see `docs/live-product-plan.md`) |

## Local Run

```sh
npm ci
npm test              # 136 tests, 13 suites passing hermetically
npm run audit:liveness # Capability verification audit
npm run dev           # API on :3001, Web on :5174
```

To run against a live Signet node:
```sh
# On Linux/macOS
bash scripts/start-live-api.sh

# On Windows PowerShell
.\scripts\start-live-api.ps1
```

The Tachi spike (`npm run spike:tachi`) defaults to signet and generates a disposable seed. See `.env.example` for how the signet and regtest funding paths differ. Do not enable mutating spike options on a network with funds.

