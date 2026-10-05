# SatsLoom 60–90 second demo

1. Start the API and web app, then open the dashboard. Point out the degraded-mode badge and live Tachi status cards.
2. Create a 50,000-sat invoice. Explain that SatsLoom is a merchant router, not a wallet.
3. Click **Simulate payment**. The invoice moves to `PAYMENT_CONFIRMED`.
4. Click **Select best route**. The inspector shows the fast VTXO route, LP fallback, and timelocked on-chain route with fee, latency, capacity, expiry, and exit risk.
5. Click **Invalidate preferred + settle fallback**. The state machine marks the VTXO route unavailable, records fallback history, chooses the LP route, and settles it as an explicitly simulated result.
6. Show the settlement result: lifecycle, route, fallback explanation, simulation badge, and transaction identifier.
7. In a terminal, run `npm run spike:tachi` and show the real regtest proof: vault metadata, deposit txid, VTXO id, and `userPsbtSigning=true`. Explain that KDHT cooperative signing remains unavailable rather than being misrepresented.
