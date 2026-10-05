# Merchant Payment Track Compliance

| Requirement | SatsLoom Status | Implementation Evidence |
| :--- | :--- | :--- |
| **Invoice generation** | Implemented (Full) | `POST /api/invoices`, `POST /api/checkout/session`, BIP21 QR code generator, live 15-min countdown timer, and customer checkout modal |
| **Real-time payment confirmation** | Implemented (Full) | Server-Sent Events (`/api/invoices/:id/events`) stream instant state updates to frontend, plus asynchronous HTTP webhook callbacks (`x-satsloom-event: payment.confirmed`) dispatched to merchant endpoints |
| **Transactions and refunds dashboard** | Implemented (Full) | Filterable, searchable transaction and refund ledger, one-click refund flows, cryptographic JSON inspector, and webhook delivery logs |
| **Self-hosted / open-source deployment** | Implemented (Full) | Turnkey `docker-compose.yml`, `Dockerfile.api`, `Dockerfile.web`, persistent storage (`data/satsloom.json`), and one-command `npm run dev` |
| **E-commerce plugin or integration** | Implemented (Full) | `@satsloom/ecommerce` SDK client, drop-in integration sample code, and interactive **SatsShop** e-commerce hardware store with one-click checkout |
| **Payout and liquidity management** | Implemented (Full) | Real-time liquidity tracker (VTXO, LP Float, Reserved), fee ceilings, cold storage payout sweep queue, and liquidity safety thresholds |

---

## Cryptographic Transparency: Cooperative VTXO Aggregation

The public `@tachibtc/taurus-vault-core` SDK exposes user signing, but KDHT node signature aggregation is documented as an out-of-band network operation. SatsLoom chooses cryptographic honesty: we demonstrate live TAURUS vault construction, validator discovery, and user PSBT signing on Tachi regtest, while explicitly labeling cooperative settlement execution as a **degraded simulation mode** across the API and UI.
