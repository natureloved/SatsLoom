# SatsLoom: from simulation to a live product

**Status of this document:** planning / decision support. Written 2026-10-06 against commit `99c6e3c`.
It contains claims about third-party rails that were checked first-hand from published packages on that
date; each is cited in [§14 Sources and how each claim was verified](#14-sources-and-how-each-claim-was-verified).
Re-verify before relying on any of them, because this ecosystem moves weekly.

---

## 1. Bottom line

SatsLoom as it stands is a **faithful simulation with an honest label**. Everything the README says is true:
invoices are records, settlement is a state machine, and no sats move. Turning it into a live product is not
a matter of "flipping a flag" — it is a matter of choosing a rail, then paying for that choice in engineering,
liquidity, compliance and operations.

Four facts decide the whole plan, and they are worth stating before anything else:

1. **Tachi cannot settle real payments today, and that is not SatsLoom's fault.** The Tachi SDK's own
   wallet-chain registry supports only `signet | regtest` — `mainnet` and `testnet` are explicitly *not*
   wallet chains, and passing them to `importUserWallet` is a type error. On top of that, the only
   quorum-cosigning entry point exported by `@tachibtc/taurus-vault-core@0.3.5` is `cosignRefund`
   (refund-to-self); there is no public path for a client to collect the quorum's cosignature on a transfer
   to an arbitrary third party. So the "Tachi settlement router" framing caps out at a **testnet demo**
   until Tachi ships mainnet and a third-party transfer-cosign API. The correct move is to keep Tachi behind
   an adapter interface and stop pretending it is the live rail.
2. **The rail that is live on Bitcoin mainnet *today* and matches SatsLoom's own vocabulary is Ark** —
   Arkade (Ark Labs, public since Oct 2025) and Bark (Second, mainnet since 9 Jun 2026) both run VTXOs with
   unilateral exit on mainnet and ship developer SDKs. SatsLoom's domain model (VTXO routes, cooperative
   signing, exit risk, timelocks) is *already* an Ark-shaped model. Retargeting from Tachi to Ark keeps the
   product thesis and buys real settlement.
3. **Lightning is the boring, correct choice for the first live version.** It is the only rail with mature
   merchant tooling, watched liquidity operations, and a now-standard agent story: Block contributed a
   **Bitcoin Lightning payment scheme to the x402 standard, merged 23 Sep 2026**. A live SatsLoom x402
   endpoint means a real BOLT11 invoice in the 402 response and a real preimage as proof — no HMAC demo token.
4. **The hard parts are not cryptographic.** They are: durable state and a double-entry ledger, per-invoice
   payment attribution, idempotency and outbox, key custody, liquidity, and the compliance question of
   *who is the money transmitter*. Those five areas are ~80% of the work and 100% of the ways a live product
   loses money.

**Recommended sequencing:** ship **L1** (real payment requests, real detection, testnet/signet) in ~2–3 weeks;
**L2** (live sats, small caps, single merchant, self-hosted Lightning node + on-chain fallback) in ~6–10 weeks;
**L3** (multi-merchant, licensed posture or licensed partner, SLA) in 4–9 months, gated on legal advice, not code.

---

## 2. Five levels of "live" — define the target before touching code

"Live" is a spectrum. Each level has a hard gate; do not skip one.

| Level | What is real | What is still fake | Gate to pass |
|---|---|---|---|
| **L0 — today** | Nothing. Deterministic simulation. | Everything. | Already passes (honesty is the product feature). |
| **L1 — real request, testnet** | BOLT11/BOLT12 invoice (or BIP21 address) generated per invoice, real QR, real expiry, real payment *detection* on signet/regtest. | Detected payments are testnet coins. No fiat value. | `npm run spike:*` shows a green live row; a real preimage/txid is stored against the invoice. |
| **L2 — live sats, capped** | Real mainnet settlement. Real merchant balance, real refunds, real payouts. Hard caps (e.g. ≤ 250k sats/tx, ≤ 1M sats float), one merchant, manual review above cap. | Multi-tenancy, SLA, licensing. | 100 consecutive real payments reconciled to the sats with **zero** un-reconciled balance; documented incident + refund drill. |
| **L3 — product** | Multi-merchant accounts, self-serve onboarding, API keys, durable webhooks, real liquidity ops, monitoring + on-call, published SLA and security posture. | Maybe fiat off-ramp, depending on partner. | Legal opinion on your money-transmission status in each served jurisdiction; SOC-2-style controls or equivalent; pen test closed. |
| **L4 — regulated scale** | Licensing where required (or a licensed partner carrying it), AML/KYC program, treasury desk, insurance, audited financials, 99.9%+ SLA. | Human support still expensive. | Regulator/licensing milestones per jurisdiction. |

**Most projects die between L2 and L3 for non-technical reasons.** Plan L3 before building L2.

---

## 3. The rail decision (the only decision that really matters)

### 3.1 Options, with what is actually true on 2026-10-06

| Rail | Real value possible today? | Settlement latency | Reversible? | What you must operate | Strategic fit with SatsLoom |
|---|---|---|---|---|---|
| **Lightning (BOLT11/BOLT12), self-hosted** | Yes — mainnet, mature | ms–seconds | No (refund = new payment) | `bitcoind` + LND/CLN/Eclair, channel + liquidity ops, watchtower, backups | **Best for L2.** Direct path to a real x402 seller endpoint. |
| **Lightning via a provider** (BTCPay Server, LNbits, Alby Hub, Voltage; or custodial: OpenNode, Strike, Blink, IBEX) | Yes | seconds | No | Far less infra; you inherit their limits/uptime | **Fastest to L1/L2.** Good for a first paying merchant; bad for a routing-differentiation story. |
| **Ark** — Arkade (Ark Labs) / Bark (Second) | Yes — mainnet since Oct 2025 / 9 Jun 2026 | seconds, batched rounds | No (VTXO transfer is final) | Ark operator dependency, VTXO refresh/expiry, unilateral-exit runbook | **Best fit for the thesis.** Keeps VTXO + exit-risk + timelock model; replace the Tachi adapter with an Ark one. |
| **On-chain only** (BIP21 + descriptor watcher) | Yes — trivially | 10 min – hours | No | `bitcoind`/Esplora, xpub/descriptor custody, confirmation + reorg policy | Good as a **fallback rail** and for high-value payments; unusable as the only rail for retail. |
| **Tachi / TAURUS** | **No — signet/regtest only; no public third-party transfer cosign** | n/a | n/a | A testnet daemon | Keep as an **adapter + spike only**. Do not promise it to a paying merchant. |
| **Custodial processor with a license** | Yes | seconds | Their policy | Almost nothing | Buys speed and compliance cover; costs margin (typically ~1%) and control. |

### 3.2 Recommendation

Run **two tracks in parallel** from day one, behind one internal interface:

```
                    ┌─────────────────────────────────────────┐
   Invoice ───────► │  PaymentRail interface (packages/rails) │
   state machine    │  createRequest() | verify() | refund()  │
                    │  payout() | liquidity() | health()      │
                    └───────┬──────────────┬──────────┬───────┘
                            │              │          │
                     LightningRail    OnchainRail   ArkRail      TachiRail
                      (L2 target)     (fallback)   (thesis)     (testnet only,
                                                                  keep as spike)
```

- **Track A (ship L2):** `LightningRail` via a self-hosted LND (or a provider first, then self-hosted),
  plus `OnchainRail` as a fallback and for payouts. This is the rail that can take real money this quarter.
- **Track B (keep the thesis alive):** `ArkRail` for the VTXO-shaped routing story, starting on signet and
  moving to mainnet caps as the operator matures. Archive `TachiRail` as a documented, testnet-only adapter.
- The **router score** (`packages/router/src/index.ts`) becomes genuinely interesting only when it scores
  *live* route candidates with real fees, real capacity and real expiry. That is the actual product
  differentiation: **policy-driven settlement routing across rails** — not "we have VTXOs".

### 3.3 Kill criteria for a rail

Drop a rail (or stay testnet-only) if any of these is true:

- It has no mainnet, or mainnet requires a bridge/wrapped asset you cannot audit.
- Its SDK is unlicensed or has an unresolved high-severity advisory in the path you ship.
- Its operator can block, delay or censor your settlement with no exit path your customers can use alone.
- Its refund story is "you cannot, ever" and you sell to consumers (see §7 on irreversibility).

---

## 4. What the product actually is

Pick one wedge. "A merchant gateway for everything" loses to Stripe-on-Bitcoin clones.

| Wedge | Who pays | Why they choose it | Rails |
|---|---|---|---|
| **A. Bitcoin checkout for a niche merchant** (digital goods, VPNs, VPN-like services, gaming credits, privacy-conscious SaaS) | Merchant pays ~0.5–1% + optional FX | Chargeback-free, instant, global, no card rails | Lightning + on-chain |
| **B. Agent-native paid API (x402)** — the current repo's most differentiated surface | API seller wants per-call revenue from agents | No signup, no card, machine-speed micropayments; x402 is now a Linux Foundation standard | Lightning (x402 Lightning scheme) |
| **C. Settlement router for other Bitcoin businesses** | Operators who already have rails, want policy-based routing | Your router, fallback semantics and receipts | Multi-rail |

**Recommended:** **B as the tip, A as the base.** The x402 endpoint is the cheapest live demo in the repo to
make real (one BOLT11 invoice, one preimage check, one replay store) and the router gives it a reason to exist.
A merchant checkout is what pays the bills. C is a later B2B play.

---

## 5. Engineering workstreams

Each item: **what exists today → what live requires → definition of done.** File references are to the
current tree, so this doubles as a to-do list.

### W1. Rail abstraction (new `packages/rails`)

- **Today:** `packages/tachi-adapter` implements a 12-method `TachiAdapter` interface used by nothing in the
  public API. Settlement is an inline closure in `apps/api/src/server.ts` (`settleInvoice(..., async (route) => ({simulation:true, txid}))`).
- **Needed:** one `PaymentRail` interface (create request / poll + subscribe / verify / refund / payout /
  liquidity / health), one implementation per rail, and a `RailRegistry` selected by config. Typed errors so
  the API answers 402/409/503 honestly instead of 500 (as the earlier, unmerged work already did —
  see [§12](#12-salvageable-assets-from-the-earlier-branch)).
- **Done when:** the API can be pointed at `lightning-signet`, `lightning-mainnet`, `onchain-mainnet` or
  `fixture` by environment variable only, and every response envelope states the real rail and mode.

### W2. Real payment request generation

- **Today:** `createDemoQuote()` and the checkout session return `paymentUrl: "/#checkout/<id>"` and
  `qrPayload: null`. `apps/web/src/components/QRCodeModal.tsx` renders an explicit *"Simulation only"* card.
- **Needed:** per invoice, produce a real payable artifact — BOLT11 (or BOLT12 offer) with `amount_msat`,
  description, and expiry; a BIP21 URI and `bitcoin:` QR for the on-chain fallback; a per-invoice derived
  address/script **so attribution is identity rather than inference** (today's design has one shared payment
  target, which the earlier work flagged as the root cause of a false-confirmation bug); fiat price with a
  lock window and a documented rate source + spread.
- **Done when:** a stranger can scan the QR with a real wallet and pay; the invoice records the payment
  request, its expiry, and the fiat rate used, immutably.

### W3. Payment detection and verification

- **Today:** `POST /api/invoices/:id/simulate-payment` calls `confirmPayment()` — a pure function.
- **Needed:** LND `SubscribeInvoices` / CLN subscriptions with reconnection and backfill, preimage
  verification and amount check; an on-chain watcher (Esplora/`bitcoind` ZMQ) with a confirmation policy
  (e.g. 1 conf ≤ 100k sats, 2 conf ≤ 1M, 3+ above) and **reorg handling that can un-confirm**; duplicate and
  replay guards; a "payment seen but underpaid/overpaid/partial" policy; per-invoice attribution registry.
- **Done when:** falsifiable invariant tests prove: no invoice is marked paid twice; no payment is credited
  to two invoices; a reorg flips the state back; a self-spend is never credited (this exact bug was found and
  fixed once already in the earlier branch — keep the regression test).

### W4. Persistence and the ledger

- **Today:** `apps/api/src/storage.ts` is a debounced single-process JSON file; on Vercel, process memory.
  `apps/api/src/server.ts` mutates `Map`s directly and calls `persist()`.
- **Needed:** Postgres + migrations (Drizzle/Prisma), transactions around every state change, **unique
  constraints for idempotency** (not the in-memory 24h map at `server.ts:178`), an append-only `events`
  table as the source of truth, and a **double-entry ledger** (accounts: merchant payable, customer payment,
  routing liquidity, fee revenue, refunds, payouts, on-chain fees) where every sat has a debit and a credit.
  Reconciliation job comparing ledger ↔ node ↔ exchange balance, with alerting on any drift.
- **Done when:** `ledger_entries` sums to zero per currency at all times; drift between the ledger and the
  node is detected within 60s; a crash between "payment detected" and "webhook sent" loses nothing.

### W5. Domain changes for real money

- **Today:** `packages/domain/src/index.ts` is a clean, well-reasoned state machine with a conservative
  retry rule (`RetryableSettlementError` = "the adapter positively confirmed no funds moved"). Keep this.
- **Needed:** partial payments and overpayment policy; `QUOTE_EXPIRED` handled as a first-class user flow;
  `SETTLEMENT_FAILED → REFUND_REQUIRED` given a *real* implementation with a payer-reachable refund address
  or refund invoice; route expiry bounded by something shorter than the invoice expiry; a documented
  "ambiguous failure" escape hatch for human ops (the model already refuses to auto-retry, which is right,
  but ops needs a queue and a runbook); and separately, per-rail fee/latency/exit-risk inputs fed from live
  data instead of `createDemoQuote()`'s constants.
- **Done when:** replayed failure scenarios from the runbook produce the documented state, and every terminal
  state has an operator action attached.

### W6. Events and webhooks (outbox)

- **Today:** SSE clients in a `Map`; `dispatchWebhook()` is fire-and-forget after an SSRF-hardened HTTPS POST;
  max 500 in-memory logs; retries only exist within the process.
- **Needed:** transactional outbox (write the event in the same DB transaction as the state change), a worker
  with exponential backoff + jitter, per-endpoint circuit breaking, a dead-letter queue with manual replay,
  delivery-attempt history, per-merchant signing keys with rotation (`x-satsloom-signature` stays HMAC-SHA256
  over the raw body, but add a timestamp header + tolerance window to kill replay), and idempotent event IDs
  so receivers can dedupe.
- **Done when:** a 24-hour outage on the receiver's side loses zero events; replay of any event after the
  fact is detectable by the receiver.

### W7. Identity, tenancy and API keys

- **Today:** one hard-coded `merchant-demo` (`server.ts:44`), one shared `SATSLOOM_ADMIN_TOKEN`, and any
  caller may create invoices when demo mode is on.
- **Needed:** merchant accounts, hashed API keys (`sk_live_…` / `sk_test_…`) with scopes, key rotation and
  revocation, per-key rate limits (the current limiter is a per-process `Map`), a separate
  operator/admin plane, audit logs, and test/live data separation.
- **Done when:** one merchant cannot read or mutate another's invoice by ID; keys can be rotated without
  downtime; every privileged action is in an audit log.

### W8. Keys, secrets and signing policy

- **Today:** `SATSLOOM_PROOF_SECRET` / `SATSLOOM_ADMIN_TOKEN` from env; the Tachi spike reads
  `TACHI_TEST_MNEMONIC` from env; `randomBytes` fallback for a missing proof secret outside production.
- **Needed:** seed signing material in a KMS/HSM or at minimum hardware-backed and never in env; documented
  hot-wallet limits with automatic sweeps to cold storage; a signing policy (max sats per tx, per hour, per
  destination class) enforced *below* the application; encrypted, backed-up, tested recovery procedure for
  all node/wallet material; separate credentials per environment; audit trail on every signing operation.
- **Done when:** a full compromise of the API process cannot move more than the hot-wallet cap, and you have
  restored from backup in a drill.

### W9. Node, liquidity and treasury ops

- **Today:** `const liquidity = { vtxoSats: 100_000n, providerSats: 250_000n, onchainSats: 1_000_000n }`.
- **Needed:** `bitcoind` + Lightning (or provider) with watchtower, static channel backups, disk/monitoring,
  version-pinning and an upgrade runbook; **inbound liquidity strategy** (that is what makes "receive
  payments" work — the #1 support burden for new Lightning merchants); routing fee policy; rebalancing
  (loop-outs, swaps, or self-payments) with cost accounting; channel open/close cost tracking; a float policy
  (how much sats sit in hot wallets) and a sweep schedule; fiat off-ramp integration with an
  exchange/OTC desk or a licensed partner.
- **Done when:** you can state, at any moment, how many sats you hold, where, and why; and you have serviced a
  week of payments without manual channel intervention.

### W10. Observability and operations

- **Today:** Fastify logs; a `/api/health` endpoint that reports persistence mode; nothing else.
- **Needed:** metrics (invoice created/paid/expired, settlement latency p50/p95, liquidity headroom, webhook
  success rate, ledger drift, node height/peers/channel balance), structured logs with request IDs (present)
  and correlation to invoice IDs, traces across API→rail→node, alert routing with on-call, a status page,
  runbooks per failure mode, backup/restore drills, and an incident post-mortem template.
- **Done when:** you learn about a payment failure from an alert, not from a merchant.

### W11. Security

- **Today:** genuinely good instincts already — SSRF-hardened webhooks with DNS pinning, constant-time token
  comparison, idempotency keys, rate limiting, allow-listed CORS, an honest threat note in
  `docs/architecture.md`. Keep all of it.
- **Needed:** a written threat model (key theft, invoice substitution, webhook forgery, replay, double-credit,
  amount tampering, SSRF, admin-token theft, dependency compromise, insider risk); external penetration test
  before L3; dependency policy + SBOM + automated scanning (the repo already notes unresolved high-severity
  advisories in the Tachi spike's dev dependency tree — that noise must not leak into the shipped API);
  secrets scanning in CI; WAF/bot management; per-IP and per-key quotas; and a bug bounty or at least a
  security contact + disclosure policy.
- **Done when:** the pen-test findings are closed or accepted in writing, and a red-team replay of the
  invoice/webhook flows fails.

### W12. Deployment topology

- **Today:** `vercel.json` two-service deploy and Dockerfiles; state is explicitly ephemeral on Vercel.
- **Needed:** a container platform for stateful workers (Fly.io/Render/Railway/Hetzner/K8s) plus managed
  Postgres and Redis; a worker process separate from the API (webhooks, detection, reconciliation); staged
  environments — `fixture` (CI) → `signet`/`regtest` → `mainnet-canary` → `mainnet`; canary deploys;
  blue/green for anything that touches keys; infrastructure as code; documented DR with an RPO/RTO target.
  Vercel can keep serving the UI and read-only API; it must not be the system of record.
- **Done when:** `terraform apply` (or equivalent) rebuilds the stack, and a restore drill meets the RPO.

### W13. Testing and release gates

- **Today:** 20+ unit tests, a smoke script, and a careful honesty posture. Good foundation.
- **Needed:** keep the honesty rule and make it mechanical — a `liveness audit` that prints, per capability,
  `verified on <network> at <commit> / not verified`, failing CI when a "live" badge has no receipt (the
  earlier branch's spike-as-deploy-gate is the right pattern — see §12); integration tests against
  regtest/signet in CI; failure injection (node down mid-settlement, duplicate webhook, reorg, expired
  invoice, insufficient liquidity); and load tests for the checkout path.
- **Done when:** no UI or README claim can be made without a machine-checked receipt.

### W14. Real x402 (if you take wedge B)

- **Today:** `GET /api/x402/resource` issues a `SatsLoom-Demo` HMAC receipt after a **simulated** settlement;
  `docs/x402-agentic-btc.md` is admirably honest that this is not payment proof.
- **Needed (this is now a real, specified thing):** implement x402's "exact" scheme with the **Bitcoin
  Lightning** payment method contributed by Block and merged 23 Sep 2026: return a 402 carrying a fresh
  BOLT11 invoice (price in millisatoshis, `maxTimeoutSeconds`, network/payment-method metadata), accept the
  preimage as the proof, verify it against the invoice **and** against a replay store, then serve. Add
  facilitator support if you want to be usable by third-party agents, per-call spend caps for agent wallets,
  and a clear policy on what happens at underpayment/overpayment. Keep the receipt vocabulary but base it on
  a real preimage this time.
- **Done when:** an unmodified x402 client can pay you on mainnet and gets content; the replay store rejects
  a reused preimage; the invoice is reconciled in the ledger like any other.

---

## 6. Money, treasury and unit economics

- **Float policy:** how many sats live in hot wallets vs cold; auto-sweep thresholds; who can move funds.
- **Payout policy:** schedule (T+0/T+1), minimum, fee, and whether merchants are paid in BTC or fiat.
- **Refunds:** on Bitcoin, a refund is a *new outbound payment* to an address you must obtain from the payer.
  That is a product decision, a support burden and a fraud vector. Decide the policy in writing before L2.
- **Fees you can actually cover:** routing fees, on-chain mining fees (both directions), Ark batch/refresh
  costs, provider fees, liquidity costs, exchange spread, and fiat off-ramp fees. If you price at "0.1% and
  free on-chain", you are subsidising high-value payments.
- **Example L2 unit economics** (illustrative, replace with your own numbers): 1,000 payments/month at an
  average 20k sats (~$20 at $100k/BTC) = 20M sats volume ≈ $20k; at 1% gross that is **$200/month** — which
  does not cover a node, Postgres, monitoring and your time. **Reality check: this is a business only with
  either (a) high average order value, (b) high volume, or (c) a second revenue line (per-API-call, SaaS fee,
  FX spread, or licensing the router).** Model this before you build L3.
- **Accounting:** BTC vs fiat bookkeeping, cost basis, revenue recognition timing (at payment or at payout),
  VAT/sales-tax treatment of crypto payments (varies by country and, in the EU, has its own body of case law),
  and per-transaction records good enough for an auditor.

---

## 7. Compliance, legal and jurisdiction — the gate between L2 and L3

This is not legal advice; it is the list you bring to a lawyer. But the shape of the analysis is stable:

1. **Custody analysis first.** Do you ever control customer or merchant funds? A self-custodial merchant
   gateway where the merchant holds their own keys and you only *route* is a very different regulatory animal
   from a service that credits balances and pays out later. **The more you look custodial, the more you look
   like a money transmitter.** Design for non-custody where you can.
2. **Money transmission licensing.** In the US: FinCEN MSB registration + a state-by-state money transmitter
   licence patchwork (or reliance on an exemption), plus a compliance program, a compliance officer, and
   surety bonds. "Accepting and transmitting convertible virtual currency" is squarely in the MSB definition;
   the operative question is whether an exemption (e.g. a payment processor acting for a merchant) applies —
   that is exactly the question to put to counsel. In the EU: MiCA's CASP regime and national implementations
   may bite depending on custody and on-exchange activity.
3. **The licensed-partner shortcut.** Route settlement through a licensed processor/bank partner for the
   first year; you keep the product and they keep the licence. Slower margin, dramatically faster launch, and
   it gives you real transaction data to argue about your own status later.
4. **AML/KYC/KYB:** merchant onboarding and identity verification, beneficial-ownership checks, sanctions and
   PEP screening (both parties), transaction monitoring with thresholds and SAR/STR filing if you are in
   scope, sanctions-geography policy, and record retention (typically 5 years in the US).
5. **Contracting:** merchant agreement (settlement terms, refund policy, prohibited goods, chargeback-less
   risk allocation, termination, audit rights), privacy policy (GDPR/CCPA — you will process invoice memos,
   IPs and emails; minimise and set retention), Terms for the agentic API, a DPA if you serve EU merchants.
6. **Consumer protection:** irreversible payments push disputes onto you even when the protocol cannot reverse
   them. Your policy must say who eats a wrong-amount or wrong-destination error, and your UI must make
   "Bitcoin payments are final" unmissable.
7. **Corporate/ops:** an entity in a crypto-friendly jurisdiction, a bank that will accept the flow of funds,
   insurance (cyber, crime/E&O, and possibly digital-asset custody cover), and a tax advisor.
8. **Licensing/SDK:** the repo declares **no license**, and `@tachibtc/taurus-vault-core@0.3.5` declares
   **no license field either** (that is the package that would do the cryptography). Using unlicensed
   dependencies in a commercial product is a real risk: get written clarification, or keep that rail out of
   what you ship. Choose a licence for SatsLoom deliberately (proprietary is a valid choice for a product;
   if open source, add `LICENSE` and a contribution policy), and generate an SBOM/license inventory in CI.

**Order of operations:** revenue model → custody design → counsel opinion on money transmission in the
jurisdictions you will actually serve → then licensing, or a partner, or a design change. Do not build L3 and
then discover L2 was illegal.

---

## 8. Go-to-market and support

- **ICP:** the merchant who loses money to chargebacks or cannot get card processing. Lead with
  chargeback-free, instant settlement, no chargebacks, global reach — not with "Bitcoin".
- **Wedge distribution:** plug into existing ecosystems (BTCPay Server plugin, WooCommerce/Shopify plugin,
  x402 directories/registries for the agent side) instead of building your own merchant pipeline from zero.
- **Pricing:** 0.5–1% per settled payment, optional FX spread, SaaS tier for the dashboard/router policy
  engine, per-call pricing for the x402 API. Free tier only on testnet.
- **Support reality:** Lightning support questions are mostly liquidity and "my payment is stuck". Publish
  self-serve diagnostics, a status page, and an SLA that distinguishes "network" from "our uptime".
- **Trust artifacts for L3:** published security posture, incident history, uptime stats, published fee
  schedule, and — since you are honest by design — a public "what we do not do" page. Your honesty is a
  brand asset; do not trade it for marketing copy.

---

## 9. Cost and timeline

### 9.1 Effort, one competent full-stack engineer (part-time reality shown in parentheses)

| Phase | Scope | Duration |
|---|---|---|
| **P0 — decisions** | Rail choice, wedge, custody posture, counsel engaged, licence decision for the repo | 1 week |
| **P1 — L1 on testnet** | Rail interface, real BOLT11/on-chain requests, real detection on signet/regtest, per-invoice attribution, liveness audit script, UI honesty switch | 2–3 weeks |
| **P2 — L2 live, capped** | Postgres + ledger, outbox webhooks, keys in KMS, hot-wallet caps, mainnet node + liquidity, reconciliation, alerts, refund/payout runbooks, 100-payment dress rehearsal | 4–7 weeks |
| **P3 — L3 product** | Multi-tenancy, self-serve onboarding, KYB/AML tooling, pen test, SLA, status page, support tooling, off-ramp integration, Ark rail | 8–16 weeks |
| **P4 — regulated scale** | Licensing or partner integration, audit, insurance, 24/7 ops | 3–12 months, legal-driven |

### 9.2 Recurring cost at L2 (rough monthly, USD)

| Item | Cost |
|---|---|
| VPS for `bitcoind` + LND (2 × 4 vCPU / 8 GB, fast SSD) | $80–200 |
| Managed Postgres + Redis | $25–100 |
| App hosting (API + worker + web) | $30–150 |
| Monitoring/logs/alerts | $0–100 |
| Liquidity cost (inbound capacity, rebalancing, channel opens) | $20–300, scales with volume |
| On-chain fees for payouts/sweeps | variable; budget a reserve |
| Domain, email, backups, secrets manager | $20–60 |
| **Total** | **≈ $200–900/month** before legal and your time |

### 9.3 One-time legal/security (L2→L3)

Counsel opinion on money transmission: $3k–15k. KYB/AML tooling: $100–500/month. Pen test: $5k–25k.
Insurance: $1k–10k/year. Licensing (if you go that route, US state-by-state): $50k–500k+ and 6–18 months —
which is exactly why the licensed-partner route exists.

---

## 10. Top risks, and how each one kills you

| Risk | Impact | Mitigation |
|---|---|---|
| False payment confirmation / double credit | Ships goods for money never received | Per-invoice derived targets; attribution registry; ledger sum invariants; regression tests (a version of this bug was already found once) |
| Key or admin-token compromise | Total loss of hot funds | KMS/HSM, signing policy below the app, hot-wallet caps, sweeps, rotation, least privilege |
| Regulatory action | Business ends, personal exposure | Counsel first; non-custodial design; licensed partner; documented AML posture |
| Liquidity dry-up | Payments cannot be received (worst possible merchant experience) | Inbound liquidity strategy, headroom alerts, rebalancing automation, provider fallback |
| Irreversible-payment disputes | Support cost, reputational damage | Written refund policy, unmissable UI warnings, address verification for large payouts |
| Rail immaturity (Ark/Tachi) | Roadmap slips, product promise breaks | Multi-rail abstraction; Tachi stays a spike; Ark stays capped until mature |
| Single-operator dependency | You cannot take a holiday | On-call, runbooks, DR drills, second operator, automation over heroics |
| Fabricated "live" claims | Trust destruction — the one asset this repo has | Keep the honesty discipline; CI-enforced liveness receipts (§W13) |

---

## 11. The 90-day plan, concretely

**Weeks 1–2 — decisions and foundations**
1. Answer the five questions in [§13](#13-open-decisions-needed-from-the-owner).
2. Bring `docs/live-product-plan.md` (this file) in line with the answers; delete what does not apply.
3. Stand up `packages/rails` with the `PaymentRail` interface + `FixtureRail` that wraps today's simulation
   behind the new interface, so nothing is lost and everything is now swappable.
4. Add the `liveness audit` script and wire it into CI (fails if a capability is claimed but unverified).
5. Choose a licence; add `LICENSE` (or a deliberate "proprietary" note) and an SBOM step.

**Weeks 3–5 — L1 (real request + real detection on testnet)**
6. `LightningRail`: BOLT11 issuance + `SubscribeInvoices` detection, against a signet/regtest LND.
7. Per-invoice derived target + attribution registry; port the anti-false-confirmation regression tests.
8. Real QR/BIP21 in the checkout UI (`apps/web/src/components/QRCodeModal.tsx`), with the mode badge driven
   by the API envelope, not hard-coded strings.
9. `OnchainRail` watcher with a confirmation policy and reorg handling.

**Weeks 6–10 — L2 prep**
10. Postgres + migrations + double-entry ledger + transactional outbox + unique idempotency constraints.
11. Webhook worker with retries, DLQ and replay-proof signatures.
12. Keys into KMS; hot-wallet caps enforced by signing policy; sweep job.
13. Mainnet node, liquidity plan, monitoring + alerts, runbooks for the five top failure modes.
14. Dress rehearsal: 100 real capped payments, reconciled to the sat, with one deliberate refund and one
    deliberate node outage; publish the internal post-mortem.

**Weeks 11–13 — L2 launch (or partner onboarding)**
15. One real merchant (ideally your own project) taking real payments behind caps.
16. Publish the fee schedule, refund policy, privacy policy and a "what we do not do" page.
17. Legal opinion in hand before raising caps or taking merchant #2.

---

## 12. Salvageable assets from the earlier branch

The repo's history has a deliberately squashed main, but the earlier branch
`origin/arena/01a1014a-satsloom` (PR #1, merged then superseded) contains substantial live-rail work worth
reusing rather than rewriting:

| Asset | Path on that branch | Why it matters |
|---|---|---|
| `LiveTachiDaemon` (real daemon RPC incl. `broadcastTxSync` CheckTx interpretation) | `packages/tachi-adapter/src/daemon.ts` (678 lines) | The client shape (typed errors, honesty about mode) is exactly what `LightningRail`/`ArkRail` need |
| `TachiRail` (onboard/transfer/withdraw + signing envelope, `selfOwnedVtxoIds`, deterministic coin selection) | `packages/tachi-adapter/src/rail.ts` (474 lines) | The `selfOwnedVtxoIds` idea is the anti-false-confirmation mechanism; transferable to any rail |
| Typed errors (`DaemonUnreachable`, `ProofStale`, `InsufficientCapacity`, `RouteUnavailable`) | `packages/tachi-adapter/src/errors.ts` | Directly maps to 402/409/503 API semantics |
| Spike-as-deploy-gate with truth table + `--write` receipt | `scripts/spike-tachi.ts` | The pattern that makes honesty mechanical (see §W13) |
| Pay page, plugin embed, policy editor, render tests, click-path script, deploy configs (Fly/Compose/nginx) | `apps/web/src/pages.tsx`, `apps/web/public/embed.js`, `deploy/` | Saves weeks of UI/deploy work |
| An honest build log with a verified/unverified table and known gaps | `PROGRESS.md` | Keep this genre; it is the trust artifact |

**Caveat:** none of that was ever verified on a live daemon (the build log says so), and it targets a rail
that has no mainnet. Treat it as *structure to port*, not code to restore. Do not resurrect it wholesale, and
never re-enable it with a `mode: "live"` label until a receipt exists.

---

## 13. Open decisions needed from the owner

Answer these five and the rest of the plan collapses into a to-do list:

1. **Rail for L2:** Lightning self-hosted / Lightning via provider / Ark / on-chain / licensed partner?
2. **Product wedge:** merchant checkout (A), agentic x402 API (B), settlement-router-for-businesses (C), or A+B?
3. **Custody posture:** non-custodial merchant-direct, or do you take custody of balances (and with it, the
   money-transmission question)? Do you have a jurisdiction in mind where you will serve customers?
4. **Appetite for compliance:** do you want your own licence eventually, or is a licensed partner acceptable?
5. **Licence for the repo:** proprietary product, or open source (and if open source, which licence — note the
   unlicensed Tachi core dependency)?

---

## 14. Sources and how each claim was verified

Third-party claims in this document were checked on 2026-10-06:

- **Tachi has no mainnet wallet chain.** `@tachibtc/taurus-vault-core@0.3.5` README, "Two network registries":
  `VaultWalletChain = signet | regtest`, and "`mainnet` and `testnet` are not wallet chains, and passing either
  to `importUserWallet` is a type error". Verified by unpacking the published tarball from npm and reading
  `package/README.md` and `dist/index.d.ts`. Published 2026-09-23. Package npm metadata:
  `@tachibtc/taurus-vault-core` latest `0.3.5`; `@tachibtc/tachi-sdk-ts` latest `0.2.1`;
  `@tachibtc/taurus-wallet-aggregator` latest `0.4.5`.
- **No public third-party transfer-cosign API.** The full export list of `taurus-vault-core@0.3.5` contains
  `buildRefundPsbt`, `cosignRefund`, `applyRefundCosignPartials`, `signRefundPsbtAsUser`,
  `verifyRefundPsbt`, `finalizeRefundPsbt` — all refund-shaped — and no cosign entry point for a transfer to
  an arbitrary third party. This matches the independent report in the Nibi project
  (<https://github.com/Emmythefirst/Nibi>), which states Tachi confirmed to them (Aug 2026) that the quorum can
  cosign a transfer but the only public signing path is `cosignRefund`, scoped to refund-to-self, and that
  they re-checked after v0.3.3→0.3.5 (Sep 2026) and the gap remained.
- **Tachi projects are testnet-only in practice.** RIPCORD (<https://github.com/Jayanng/ripcord>): "targeting
  Tachi regtest only … no signet or mainnet support"; tachi-flow (<https://github.com/voiceroy/tachi-flow>):
  "Tachi regtest, not mainnet". Some projects also report a signet quorum
  (e.g. <https://github.com/Emmythefirst/Clavis>).
- **Ark is live on Bitcoin mainnet.** Arkade (Ark Labs) made its first mainnet payments in Aug 2025 and opened
  publicly in Oct 2025; Second's Bark reached mainnet on 9 Jun 2026 with a public server, developer SDK,
  mobile wallets, an Umbrel app and a BTCPay Server plugin —
  <https://bitcoinops.org/en/topics/ark/> and <https://blog.bitfinex.com/industry-news/building-financial-infrastructure-on-bitcoin-ark/>.
  V-PACK (Mar 2026) is a cross-implementation VTXO verification format and is still early.
- **x402 is now a Linux Foundation standard and has a Bitcoin Lightning scheme.** The x402 Foundation launched
  operationally 14 Jul 2026; Block joined and contributed Lightning payments, with the specification merged
  23 Sep 2026: the seller returns a fresh BOLT11 invoice inside the HTTP 402 response, the agent returns the
  preimage as proof, and a facilitator verifies it and records it against replay —
  <https://payzum.com/blog/bitcoin-lightning-x402-api-sellers/> and
  <https://www.bitget.com/amp/news/detail/12560605885012>.
- **Unresolved advisories in the Tachi spike's dependency tree** are already documented in this repo's README;
  that claim was not re-verified here.
- **Licensing:** `@tachibtc/taurus-vault-core@0.3.5` has no `license` field in its published `package.json`;
  `@tachibtc/tachi-sdk-ts@0.2.1` declares MIT. Verified from the published tarballs.

Everything else in this document is either a direct reading of this repository (file and line references are
to commit `99c6e3c`) or an engineering judgement, and is labelled as such.
