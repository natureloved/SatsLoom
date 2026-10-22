# Signet Support for SatsLoom

## Goal
Make SatsLoom's Tachi/TAURUS integration run on **Bitcoin signet** instead of being
hardwired to regtest, so the project can be demonstrated publicly and transparently
rather than on a private regtest chain.

## What is already proven (do not re-litigate)
- Lightning/signet rail: 1,000 sats moved live, preimage-sha256 verified.
- SDK supports signet natively:
  - `VaultNetworkName = "mainnet" | "testnet" | "signet" | "regtest"`
  - `DEFAULT_WALLET_NETWORK = SIGNET` in `taurus-wallet-aggregator`
  - `SIGNET` config: bech32 `tb`, coinType 1, RPC `https://rpc-signet.tachibtc.com`,
    esplora `https://btc-signet.xverse.app`
- Live signet daemon verified by direct probe:
  - `GET https://rpc-signet.tachibtc.com/health` -> `{"status":"ok","validators":1}`
  - `GET https://rpc-signet.tachibtc.com/tachi_status` -> network `tachi-signet-1`,
    block height 1,357,867, version 0.39.0
  - `GET https://rpc-signet.tachibtc.com/tachi_validators` -> 7 validators, `count: 7`
- Live signet explorer: `https://signet.tachibtcscan.com` returns 200.

## The gap
`packages/tachi-adapter/src/index.ts` hardcodes regtest in three places:
1. `TachiAdapterConfig.network: "regtest"` (type)
2. `loadTachiConfig()` returns `network: "regtest"` unconditionally
3. Defaults: `https://rpc-regtest.tachibtc.com`, `https://regtest.tachibtcscan.com`

`scripts/spike-tachi.ts` requires `TACHI_TEST_MNEMONIC` and calls
`prepareRegtestFunding`/`mineRegtestBlocks`, which need a local bitcoind wallet.
`.env.example` documents only regtest.

## Changes

### 1. Adapter: make the network a first-class setting
- `network: VaultNetworkName` (i.e. `"signet" | "regtest"`, plus the SDK's other
  names) instead of the literal `"regtest"`.
- `loadTachiConfig()`:
  - `TACHI_NETWORK` env, validated against the SDK's supported set; default `"signet"`.
  - Default daemon/explorer URLs resolved **per network**, not one global default.
  - Reject an explicit `TACHI_NETWORK` that is not a supported vault network with a
    clear error rather than silently falling back.
- Rename the regtest-specific helpers so they read as what they are:
  `prepareRegtestFunding` -> `prepareLocalFunding` (regtest-only, guarded),
  `mineRegtestBlocks` -> `mineLocalBlocks` (regtest-only, guarded).
  Both throw a clear error when `network !== "regtest"` instead of hitting a public
  endpoint that 403s wallet methods.
- Keep the adapter's public method surface backwards compatible where cheap; the
  interface changes are additive.

### 2. Signet funding path (the real work)
On signet there is no local bitcoind wallet. Per the skill's always-on rules:
- Fund a **P2WPKH** wallet from `faucet.tachibtc.com` first, then deposit *from*
  that wallet into the vault's **P2TR** address. Never send faucet funds straight
  to the vault address (they strand with no way to register them).
- The public daemon permits `scantxoutset` / `sendrawtransaction` / `getrawtransaction`
  / `estimatesmartfee` but 403s `getbalance`, `listunspent`, `fundrawtransaction`,
  `getnewaddress`. So the aggregator's `sync()` cannot run against the public RPC —
  the wallet must be funded externally and the deposit spent from a locally built tx.
- Registration is two steps: `depositToVault` (L1) then `registerVault` (TxVaultOpen).
  A transition referencing an unregistered vault fails with "vtxo not found".
- One deposit per vault; derive every test vault from a fresh random key.

### 3. Spike script
- Drop the `TACHI_TEST_MNEMONIC`-regtest-only framing; accept any network, default
  signet.
- On signet, skip the local-mining steps and use the faucet path.
- Report the network in the machine-readable output so the run is self-describing.

### 4. Docs / config
- `.env.example`: document `TACHI_NETWORK`, signet daemon + explorer + faucet, and
  which steps need a local bitcoind vs the faucet.
- `SUBMISSION.md`: update the status table — signet is a supported, demonstrated
  configuration, not a promise.

### 5. Proof
- Extend `scripts/live-signet-proof.mts`-style discipline to Tachi: a
  `scripts/signet-tachi-proof.mts` that derives a vault from the **live** quorum,
  funds it from the faucet, registers it, and confirms the write on the ledger via
  `getTachiTx` (`state === "committed"`, `code === 0`) — never claiming success from
  the app's own response.
- Verify writes on the ledger, not the app's read path.

## Verification gates
- `npx tsc --noEmit` clean
- full `vitest` suite green (baseline: 90 passed; +13 adapter tests = 103)
- live signet proof script prints a real vault id / vtxo id / committed tx hash

## Findings from the live run (verified, not assumed)

| Fact | Evidence |
|---|---|
| Signet daemon is live | `GET /tachi_status` → network `tachi-signet-1`, height 1,357,867, v0.39.0 |
| 7 validators advertised | `GET /tachi_validators` → `count: 7` |
| Vault derivation works | `createVault` → `tb1p…`, 1008-block CSV, `verifyVaultP2tr` passed |
| `nodePubkeys` + `validators` are mutually exclusive | SDK throws `INVALID_VAULT_ARGS`; the `validators` path is used because it is chain-bound |
| Public faucet funds signet with no auth | `POST faucet.rgbmap.org/v1/faucet` → txid + 50,000 sats |
| Tachi's own faucet needs GitHub/X sign-in | `POST faucet.tachibtc.com/api/signet/faucet` → `{"error":"sign in to claim"}` — not scriptable |
| Wallet RPC surface on the public daemon | `getbalance`/`listunspent`/`getnewaddress` → "method not permitted"; `scantxoutset`/`sendrawtransaction`/`getrawtransaction`/`estimatesmartfee` permitted |
| `scantxoutset` is globally locked on the public daemon | concurrent users get `rpc error -8: Scan already in progress`; the SDK retries -8 with backoff, so this is transient |
| Tachi signet explorer is a ledger indexer, not a block explorer | `api-signet-explorer.tachibtc.com/api/v1/tachi/…` serves epochs/vaults/vtxos; it has **no** Bitcoin tx-confirmation state, so deposit confirmation polls mempool.space's signet API instead |
| `signet.tachibtcscan.com` is a static SPA | `/api/tx/…` returns the HTML shell, not JSON |

## Honesty constraint
Signet coins have no value. Any UI/API that reports the Tachi rail as "live" must
label it as signet test coins, the same way the Lightning rail already does.

