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
};

export function TachiTelemetryView() {
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tachi/telemetry")
      .then(async (response) => {
        const body = await response.json();
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

  if (loading) return <div className="loading-state">Loading Tachi integration notes…</div>;

  const reachable = telemetry?.daemon?.reachable === true;
  const checked = telemetry?.daemon?.checked === true;
  const endpointColor = checked && reachable ? "#16845b" : "#a05a00";
  const validators = telemetry?.validators ?? [];

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
          <span className="card-kicker">Payment execution</span>
          <h3>Simulation only</h3>
          <p>Invoice confirmation, route settlement, refunds, payouts, and x402 agent-pay do not move sats.</p>
        </div>
      </div>

      <div className="vault-inspection-section">
        <h3>Integration boundary</h3>
        <p className="section-note">The repository includes an optional Tachi adapter and an opt-in test/regtest spike. The public API does not contact the daemon; its settlement endpoints only return simulated state and never call vault, deposit, transfer, or broadcast methods.</p>
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
            <span>Payment settlement:</span>
            <code>not integrated · simulation=true</code>
          </div>
          {telemetry?.explorerUrl && (
            <div className="detail-item">
              <span>Configured explorer:</span>
              <a href={telemetry.explorerUrl} target="_blank" rel="noreferrer">{telemetry.explorerUrl} ↗</a>
            </div>
          )}
        </div>
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
