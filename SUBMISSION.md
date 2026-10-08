# SatsLoom — Project Status

> **SatsLoom is a merchant payment product for Bitcoin signet with verifiable Lightning settlement and a transparent simulation surface.**

SatsLoom issues real BOLT11 invoices on Bitcoin Signet via its own Lightning node, watches the rail for settlement, and credits a payment only when the node reveals a preimage that cryptographically hashes to the invoice's payment hash (`sha256(preimage) == paymentHash`). It also maintains a parallel simulation surface so route selection, state transitions, and liquidity models can be inspected without moving funds.

## What is Live & Implemented

- **Real BOLT11 Invoices on Signet:** Native spec-vector-tested BOLT11 codec (`packages/bolt11`) generates valid `lntbs…` invoices over LND's REST API (`POST /api/live/invoices`).
- **Cryptographic Preimage Proof:** Pure fail-closed `verifyPayment()` rule in `packages/rails`: credit requires `sha256(preimage) == paymentHash`. Missing or mismatched preimages fail closed.
- **Single-Claim Deduplication:** Process-level `CreditRegistry` ensures preimages can never be credited twice.
- **Background Invoice Poller:** `InvoiceWatcher` polls LND with exponential backoff on node outages and notifies state changes without customer button clicks.
- **Scannable Checkout UI:** `LiveSignetCheckout` renders scannable BIP21/BOLT11 QR codes, countdown timers, and live settlement indicators with revealed preimages.
- **Live L402 Paywall:** `GET /api/x402/resource` issues real 50-sat BOLT11 invoices and unlocks resources upon receiving `Authorization: L402 <macaroon>:<preimage>`.
- **Outgoing Lightning Payouts:** `POST /api/live/payouts` executes outgoing BOLT11 payments over Lightning on Signet and verifies the resulting proof.
- **Two-Node Automated Proof:** `scripts/live-signet-proof.mts` exercises an invoice, settles it from a second node, and proves preimage equality.

## Simulation Surface (Exploration & Sandbox)

- Single-path deterministic route scoring (`packages/router`).
- Demo lifecycle transitions (`CREATED` → `QUOTED` → `PAYMENT_CONFIRMED` → `SETTLED`).
- Demo x402 sandbox with HMAC-signed `SatsLoom-Demo` receipts.
- Tachi adapter and optional regtest spike (`scripts/spike-tachi.ts`).

## Status Table

| Area | Status | Verification |
|---|---|---|
| **BOLT11 Codec** | ✅ Live | Spec vectors reproduced byte-for-byte in `packages/bolt11/src/index.test.ts` |
| **Signet Lightning Invoices** | ✅ Live | `POST /api/live/invoices` → `lntbs…` |
| **Payment Detection & Proof** | ✅ Live | `verifyPayment()`: `sha256(preimage) == paymentHash` |
| **Live Checkout UI** | ✅ Live | `LiveSignetCheckout.tsx` with QR & live settlement |
| **Live L402 Paywall** | ✅ Live | HTTP 402 → BOLT11 → Preimage proof → 200 OK |
| **Lightning Payouts** | ✅ Live | `POST /api/live/payouts` via LND REST |
| **Route Scoring** | Hybrid | Scored from active rail liquidity; single route |
| **Simulated Lifecycle** | Active | Available side-by-side with live routes (`mode: "fixture"`) |
| **Production Persistence** | In Progress | JSON file locally, memory on Vercel; Postgres planned |
| **Multi-tenant Auth / KMS** | Future Roadmap | Planned for production scale (see `docs/live-product-plan.md`) |

## Local Run

```sh
npm ci
npm test              # 93 tests, 9 suites passing hermetically
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

