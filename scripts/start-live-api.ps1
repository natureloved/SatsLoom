# Boot the SatsLoom API against the live signet Lightning node on Windows PowerShell.
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
Set-Location $repoDir

$lndDir = if ($env:LND_DIR) { $env:LND_DIR } else { "$env:LOCALAPPDATA\Lnd" }

if (-not $env:LND_MACAROON_HEX) {
    $macaroonPath = Join-Path $lndDir "data\chain\bitcoin\signet\admin.macaroon"
    if (Test-Path $macaroonPath) {
        $bytes = [System.IO.File]::ReadAllBytes($macaroonPath)
        $env:LND_MACAROON_HEX = [System.BitConverter]::ToString($bytes) -replace '-'
    }
}

if (-not $env:LND_CA_CERT_PATH) {
    $certPath = Join-Path $lndDir "tls.cert"
    if (Test-Path $certPath) {
        $env:LND_CA_CERT_PATH = $certPath
    }
}

if (-not $env:PORT) { $env:PORT = "3001" }
if (-not $env:SATSLOOM_DATA_FILE) { $env:SATSLOOM_DATA_FILE = "$env:TEMP\satsloom-live-proof.json" }
if (-not $env:SATSLOOM_RAIL) { $env:SATSLOOM_RAIL = "lnd" }
if (-not $env:LND_REST_URL) { $env:LND_REST_URL = "https://127.0.0.1:8080" }
if (-not $env:LND_ALLOW_INSECURE_HTTP) { $env:LND_ALLOW_INSECURE_HTTP = "true" }
if (-not $env:SATSLOOM_LIGHTNING_NETWORK) { $env:SATSLOOM_LIGHTNING_NETWORK = "signet" }

Write-Host "Starting SatsLoom API on :$($env:PORT)  rail=$($env:SATSLOOM_RAIL)  network=$($env:SATSLOOM_LIGHTNING_NETWORK)  data=$($env:SATSLOOM_DATA_FILE)"
npx tsx apps/api/src/server.ts
