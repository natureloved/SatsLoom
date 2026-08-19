# SatsLoom architecture

The API orchestrates invoice, quote, deterministic route selection, settlement and recovery. The Tachi adapter is the only module allowed to know SDK details. Private signing material stays server-side. In degraded mode all settlement operations are explicitly simulated; vault/VTXO operations become live only after the configured daemon and official SDK methods are verified.
