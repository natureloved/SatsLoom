# The 30-second video

Recorded at 1280×720 from a **live regtest** run. The rule: if a beat claims a settlement, the
explorer link on screen must be a real one. Fixture mode is labelled FIXTURE in the UI, so a
fixture recording could not honestly pass as this.

**Before you hit record** (skipping this is the single most common way to ruin the take):

```bash
npm run preflight -- --wait     # faucet → onboard → wait for the epoch. ~10 min/block on regtest.
npm run spike:tachi             # every critical row green, or stop and fix it first
# Fund the demo accounts AGAIN here — a recording drains them and the second take has nothing to spend.
TACHI_PROVIDER=live npm run dev
```

Have these open and already warm: the dashboard, and the liquidity tab with a quote loaded.

| Time | Beat | On screen | Narration |
| --- | --- | --- | --- |
| 0–4s | **Hook** | Dashboard: green daemon pill, off-chain and on-chain balances, invoice table | "Every merchant wants to accept Bitcoin. Almost none want to run a node, manage channels, or wait ten minutes to find out if they were paid. This is SatsLoom — a merchant settlement router on Tachi." |
| 4–8s | **Invoice** | Create invoice: 50,000 sats, memo `Demo order #1` → pay page opens with QR + countdown | "One paste-in button. The merchant names a price in sats, and SatsLoom mints an invoice with a QR and an expiry." |
| 8–11s | **Pay** | Pay page → **Pay with demo wallet** → spinner, status `pending` | "The customer pays off-chain — a real VTXO transfer from a second funded account. No channels, no mempool." |
| 11–14s | **Confirm + proof** | Status flips to `confirmed`, explorer link appears, click it; dashboard shows confirmed + webhook delivered | "It confirms in a single epoch, and here is the receipt — a real transaction on the Tachi regtest explorer. The shop gets a signed webhook, so it never has to guess on a redirect." |
| 14–18s | **Route table** | Liquidity tab: three sources with fee, timing, capacity, exit risk; the selected one and its published reason | "Underneath, SatsLoom is quoting every settlement route it can see, live — fee, timing, capacity, exit risk — and picking one deterministically." |
| 18–21s | **Fallback** | Click **Kill best route → auto-fallback** → route table re-settles on the runner-up, reason updates, decision log grows | "Now I kill the best route. It re-quotes, falls back to the runner-up, and tells me exactly why — with the whole decision log." |
| 21–26s | **Refund + sweep** | **Refund** → settled with txid + explorer link; then **Sweep to cold address** (on-chain redemption) → txid, timing estimate | "Refunds go back to the payer's key. And the merchant can sweep off-chain balance out to a cold Taproot address — on-chain, with a real redemption transaction and a timing estimate that respects the timelock." |
| 26–30s | **Endcard** | Repo URL, both bounty numbers, `npm run spike:tachi` green table, "one codebase, two bounties" | "Self-hosted, open source, keys never leave your server. SatsLoom — merchant payments and liquidity management, one codebase. Built for Tachi." |

## Recording mechanics

- 1280×720, 30 fps, browser at 100% zoom. The dashboard's numbers must be readable at 720p —
  if they are not, zoom the browser rather than scaling in the editor.
- Record the pay page and the explorer link in the **same** take as the invoice, so the timestamps
  corroborate each other.
- If a beat fails, fix the cause and re-record the whole take. Do not cut around a wrong result —
  the repo's own claim is "prove, don't claim", and a spliced take is a claim.
- Narrate live if you can; otherwise record the lines as separate takes and align at the beats
  above. Total narration is ~150 words, comfortable in 30 seconds.
- Upload unlisted to YouTube (or commit `docs/video.mp4` if it is under 10 MB), then put the link in
  the README table and in the submission form for both bounties.

## The two links that must exist before submitting

1. A deployed instance the judge can click (Compose on a VPS, or Fly + Vercel). Run the
   [judge click-path](../README.md#judge-click-path) twice in a row against it.
2. The video above, at a public URL.
