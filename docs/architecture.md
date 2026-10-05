# SatsLoom architecture

The API orchestrates invoice, quote, deterministic route selection, settlement and recovery. The domain package owns the invoice lifecycle and invariants: confirmation and settlement are idempotent, decisions become immutable once execution starts, quote expiry is checked immediately before execution, and unavailable routes produce a recorded fallback or `REFUND_REQUIRED` state. The Tachi adapter is the only module allowed to know SDK details. Private signing material stays server-side.

Live mode covers daemon health, validator discovery, TAURUS vault construction/verification, Bitcoin regtest deposit, VTXO registration/query, user PSBT signing, and unilateral-exit preparation. The public SDK does not provide KDHT quorum partials as a complete client-side operation; therefore cooperative transfer broadcast is unavailable and the demo uses deterministic simulation with a visible badge.

State flow:

```text
CREATED → QUOTED → PAYMENT_CONFIRMED → ROUTE_SELECTED → SETTLING → SETTLED
                                      │                  └→ SETTLEMENT_FAILED
                                      └→ FALLBACK_SELECTED └→ REFUND_REQUIRED
```

The merchant-facing decision records route score inputs, expiry, capacity, exit risk, and a human-readable reason. Recovery is not a UI animation: invalidating the selected route changes route availability, appends a fallback event, and executes the next eligible route exactly once.
