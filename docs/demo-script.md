# Demo walkthrough

This walkthrough demonstrates local application state only. No Bitcoin or Tachi settlement occurs.

1. Run `npm ci`, `npm test`, then `npm run dev`.
2. Open `http://localhost:5174` and note the simulation-only banner and the absence of live settlement metrics.
3. Create a demo invoice. The checkout page has no payment address or QR code; it explicitly states that no sats are received.
4. Click **Simulate invoice confirmation**. The invoice state changes in the local API, and an SSE event reports that application-state change.
5. Select a sample route, invalidate it, then settle. The response records a simulated fallback route and `simulation: true`; no funds move.
6. Open the x402 sandbox. It demonstrates a 402 challenge, a demo state transition, and a signed simulation receipt. An invoice ID alone does not unlock the sample resource.
7. Inspect operations and webhook screens. Values are demo data; outgoing webhooks require operator allow-list/secret configuration.
8. Optionally run `npm run spike:tachi` only after reviewing its configuration. The spike is separate from the public API's simulated settlement flow and may contact a regtest endpoint.

Never present these demo results as customer payment, production availability, or verified Bitcoin settlement.
