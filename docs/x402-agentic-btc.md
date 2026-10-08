# x402 / L402 Agent Payment Flow

SatsLoom supports machine-to-machine, agentic payments via the x402 / L402 protocol standard. It features a **live L402 paywall** when connected to a Lightning node, and a tamper-evident **signed receipt fallback** for simulated sandbox testing.

## 1. Live L402 Paywall (Node Configured)

When a Lightning node is active (`SATSLOOM_RAIL=lnd` or reachable node):

1. **Challenge:** An agent requests `GET /api/x402/resource`. The API answers with `HTTP 402 Payment Required` and headers:
   ```http
   WWW-Authenticate: L402 macaroon="pay-to-obtain", invoice="lntbs...", price="50", currency="SAT"
   x-satsloom-payment-hash: <paymentHash>
   ```
2. **Settlement:** The AI agent pays the BOLT11 invoice over the Lightning Network (e.g. via Signet wallet or automated agent treasury).
3. **Observation & Crediting:** SatsLoom's `InvoiceWatcher` detects the settled HTLC and obtains the preimage revealed by the payer's node. `verifyPayment()` cryptographically confirms `sha256(preimage) == paymentHash`.
4. **Unlock:** The agent retries with the credential in the `Authorization` header:
   ```http
   Authorization: L402 <macaroon>:<preimage>
   ```
   The API verifies that `sha256(preimage)` matches the invoice's payment hash and responds with `HTTP 200 OK` and `{ unlocked: true, protocol: "L402", proof: "preimage-sha256" }`.

## 2. Sandbox Simulation Fallback (Demo Mode)

When running offline or without an active Lightning node:

1. `GET /api/x402/resource` returns `HTTP 402` with `WWW-Authenticate: SatsLoom-Demo ...`.
2. `POST /api/x402/agent-pay` simulates payment in local state and issues an HMAC-SHA256 signed `SatsLoom-Demo <payload>.<signature>` receipt.
3. The client replays `GET /api/x402/resource` with `Authorization: SatsLoom-Demo ...`. The server validates the HMAC signature, timestamp expiry, and demo state to release sample content.

In production environments without a node, set `SATSLOOM_DEMO_MODE=false` unless simulations are explicitly enabled.

