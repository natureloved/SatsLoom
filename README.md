# SatsLoom

Self-hosted merchant settlement router for Tachi. It accepts a native-sat invoice, evaluates liquidity routes, selects deterministically, and demonstrates fallback when the preferred route becomes unavailable. It is not a consumer wallet or a custody product.

Run `npm install`, then `npm run spike:tachi` for the machine-readable integration result. Start the API with `npm run dev --workspace @satsloom/api` and the web app with `npm run dev --workspace @satsloom/web`. Current default mode is degraded until a regtest daemon and documented Tachi SDK methods are configured.
