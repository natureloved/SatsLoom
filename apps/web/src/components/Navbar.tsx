import React from "react";

export type NavTab = "dashboard" | "shop" | "x402" | "telemetry" | "operations";

interface Props {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  status: any;
}

export function Navbar({ activeTab, setActiveTab, status }: Props) {
  const isDaemonLive = status?.daemon?.reachable ?? false;
  const daemonChecked = status?.daemon?.checked === true;
  const daemonLabel = !daemonChecked ? "Not queried by API" : isDaemonLive ? "Reachable" : "Unavailable";

  return (
    <header className="satsloom-header">
      <div className="header-top-row">
        <div className="brand-group">
          <div className="logo-symbol">
            <span className="loom-thread">⟁</span>
            <span className="sat-icon">₿</span>
          </div>
          <div>
            <div className="brand-title-wrap">
              <h1>SatsLoom</h1>
              <span className="brand-tag">Signet</span>
            </div>
            <p className="brand-subtitle">Live Invoices &amp; Settlements · L402</p>
          </div>
        </div>

        <div className="header-meta">
          <div className={`node-status-pill ${isDaemonLive ? "online" : "connecting"}`}>
            <span className="pulse-indicator"></span>
            <span>Tachi endpoint: {daemonLabel}</span>
          </div>
          <div
            className="degraded-badge"
            title="Settlement runs on the configured Lightning node. The lifecycle, refund, payout, and liquidity views in this console are simulation records and transfer nothing."
          >
            <span>Live Settlement · Records Simulated</span>
          </div>
        </div>
      </div>

      <nav className="header-nav-tabs">
        <button
          className={`nav-tab-btn ${activeTab === "dashboard" ? "active" : ""}`}
          onClick={() => setActiveTab("dashboard")}
        >
          ⚡ Merchant Terminal
        </button>
        <button
          className={`nav-tab-btn ${activeTab === "shop" ? "active" : ""}`}
          onClick={() => setActiveTab("shop")}
        >
          🛒 SatsShop Demo Catalog
        </button>
        <button
          className={`nav-tab-btn ${activeTab === "x402" ? "active" : ""}`}
          onClick={() => setActiveTab("x402")}
        >
          🤖 x402 AI Agent Sandbox
        </button>
        <button
          className={`nav-tab-btn ${activeTab === "telemetry" ? "active" : ""}`}
          onClick={() => setActiveTab("telemetry")}
        >
          🔬 Tachi & TAURUS Telemetry
        </button>
        <button
          className={`nav-tab-btn ${activeTab === "operations" ? "active" : ""}`}
          onClick={() => setActiveTab("operations")}
        >
          📋 Ledger & Webhooks
        </button>
      </nav>
    </header>
  );
}
