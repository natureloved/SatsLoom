#!/usr/bin/env bash
# Boot the SatsLoom API against the live signet Lightning node.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

LND_DIR="${LND_DIR:-/home/ubuntu/signet-node/lnd-data}"

if [ -z "${LND_MACAROON_HEX:-}" ]; then
  MACAROON_PATH="${LND_DIR}/data/chain/bitcoin/signet/admin.macaroon"
  if [ -f "$MACAROON_PATH" ]; then
    MACAROON=$(xxd -p "$MACAROON_PATH" | tr -d '\n')
    export LND_MACAROON_HEX="$MACAROON"
  fi
fi

if [ -z "${LND_CA_CERT_PATH:-}" ] && [ -f "${LND_DIR}/tls.cert" ]; then
  export LND_CA_CERT_PATH="${LND_DIR}/tls.cert"
fi

export PORT="${PORT:-3001}"
export SATSLOOM_DATA_FILE="${SATSLOOM_DATA_FILE:-/tmp/satsloom-live-proof.json}"
export SATSLOOM_RAIL="${SATSLOOM_RAIL:-lnd}"
export LND_REST_URL="${LND_REST_URL:-https://127.0.0.1:8080}"
export LND_ALLOW_INSECURE_HTTP="${LND_ALLOW_INSECURE_HTTP:-true}"
export SATSLOOM_LIGHTNING_NETWORK="${SATSLOOM_LIGHTNING_NETWORK:-signet}"

echo "Starting SatsLoom API on :$PORT  rail=$SATSLOOM_RAIL  network=$SATSLOOM_LIGHTNING_NETWORK  data=$SATSLOOM_DATA_FILE"
exec npx tsx apps/api/src/server.ts
