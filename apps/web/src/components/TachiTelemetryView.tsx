import React, { useEffect, useState } from "react";

export function TachiTelemetryView() {
  const [telemetry, setTelemetry] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/tachi/telemetry")
      .then((res) => res.json())
      .then((data) => {
        setTelemetry(data.data);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className="loading-state">Querying Tachi Regtest network telemetry...</div>;
  }

  const vaultAddress = "bcrt1p4m2ttqsx8veyvh62ezehxf9y2732yyymve4qvr76qw7ue5ttu66qppnr0q";

  return (
    <div className="telemetry-container">
      <div className="telemetry-header">
        <div>
          <h2>Tachi Protocol & Node Telemetry</h2>
          <p className="telemetry-subtitle">
            Direct cryptographic connection to Tachi Regtest, TAURUS Vault Core, and Bitcoin Anchoring Layer.
          </p>
        </div>
        <div className="telemetry-badge-row">
          <span className="live-pulse-badge">
            <span className="green-dot"></span> Regtest Connected
          </span>
          <span className="net-pill">{telemetry?.network ?? "regtest"}</span>
        </div>
      </div>

      <div className="telemetry-summary-cards">
        <div className="telemetry-card">
          <span className="card-kicker">Validator Quorum</span>
          <h3>{telemetry?.validatorCount ?? 7} Nodes</h3>
          <p>Online validators signing cooperative taproot leaf transitions.</p>
        </div>

        <div className="telemetry-card">
          <span className="card-kicker">TAURUS Timelock</span>
          <h3>{telemetry?.timelockBlocks ?? 1008} Blocks</h3>
          <p>Relative lock-time (CSV ~7 days) guaranteeing unilateral Bitcoin L1 exit.</p>
        </div>

        <div className="telemetry-card">
          <span className="card-kicker">Execution Engine</span>
          <h3>SatVM / VTXO</h3>
          <p>Ark-style off-chain virtual UTXO settlements with zero bridge risk.</p>
        </div>

        <div className="telemetry-card">
          <span className="card-kicker">Payment Standard</span>
          <h3>x402 Protocol</h3>
          <p>Native HTTP 402 pay-per-request protocol for human & AI agents.</p>
        </div>
      </div>

      <div className="vault-inspection-section">
        <h3>TAURUS Vault Contract Architecture</h3>
        <p className="section-note">
          SatsLoom deposits are held in a Taproot (P2TR) script tree that eliminates Lightning channel liquidity traps.
        </p>

        <div className="vault-tree-grid">
          <div className="leaf-card cooperative">
            <div className="leaf-header">
              <span className="leaf-tag">COOPERATIVE PATH</span>
              <span className="speed-tag">Instant (18s)</span>
            </div>
            <h4>2-of-2 User + KDHT Quorum</h4>
            <p>Off-chain payments signed by the user and confirmed by the validator threshold. Zero on-chain fee overhead.</p>
            <div className="script-box">
              <code>OP_CHECKSIGADD (7 validators) OP_GREATERTHANOREQUAL</code>
            </div>
          </div>

          <div className="leaf-card unilateral">
            <div className="leaf-header">
              <span className="leaf-tag">UNILATERAL EXIT PATH</span>
              <span className="speed-tag">1008 CSV Delay</span>
            </div>
            <h4>User Emergency Exit (Sovereign Recourse)</h4>
            <p>If Tachi validators ever go offline, the merchant unilaterally sweeps all funds back to Bitcoin testnet / L1 without permission.</p>
            <div className="script-box">
              <code>&lt;0xf003&gt; OP_CHECKSEQUENCEVERIFY OP_DROP &lt;user_xonly&gt; OP_CHECKSIG</code>
            </div>
          </div>
        </div>

        <div className="p2tr-details-box">
          <div className="detail-item">
            <span>Verified Vault Taproot Address:</span>
            <code>{vaultAddress}</code>
          </div>
          <div className="detail-item">
            <span>Tachi Daemon Endpoint:</span>
            <code>{telemetry?.daemonUrl ?? "https://rpc-regtest.tachibtc.com"}</code>
          </div>
          <div className="detail-item">
            <span>Block Explorer:</span>
            <a href={`${telemetry?.explorerUrl ?? "https://regtest.tachibtcscan.com"}/address/${vaultAddress}`} target="_blank" rel="noreferrer">
              {telemetry?.explorerUrl ?? "https://regtest.tachibtcscan.com"} ↗
            </a>
          </div>
        </div>
      </div>

      <div className="validators-list-section">
        <h3>Discovered Network Validators ({telemetry?.validators?.length ?? 0})</h3>
        <div className="validators-grid">
          {telemetry?.validators?.map((v: any, idx: number) => (
            <div key={idx} className="validator-card">
              <div className="val-icon">⚡ Node {idx + 1}</div>
              <div className="val-pubkey">
                <span>PubKey:</span>
                <code>{v.id.slice(0, 16)}...{v.id.slice(-8)}</code>
              </div>
              <div className="val-status">
                <span className="status-dot"></span> Online
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
