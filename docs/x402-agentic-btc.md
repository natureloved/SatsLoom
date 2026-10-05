# SatsLoom x402 Agentic Payment Protocol

Tachi is Bitcoin's Agentic Execution Layer, designed from the ground up for verifiable on-chain actions and native-sat machine payments using the **HTTP 402 "Payment Required"** pattern.

SatsLoom extends traditional merchant gateways by acting as a high-speed x402 settlement proxy for **autonomous AI agents**.

---

## The Machine Payment Problem

Traditional APIs require credit cards, Stripe accounts, and pre-funded subscriptions. Autonomous AI agents cannot open bank accounts or hold credit cards. They need:
1. Pay-per-request micropayments in native Satoshis.
2. Machine-readable price and invoice negotiation directly inside HTTP headers.
3. Sub-second or instantaneous off-chain settlement without waiting 10 minutes for Bitcoin L1 confirmations.

---

## The SatsLoom x402 Flow

```
Agent                             SatsLoom Gateway                  Tachi SatVM / VTXO
  │                                      │                                  │
  │  1. GET /api/x402/resource           │                                  │
  │─────────────────────────────────────>│                                  │
  │                                      │                                  │
  │  2. HTTP 402 Payment Required        │                                  │
  │     Header: WWW-Authenticate: L402   │                                  │
  │     Header: X-402-Invoice: <id>      │                                  │
  │     Header: X-402-Price-Sats: 50     │                                  │
  │<─────────────────────────────────────│                                  │
  │                                      │                                  │
  │  3. Settle Sats via VTXO Route       │                                  │
  │─────────────────────────────────────>│                                  │
  │                                      │  4. Cooperative VTXO Transfer    │
  │                                      │─────────────────────────────────>│
  │                                      │<─────────────────────────────────│
  │                                      │                                  │
  │  5. GET /api/x402/resource           │                                  │
  │     Header: X-Payment-Invoice: <id>  │                                  │
  │─────────────────────────────────────>│                                  │
  │                                      │                                  │
  │  6. HTTP 200 OK + Unlocked Payload   │                                  │
  │<─────────────────────────────────────│                                  │
```

---

## Code Example: Autonomous AI Agent Client

```ts
import { SatsLoomMerchantClient } from "@satsloom/ecommerce";

const client = new SatsLoomMerchantClient("http://localhost:3001");

// fetchWithX402 automatically detects 402, settles the sats off-chain, and returns the response
const response = await client.fetchWithX402("http://localhost:3001/api/x402/resource");
const data = await response.json();

console.log("Autonomous Data Unlocked:", data);
```
