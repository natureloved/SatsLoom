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

## Live end-to-end proof (2026-10-23, signet)

One spike run, every stage verified against the network rather than the app's own
read path:

| Stage | Result |
|---|---|
| daemon | reachable on `tachi-signet-1`, 7 validators |
| vault | `tb1p06cpczz8g49yg8nfssf55k4p2095gxl5rvg9rp0svv8z8zckp4lq50edft`, 1008-block CSV |
| faucet | tx `a79aca36…` confirmed at block 327,537, 50,000 sats |
| deposit | tx `054faa2a…` confirmed at block 327,538, 48,719 sats into the vault P2TR |
| ledger VTXO | `d9722386743afb5d950301674679fcfae9dbc1fd9672dd14ace558ff40c81f3b`, `amount: 48719`, `spent: false` |
| user PSBT signing | true (cooperative leaf) |
| unilateral exit | true, finalized, 1008 CSV blocks |

The 48,719 rather than 100,000 is not a shortfall: the faucet pays a fixed
50,000 sats, and the deposit is clamped to what the wallet can actually spend
after the fee and a spendable change output. See the fee/dust reserve in
`depositToVault`.

What is still **not** demonstrated: `kdhtCooperativeSigning` and `vtxoTransfer`
both report `unavailable`. The cooperative leaf needs 5-of-7 validator
signatures, which requires the quorum to cosign — a transfer was signed by the
user and verified, but not co-signed and broadcast by the validator set. That is
reported as unavailable rather than claimed.

## Product fund flow (2026-11-13, signet) — vault funding via the API

The adapter is now wired into the product as an opt-in fund flow
(`POST /api/tachi/vault/fund`, env-gated by `SATSLOOM_TACHI_FUND_ENABLED=true`,
admin token required outside tests). One job = one fresh disposable vault:
create it from the live quorum, fund its P2WPKH wallet from the public signet
faucet, wait for a real block, deposit into the vault P2TR, register the ledger
VTXO. Every transaction links to the Tachi Explorer
(`https://signet.tachibtcscan.com/tx/<hash>`) in the telemetry view, and a
completed run fires the in-app toast with the registration link. Per-tx explorer
links also render wherever a settlement carries an `explorerUrl` (receipt cards,
Operations view). Scope is vault funding / deposit / register only — a
Tachi-settled merchant payment is not offered and no code claims it, because it
needs 5-of-7 quorum cosignatures and the SDK exposes only `cosignRefund`.

### Fund-flow run 2026-11-13 (through the new product flow, not the spike)

| Stage | Result |
|---|---|
| route | `POST /api/tachi/vault/fund` → 202, job `16e01aae-98a1-418c-9a2e-412fcb35df96` |
| vault | `tb1p62vd82sxr76jfx4676ltnxwqrd9l867c8e8juvfy4dwkyyn0wt0sk69l7r`, derived from the live 7-validator quorum |
| funding wallet | `tb1q9fua3vz0hlg7jyfvqth434f39qsaranklrfvzs` |
| faucet | **Failed from this VM** — `POST faucet.rgbmap.org/v1/faucet` hung; the adapter's 30 s timeout aborted the claim (`This operation was aborted`). No faucet txid exists. Same failure mode as 2026-11-09/10; the user claimed it successfully from a browser on 2026-11-11. |
| deposit / register | **Not run** — the job stopped at `awaiting-manual-funding`, per the run instructions. No deposit txid, no VTXO id, nothing broadcast. |

To complete this run: fund `tb1q9fua3vz0hlg7jyfvqth434f39qsaranklrfvzs` from a
signet faucet (e.g. from a browser), then
`POST /api/tachi/vault/fund/16e01aae-98a1-418c-9a2e-412fcb35df96/continue`. The
job resumes from the deposit step; no new vault is needed. The mnemonic for
this vault was generated server-side, never logged or returned, and lives only
in the API process memory that created it — if that process restarts before the
run completes, the vault is unrecoverable and the run must start over with a
fresh vault.

### The run above was lost to a restart (2026-11-13 ~14:53 WAT) — and the fix

That is exactly what happened: a runtime/VM restart killed the API server on
`:3001` and wiped `/tmp`, and with it job `16e01aae-…` and its mnemonic. The
user's 500,000 signet sats are confirmed on-chain at
`tb1q9fua3vz0hlg7jyfvqth434f39qsaranklrfvzs` (one funding transaction,
unspent) but the key is lost, so they are stranded — signet-only test coin
with no real value, and no recovery is possible. Nothing had been broadcast
for that run (no deposit, no registration, no VTXO), so there is no unknown
transaction state. The old vault and funding addresses must never be reused.

The fix (same day): every fund job is now persisted to a mode-600 file under
`apps/api/.data/tachi-fund-jobs/<jobId>.json` (gitignored, never committed)
the moment it is created, and re-written after every stage transition. The
file holds the mnemonic, so on server start the API restores unfinished jobs
and resumes them from their recorded stage instead of losing them. The
mnemonic never appears in logs, API responses, or the public job record —
only in that locked file. Trade-off, stated plainly: this is recoverability
over memory-only secrecy, the same trade-off as the DrawBound operator vault
(mnemonic in a mode-600 file). Anyone with read access to this machine can
read the file, so the design is only acceptable for disposable signet-only
vaults, never for mainnet funds. Known limitation: a crash in the
milliseconds between a transaction being broadcast and its txid being
persisted could cause a repeated deposit on resume; the persist is
synchronous and happens immediately after each txid is recorded, so that
window is as small as this design allows. A fresh run through the patched
flow follows below.
