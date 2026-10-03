# Submission pack — Bounty #11 + Bounty #10

Everything you paste, in one place. One codebase, two submissions, separate descriptions.

## Before you submit

- [ ] `npm run preflight -- --wait` and `npm run spike:tachi` are green on a regtest-capable
      machine. **Nothing else matters if this is not done** — the live claims are unproven until it is.
- [ ] `npm run clickpath` passes **twice in a row** against the deployed instance.
- [ ] The deployed instance has `ENABLE_DEMO_ROUTES=true` (so judges can pay an invoice) and
      `TACHI_PROVIDER=live`. Set `PAYOUT_ADDRESS` so the sweep goes to a real cold address.
- [ ] The video is uploaded and its link is in the README table (`docs/VIDEO.md` is the script).
- [ ] The README's **Live demo** row is filled in with the deployed URL.
- [ ] Set the repository topics (Settings → Topics, or the ⚙️ next to About) — the API token used
      here cannot set them:

  ```
  bitcoin  tachi  taurus  vtxo  merchant-payments  liquidity  typescript  fastify  react
  ```

- [ ] Confirm no secrets are committed: `git log -p | grep -iE "mnemonic|private key" | head` should
      only ever show *names* like `MERCHANT_MNEMONIC`, never a twelve-word phrase. Every mnemonic in
      the test suite is a BIP-39 published vector.

## Submission A — Bounty #11, Merchant Payments

**Title:** SatsLoom — one button to get paid in native sats, with proof

**Description:**

> SatsLoom is a self-hosted merchant settlement router for Tachi. A merchant pastes one `<script>`
> tag and starts taking payment in native sats; the money lands in their own Tachi account, not in
> ours.
>
> What it does, end to end on regtest:
>
> - **Invoices** with an amount, a memo and an expiry, and a mobile-clean pay page (QR, countdown,
>   live status) the customer reaches from a link or from the embedded button.
> - **Real-time confirmation** from ledger evidence only. A detection loop moves
>   `created → pending → confirmed`, and every confirmation carries a transaction hash and an
>   explorer link. There is no endpoint that marks an invoice paid without an on-ledger proof — a
>   force-confirm route returns 501 and says why.
> - **A merchant dashboard**: invoice list with proof links, on-chain vs off-chain balance split,
>   refunds, payouts, and an activity feed of everything the router did.
> - **Webhooks** signed `t=<ts>,v1=<hmac-sha256>` with retries and a delivery log that shows every
>   attempt, its status and the exact signed body — because fulfilling on a redirect is how shops
>   get burned.
> - **Refunds and sweeps**: refund back to the payer's key, or sweep off-chain balance to a cold
>   Taproot address on L1.
> - **Deployment**: Docker Compose, Fly, Vercel, `.env.example`. Keys live in env vars on the
>   server; the browser never touches a mnemonic or the daemon (the daemon has no CORS for us and
>   all traffic is proxied through our API).
>
> **Proof, not claims:** 83 tests, the whole judge click-path automated (`npm run clickpath`, 34
> checks, exits non-zero), and a Day-1 capability gate (`npm run spike:tachi`) that prints a
> truth-table with a fix for every red row. `PROGRESS.md` states exactly what is verified locally
> and what still needs the live run — including the bug this discipline caught: a merchant's own
> payout was being counted as a customer payment, which would have shipped goods for money that
> never arrived. Detection now excludes self-created outputs and refuses to credit one ledger
> output to two invoices.

## Submission B — Bounty #10, Liquidity Management

**Title:** SatsLoom — deterministic settlement routing across live liquidity sources

**Description:**

> The same codebase submitted to Bounty #11, seen from the liquidity side. SatsLoom treats
> settlement as routing, because that is what it is.
>
> - **On-chain → off-chain** is visible: faucet → account → VTXO, with the balance split shown as
>   off-chain and on-chain in the dashboard.
> - **Off-chain → on-chain** is a real redemption to a P2TR address, with the timelock explained in
>   the merchant's language.
> - **Every route is quoted live** — fee, settlement time, capacity and exit risk per source, read
>   from the ledger rather than a config file. The capacity you see is the capacity that exists.
> - **Timelock abstraction**: merchants see `instant` / `~10 min`; BIP-68 CSV block counts appear
>   only behind an Advanced toggle, next to the sentence that explains them.
> - **A route directory with ≥2 live-evaluated sources** (own VTXO balance, quorum-cooperative
>   settlement, on-chain unilateral exit), a deterministic scorer over the merchant's policy
>   weights, a published human-readable reason for the pick, and a fallback demo that is wired to
>   the real thing: kill the best route, re-quote, settle on the runner-up, and read the decision
>   log entry that says why.
> - **Determinism you can check**: the same inputs give the same ranking, and the policy sliders
>   re-quote live — that is the point of a router you can argue with.
>
> All four routes come from the Taurus/Tachi primitives directly (`@tachibtc/taurus-vault-core`,
> `@tachibtc/tachi-sdk-ts`); no route is a simulation, and any route that cannot be served reports
> itself unavailable instead of being quietly dropped.

## Direct message to @madhugowda_s

> Hi — SatsLoom here, submitted to OP_Freedom Bounty #11 (Merchant Payments) and #10 (Liquidity
> Management) from one repo: <repo URL>
>
> Live demo: <deployed URL> · Video (30s): <video URL>
>
> One script tag gets a merchant paid in native sats on Tachi: invoice → real VTXO payment →
> confirmed with an explorer receipt → signed webhook, plus deterministic routing across three
> live liquidity sources with a kill-the-best-route fallback you can click. Everything is
> self-hosted; keys never leave the server.
>
> Worth knowing before you open it: the repo's `PROGRESS.md` separates what is verified locally
> from what the live regtest run proves, and `npm run spike:tachi` prints the capability table the
> submission rests on. Happy to walk through any part of it.

## Where each bounty's boxes are checked off

Both checklists live in the [README](../README.md) — Bounty #11 first, then Bounty #10 — with a
link to the file that implements each box. If a box is not green, it is not checked.
