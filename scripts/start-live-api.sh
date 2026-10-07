#!/usr/bin/env bash
# Boot the SatsLoom API against the live signet Lightning node.
set -euo pipefail
cd /home/ubuntu/SatsLoom
MACAROON=$(xxd -p /home/ubuntu/signet-node/lnd-data/data/chain/bitcoin/signet/admin.macaroon | tr -d '\n')
export PORT="${PORT:-3001}"
export SATSLOOM_DATA_FILE="${SATSLOOM_DATA_FILE:-/tmp/satsloom-live-proof.json}"
export SATSLOOM_RAIL=lnd
export LND_REST_URL=https://127.0.0.1:8080
export LND_MACAROON_HEX="$MACAROON"
export LND_CA_CERT_PATH=/home/ubuntu/signet-node/lnd-data/tls.cert
export LND_ALLOW_INSECURE_HTTP=true
export SATSLOOM_LIGHTNING_NETWORK=signet
echo "starting API on :$PORT  rail=lnd  network=signet  data=$SATSLOOM_DATA_FILE"
exec node node_modules/tsx/dist/cli.mjs apps/api/src/server.ts
