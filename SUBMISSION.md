# SatsLoom — Tachi OP_Freedom Hackathon Submission

> **Self-Custodial Bitcoin Merchant Settlement Router & x402 Gateway on Tachi**

---

## 🏆 Targeted Bounties

- **Primary Bounty:** **Bounty #11: Merchant Payments** (USD 500 in Sats)
  *Build a self-hosted, open-source merchant solution for instant, native BTC payments via Tachi with Lightning-like speed, zero channel management, and true self-custody.*
- **Cross-Track Alignments:**
  - **Bounty #10: Liquidity Management:** Dynamic multi-path routing across VTXO off-chain, LP rebalancing, and TAURUS on-chain timelock exit.
  - **Bounty #6: x402 on Bitcoin:** Native HTTP 402 pay-per-request gateway for autonomous AI agents.

---

## 💡 The Core Innovation

Accepting Bitcoin on Lightning requires active inbound liquidity management, risk of routing failure, watchtowers, and the danger of penalty transactions during force-closures.

**SatsLoom leverages Tachi's TAURUS vaults and VTXO architecture to solve this:**
1. **No Channel Management:** Merchants receive native sats into self-custodial TAURUS vaults without locking up capital into routing channels.
2. **Deterministic Settlement Routing:** When an invoice is paid, SatsLoom evaluates fee, latency, route capacity, and exit risk across candidate paths.
3. **Automated Dynamic Fallback:** If preferred VTXO execution stalls or network congestion hits, the state machine automatically fails over to secondary liquidity providers without failing the customer order.
4. **Sovereign Unilateral Exit Recourse:** All deposits are anchored to Bitcoin Taproot (P2TR) scripts with a 1008-block CSV delay. Even if every Tachi validator disappears, the merchant can unilaterally sweep funds back to Bitcoin testnet / L1 without permission.

---

## 🚀 Track Requirements Compliance Matrix

| Official Bounty #11 Requirement | SatsLoom Implementation | Status |
| :--- | :--- | :--- |
| **Invoice generation** | API (`POST /api/invoices`, `POST /api/checkout/session`), BIP21 QR code generation, live 15-min countdown timer | ✅ Complete |
| **Real-time payment confirmation** | Server-Sent Events (`/api/invoices/:id/events`) and HTTP webhook callbacks to merchant backend | ✅ Complete |
| **Merchant dashboard for transactions & refunds** | Rich glassmorphic dashboard, searchable ledger, one-click refunds, and JSON cryptographic inspector | ✅ Complete |
| **Self-hosted / open-source deployment** | Monorepo structure, `Dockerfile.api`, `Dockerfile.web`, `docker-compose.yml`, and file-backed persistence | ✅ Complete |
| **E-commerce plugin or integration** | Open-source `@satsloom/ecommerce` SDK client, drop-in integration sample, and interactive **SatsShop** demo store | ✅ Complete |
| **Payout and liquidity-management flow** | Treasury dashboard with VTXO/LP balance tracker, cold storage payout sweep queue, and liquidity safety thresholds | ✅ Complete |

---

## 🔬 Tachi Primitives Demonstrated

- **TAURUS Vaults:** Verified against live Regtest (`https://rpc-regtest.tachibtc.com`) via `@tachibtc/taurus-vault-core`.
- **7-of-7 Online Validators:** Fetched directly from the live Tachi daemon.
- **P2TR Script Tree:** Cooperative taproot leaf hash + Unilateral CSV exit leaf hash.
- **PSBT Signing:** User-side Taproot Schnorr PSBT signing verified via `scripts/spike-tachi.ts`.
- **x402 Protocol:** HTTP 402 challenge negotiation and settlement verification for AI agents.

---

## 🛡️ Cryptographic Transparency & Degraded Mode Disclosure

SatsLoom adheres strictly to cryptographic integrity:
- The public `@tachibtc/taurus-vault-core` SDK exposes user signing, but KDHT node signature aggregation is documented as an out-of-band network operation.
- Rather than presenting false claims of cooperative broadcasting on regtest without the validator network aggregation, SatsLoom operates in an explicitly labeled **Degraded / Simulated Settlement** mode.
- The UI features clear disclosure badges, and API envelopes include `simulation: true`.

---

## ⚡ Quick Start

```powershell
# 1. Install dependencies and run test suite
npm install
npm test

# 2. Verify live Tachi Regtest connectivity & TAURUS vault construction
npm run spike:tachi

# 3. Start development servers (API: 3001, Web: 5174)
npm run dev
```

Visit **http://localhost:5174** to explore:
- **Merchant Terminal:** Create invoices, view BIP21 QR codes, score routes, simulate fallback.
- **SatsShop:** Purchase hardware items with 1-click checkout.
- **x402 Sandbox:** Watch autonomous AI agents pay for compute per request.
- **Telemetry:** Inspect live Tachi regtest validators and Taproot script leaves.
- **Ledger:** Audit all settlement receipts and webhook events.
