# x402-style demo endpoint

The API includes `GET /api/x402/resource` and `POST /api/x402/agent-pay` to demonstrate an HTTP 402 challenge/response shape. This is **not a Bitcoin-native payment integration** and does not charge sats.

## Demo flow

1. With demo mode enabled, `GET /api/x402/resource` returns HTTP 402, a sample invoice ID, and `WWW-Authenticate: SatsLoom-Demo ...`.
2. `POST /api/x402/agent-pay` marks that specially tagged 50-sat demo invoice as confirmed and settled in local application state. No payment, provider call, VTXO transfer, or chain broadcast occurs.
3. The API issues a short-lived HMAC-signed `SatsLoom-Demo <payload>.<signature>` receipt.
4. The client retries with that receipt in `Authorization`. The resource endpoint verifies the HMAC, expiry, matching invoice purpose, and simulated settlement state before returning sample content.

The signature makes the receipt tamper-evident within this application. It is **not** a Lightning invoice preimage, proof of Bitcoin payment, on-chain transaction, or third-party attestation. The sample resource content is not live market or Tachi data.

In production, set `SATSLOOM_DEMO_MODE=false` unless simulations are explicitly intended. To run the x402 demo in production mode, explicitly enable demo mode and configure a high-entropy `SATSLOOM_PROOF_SECRET`; doing so still does not enable real payments.
