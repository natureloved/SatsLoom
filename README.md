# SatsLoom

**SatsLoom** is a self-hosted Bitcoin merchant settlement router and x402 payment gateway built on **Tachi's Agentic Execution Layer**, TAURUS vaults, and VTXO architecture.

A merchant creates a native-sat invoice, shares a BIP21 QR code, compares liquidity settlement routes, and experiences deterministic selection with automatic fallback when the preferred route becomes unavailable. SatsLoom also acts as a native **x402 (HTTP 402 Payment Required)** gateway for autonomous AI agents paying per API request in native sats.

---

## Current Verified Status

- `npm run spike:tachi` is verified against live Tachi regtest (`https://rpc-regtest.tachibtc.com`):
  - Fetches **7 online network validators**.
  - Constructs Taproot **TAURUS vaults** with cooperative and unilateral exit script leaves.
  - Verifies `verifyVaultP2tr` on-chain script validity.
  - Prepares and signs user-side Taproot Schnorr PSBTs with a **1008-block CSV relative timelock** emergency exit guarantee.
- **Cryptographic Transparency**: KDHT quorum partial signature aggregation is an out-of-band network protocol in the public SDK. Rather than making false claims of cooperative broadcasting on regtest, cooperative settlement is executed in a transparently labeled **Degraded / Simulated Mode** with `simulation: true` in API envelopes.

---

## Key Features

1. **Customer Checkout Experience**: BIP21 QR code generation, 15-minute live expiration countdown timer, satoshi & USD conversions, and instant SSE state transitions.
2. **Multi-Path Settlement Router**: Multi-factor scoring taking into account fees, latency, capacity, and timelock exit risk across VTXO off-chain, Liquidity Provider (LP), and TAURUS on-chain exit paths.
3. **Automated Fallback Engine**: If a preferred VTXO route is congested or invalidated, the state machine automatically fails over to the next best route without failing the merchant's customer order.
4. **SatsShop E-Commerce Showcase**: Interactive demo storefront showcasing drop-in checkout integration via `@satsloom/ecommerce`.
5. **x402 AI Agent Sandbox**: Real-time HTTP 402 challenge negotiation and micropayment settlement for autonomous AI agents.
6. **Tachi Protocol Telemetry**: Live inspection of network validators, TAURUS P2TR taproot leaves, and block explorer links.
7. **Treasury Ledger & Webhooks**: Searchable transaction history, one-click refunds, cold storage payout sweeps, and webhook dispatching.
8. **Turnkey Self-Hosting**: `docker-compose.yml` for 1-click deployment with persistent JSON storage.

---

## Run Locally

```powershell
# 1. Install dependencies
npm install

# 2. Run unit and integration tests
npm test

# 3. Verify live Tachi Regtest connectivity & TAURUS vault construction
npm run spike:tachi

# 4. Launch API (3001) and Web UI (5174)
npm run dev
```

Open **http://localhost:5174** in your browser.

---

## Run with Docker Compose

```bash
docker compose up --build
```

- Web UI: `http://localhost:5174`
- API Backend: `http://localhost:3001`
- Persistent Data: mapped to Docker volume `satsloom-data`

---

## Architecture

```text
React Web Dashboard / SatsShop / x402 Sandbox
        │
        ▼ (HTTP + Server-Sent Events)
Fastify API (apps/api) ─── persistent store ───> ./data/satsloom.json
        │
        ├─> Domain State Machine (packages/domain)
        │       └─> Deterministic Router (packages/router)
        │
        └─> Tachi SDK Adapter (packages/tachi-adapter)
                ├─> Tachi Regtest Daemon (rpc-regtest.tachibtc.com)
                ├─> 7 Online Network Validators
                └─> Bitcoin Core (Regtest P2TR / Unilateral 1008 CSV Exit)
```

---

## Documentation & Hackathon Deliverables

- [SUBMISSION.md](SUBMISSION.md): Comprehensive hackathon overview tailored for Tachi OP_Freedom judges.
- [docs/merchant-payment-compliance.md](docs/merchant-payment-compliance.md): Detailed compliance matrix for Bounty #11.
- [docs/architecture.md](docs/architecture.md): State transitions and invariant rules.
- [docs/ecommerce-integration.md](docs/ecommerce-integration.md): E-commerce integration guide using `@satsloom/ecommerce`.
- [docs/x402-agentic-btc.md](docs/x402-agentic-btc.md): Protocol specifications for HTTP 402 AI agent payments.
- [docs/demo-script.md](docs/demo-script.md): Step-by-step walkthrough for recording the 2-minute demo video.
