import React, { useEffect, useState } from "react";

type TelemetryResponse = {
  network?: string;
  daemonUrl?: string;
  explorerUrl?: string;
  timelockBlocks?: number;
  validatorCount?: number;
  validators?: Array<{ id: string; endpoint?: string; online: boolean }>;
  daemon?: { reachable?: boolean; checked?: boolean; endpointConfigured?: boolean; message?: string; version?: string; network?: string };
  primitives?: Record<string, string>;
  fundFlow?: { enabled?: boolean; start?: string; status?: string; scope?: string };
};

type FundTx = { txid: string; explorerUrl: string; bitcoinExplorerUrl?: string; sats?: string; amountSats?: string };
type FundJob = {
  id: string;
  status: "running" | "awaiting-manual-funding" | "complete" | "failed";
  stage: string;
  network?: string;
  explorerUrl?: string;
  vaultAddress: string | null;
  fundingAddress: string | null;
  depositRequestedSats?: string;
  faucet: FundTx | null;
  deposit: FundTx | null;
  registration: { broadcastHash: string; explorerUrl: string; vtxoId: string; feeSats: string } | null;
  error: string | null;
};

export function TachiTelemetryView({ onTachiTx }: { onTachiTx?: (label: string, url: string) => void }) {
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fundJob, setFundJob] = useState<FundJob | null>(null);
  const [fundBusy, setFundBusy] = useState(false);
  const [fundError, setFundError] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const notifiedJobRef = React.useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tachi/telemetry")
      .then(async (response) => {
        // Read the body as text first: a 404 from a proxy or a CDN edge answers with plain text or
        // HTML, and response.json() would then throw a raw parser error instead of the useful message.
        const raw = await response.text();
        let body: { error?: string; data?: { error?: string } } = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new Error(
            `Telemetry endpoint returned ${response.status} ${response.headers.get("content-type") ?? "unknown content-type"}: ${raw.slice(0, 120) || "(empty body)"}`,
          );
        }
        if (!response.ok) throw new Error(body.error ?? body.data?.error ?? `Telemetry request failed (${response.status})`);
        if (!cancelled) setTelemetry(body.data);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Poll a fund job while it is active. Signet blocks average ~10 minutes, so
  // a run takes a while; the job record is the source of truth, not this view.
  useEffect(() => {
    if (!fundJob || (fundJob.status !== "running" && fundJob.status !== "awaiting-manual-funding")) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/tachi/vault/fund/${fundJob.id}`);
        const body = await response.json().catch(() => ({}));
        if (response.ok && body.data) setFundJob(body.data);
      } catch {
        // Polling is best-effort; a failed poll leaves the last known state.
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [fundJob?.id, fundJob?.status]);

  // Fire the toast once, when a run completes — with the registration link.
  useEffect(() => {
    if (fundJob?.status === "complete" && fundJob.registration && notifiedJobRef.current !== fundJob.id) {
      notifiedJobRef.current = fundJob.id;
      onTachiTx?.("Tachi vault funded — VTXO registered. Verify on the Tachi Explorer:", fundJob.registration.explorerUrl);
    }
  }, [fundJob, onTachiTx]);

  const startFund = async () => {
    setFundError("");
    setFundBusy(true);
    try {
      const response = await fetch("/api/tachi/vault/fund", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
        },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? body.data?.error ?? `Fund request failed (${response.status})`);
      notifiedJobRef.current = null;
      setFundJob(body.data);
    } catch (cause) {
      setFundError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFundBusy(false);
    }
  };

  const continueFund = async () => {
    if (!fundJob) return;
    setFundError("");
    setFundBusy(true);
    try {
      const response = await fetch(`/api/tachi/vault/fund/${fundJob.id}/continue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
        },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? body.data?.error ?? `Continue failed (${response.status})`);
      setFundJob(body.data);
    } catch (cause) {
      setFundError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFundBusy(false);
    }
  };

  if (loading) return <div className="loading-state">Loading Tachi integration notes…</div>;

  const reachable = telemetry?.daemon?.reachable === true;
  const checked = telemetry?.daemon?.checked === true;
  const endpointColor = checked && reachable ? "#16845b" : "#a05a00";
  const validators = telemetry?.validators ?? [];
  const fundActive = fundJob !== null && (fundJob.status === "running" || fundJob.status === "awaiting-manual-funding");

  const txRow = (label: string, tx: FundTx | null, extra?: string) => {
    if (!tx) return null;
    return (
      <div className="detail-item">
        <span>{label}:</span>
        <span>
          <a href={tx.explorerUrl} target="_blank" rel="noreferrer">{tx.txid.slice(0, 16)}… ↗</a>
          {extra ? ` ${extra}` : ""}
          {tx.bitcoinExplorerUrl && (
            <> · <a href={tx.bitcoinExplorerUrl} target="_blank" rel="noreferrer">Bitcoin explorer ↗</a></>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="telemetry-container">
      <div className="telemetry-header">
        <div>
          <h2>Tachi SDK integration status</h2>
          <p className="telemetry-subtitle">The public API does not query Tachi. This demo does not use Tachi to execute invoice payments or settlements.</p>
        </div>
        <div className="telemetry-badge-row">
          <span className="net-pill">{telemetry?.network ?? "network unknown"}</span>
          <span className="live-pulse-badge" style={{
            color: endpointColor,
            background: checked && reachable ? "rgba(184, 224, 105, 0.1)" : "rgba(160, 90, 0, 0.1)",
            borderColor: checked && reachable ? "rgba(184, 224, 105, 0.3)" : "rgba(160, 90, 0, 0.3)",
          }}>
            <span className="green-dot" style={{ background: endpointColor, boxShadow: checked && reachable ? `0 0 6px ${endpointColor}` : "none" }}></span>{!checked ? "Not queried by API" : reachable ? "Endpoint reachable" : "Endpoint unavailable"}
          </span>
        </div>
      </div>

      {error && <div className="global-error-banner" role="alert">{error}</div>}

      <div className="telemetry-summary-cards">
        <div className="telemetry-card">
          <span className="card-kicker">Configured network</span>
          <h3>{telemetry?.network ?? "Unknown"}</h3>
          <p>Integration target only; the public API does not test daemon connectivity.</p>
        </div>
        <div className="telemetry-card">
          <span className="card-kicker">Live validator query</span>
          <h3>Not run</h3>
          <p>The API reports no live validator count or settlement quorum.</p>
        </div>
        <div className="telemetry-card">
          <span className="card-kicker">Example CSV value</span>
          <h3>Not configured</h3>
          <p>No active vault, exit script, or timelock is configured in this app.</p>
        </div>
        <div className="telemetry-card">
          <span className="card-kicker">Tachi vault execution</span>
          <h3>{telemetry?.fundFlow?.enabled ? "Fund flow enabled" : "Opt-in fund flow"}</h3>
          <p>Vault funding, deposit and registration run on Bitcoin signet through the opt-in fund flow below. Merchant settlement still runs on Lightning — a Tachi-settled merchant payment needs quorum cosignatures the SDK does not expose.</p>
        </div>
      </div>

      <div className="vault-inspection-section">
        <h3>Integration boundary</h3>
        <p className="section-note">The repository includes a Tachi adapter and an opt-in fund flow (POST /api/tachi/vault/fund) that creates a fresh disposable vault, funds it from the public signet faucet, deposits and registers the VTXO. The settlement endpoints still only return simulated state for merchant payments and never call vault, deposit, transfer, or broadcast methods for them.</p>
        <div className="p2tr-details-box">
          <div className="detail-item">
            <span>Tachi daemon endpoint:</span>
            <code>{telemetry?.daemonUrl ?? "Not configured"}</code>
          </div>
          <div className="detail-item">
            <span>Daemon status:</span>
            <code>{checked ? reachable ? `reachable${telemetry?.daemon?.version ? ` · ${telemetry.daemon.version}` : ""}` : "unavailable" : "not queried by this API"}</code>
          </div>
          <div className="detail-item">
            <span>Tachi settlement:</span>
            <code>not integrated · no vault, deposit, transfer, or broadcast calls</code>
          </div>
          {telemetry?.explorerUrl && (
            <div className="detail-item">
              <span>Configured explorer:</span>
              <a href={telemetry.explorerUrl} target="_blank" rel="noreferrer">{telemetry.explorerUrl} ↗</a>
            </div>
          )}
        </div>
      </div>

      <div className="vault-inspection-section">
        <h3>Fund a Tachi vault (opt-in)</h3>
        <p className="section-note">
          Creates a fresh disposable vault on Bitcoin signet, funds it from the public signet faucet, deposits into the
          vault and registers the ledger VTXO. Signet coins have no value. Scope is vault funding / deposit / register
          only — this does not settle a merchant payment on Tachi, which would need 5-of-7 quorum cosignatures the SDK
          does not expose. The run takes a while (signet blocks average ~10 minutes) and only progresses while the API
          process is running; a serverless deployment stalls it. Every transaction links to the Tachi Explorer below.
        </p>
        {fundError && <div className="global-error-banner" role="alert">{fundError}</div>}
        <div className="p2tr-details-box">
          <div className="detail-item">
            <span>Admin token:</span>
            <input
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              placeholder="SATSLOOM_ADMIN_TOKEN (never stored)"
              autoComplete="off"
              style={{ flex: 1 }}
            />
          </div>
          <div className="detail-item">
            <span>Fund flow:</span>
            <span>{telemetry?.fundFlow?.enabled ? "enabled — POST /api/tachi/vault/fund" : "disabled — set SATSLOOM_TACHI_FUND_ENABLED=true on the API"}</span>
          </div>
          <div className="detail-item">
            <button type="button" onClick={startFund} disabled={fundBusy || fundActive || !telemetry?.fundFlow?.enabled}>
              {fundBusy ? "Starting…" : fundActive ? "Fund run in progress…" : "Fund Tachi vault"}
            </button>
          </div>
        </div>
        {fundJob && (
          <div className="p2tr-details-box" style={{ marginTop: 12 }}>
            <div className="detail-item">
              <span>Job:</span>
              <code>{fundJob.id}</code>
            </div>
            <div className="detail-item">
              <span>Status:</span>
              <code>{fundJob.status} · {fundJob.stage}</code>
            </div>
            {fundJob.vaultAddress && (
              <div className="detail-item">
                <span>Vault P2TR:</span>
                <code>{fundJob.vaultAddress}</code>
              </div>
            )}
            {fundJob.fundingAddress && (
              <div className="detail-item">
                <span>Funding wallet:</span>
                <code>{fundJob.fundingAddress}</code>
              </div>
            )}
            {txRow("Faucet claim", fundJob.faucet, fundJob.faucet?.sats ? `· ${fundJob.faucet.sats} sats` : undefined)}
            {txRow("Vault deposit", fundJob.deposit, fundJob.deposit?.amountSats ? `· ${fundJob.deposit.amountSats} sats` : undefined)}
            {fundJob.registration && (
              <div className="detail-item">
                <span>VTXO registration:</span>
                <span>
                  <a href={fundJob.registration.explorerUrl} target="_blank" rel="noreferrer">{fundJob.registration.broadcastHash.slice(0, 16)}… ↗</a>
                  {` · VTXO ${fundJob.registration.vtxoId.slice(0, 16)}… · fee ${fundJob.registration.feeSats} sats`}
                </span>
              </div>
            )}
            {fundJob.status === "awaiting-manual-funding" && (
              <div className="detail-item">
                <span>Funding needed:</span>
                <span>
                  The faucet declined the claim. Fund <code>{fundJob.fundingAddress}</code> from a signet faucet, then continue — the run resumes from the deposit step.
                  <button type="button" onClick={continueFund} disabled={fundBusy} style={{ marginLeft: 8 }}>Continue run</button>
                </span>
              </div>
            )}
            {fundJob.error && (
              <div className="detail-item">
                <span>Error:</span>
                <code>{fundJob.error}</code>
              </div>
            )}
            {fundJob.status === "complete" && (
              <div className="detail-item">
                <span>Result:</span>
                <span>Vault funded, deposit registered. Verify every transaction on the Tachi Explorer via the links above.</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="validators-list-section">
        <h3>Validator records ({validators.length})</h3>
        {validators.length ? (
          <div className="validators-grid">
            {validators.map((validator, index) => (
              <div key={validator.id || index} className="validator-card">
                <div className="val-icon">Validator {index + 1} · {validator.online ? "reported online" : "not confirmed"}</div>
                <div className="val-pubkey"><code>{validator.id}</code></div>
                <div className="val-endpoint">{validator.endpoint ?? "No endpoint reported"}</div>
              </div>
            ))}
          </div>
        ) : <p className="section-note">No live query was run. Use the opt-in local spike if you need to inspect a configured test/regtest endpoint.</p>}
      </div>
    </div>
  );
}
