import React, { useState } from "react";
import { TachiTelemetryView } from "./TachiTelemetryView";
import { OperationsView } from "./OperationsView";
import { X402Sandbox } from "./X402Sandbox";
import { SatsShop } from "./SatsShop";
import { RouteVisualizer } from "./RouteVisualizer";
import { ThemeToggle } from "./ThemeProvider";

interface Props {
  overview?: any;
  transactions?: any[];
  refunds?: any[];
  payouts?: any[];
  liquidity?: any;
  routedSats?: number;
  status?: any;
  invoice?: any;
  routes?: any;
  settlement?: any;
  onOpenReceive: () => void;
  onOpenSend: () => void;
  onBackToHome: () => void;
  onSelectNav?: (tab: string) => void;
  onCreateInvoice?: () => void;
  onSimulatePayment?: () => void;
  onSelectRoute?: () => void;
  onSettlePreferredRoute?: () => void;
  onInvalidateAndSettle?: () => void;
  onIssueRefund?: () => void;
  onQueuePayout?: (amount: string, destination: string) => Promise<void>;
  onBuyShopProduct?: (product: any) => Promise<void>;
  vaultAddress?: string;
  busy?: boolean;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
}

export function SatsLoomDashboard({
  overview,
  transactions = [],
  refunds = [],
  payouts = [],
  liquidity,
  routedSats = 0,
  status,
  invoice,
  routes,
  settlement,
  onOpenReceive,
  onOpenSend,
  onBackToHome,
  onSelectNav,
  onCreateInvoice,
  onSimulatePayment,
  onSelectRoute,
  onSettlePreferredRoute,
  onInvalidateAndSettle,
  onIssueRefund,
  onQueuePayout,
  onBuyShopProduct,
  vaultAddress = "",
  busy = false,
  theme,
  onToggleTheme,
}: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeNavItem, setActiveNavItem] = useState("dashboard");
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [exitDrillOpen, setExitDrillOpen] = useState(false);
  const [drillStage, setDrillStage] = useState<"idle" | "running" | "complete">("idle");
  const [drillLogs, setDrillLogs] = useState<string[]>([]);

  // Route Lab simulator state (for Route Fabric tab)
  const [labAmount, setLabAmount] = useState(21000);
  const [labMode, setLabMode] = useState<"speed" | "cost" | "reliability">("speed");
  const [labExecuting, setLabExecuting] = useState(false);
  const [labStatus, setLabStatus] = useState("Illustrative route model; no payment will be sent.");
  const [labProgressActive, setLabProgressActive] = useState(false);

  // Chart data points based on period
  const chartPaths = {
    "1W": {
      area: "M38,190 C90,185 140,165 210,170 S300,140 390,145 S500,110 600,90 S650,60 680,45 L680,215 L38,215 Z",
      line: "M38,190 C90,185 140,165 210,170 S300,140 390,145 S500,110 600,90 S650,60 680,45",
      dotY: 45,
      labels: ["shape 1", "shape 2", "shape 3", "shape 4", "shape 5"],
    },
    "1M": {
      area: "M38,177 C55,170 60,154 78,158 S99,168 115,149 S137,136 155,142 S181,160 198,147 S218,111 239,121 S258,142 277,133 S298,114 316,119 S339,136 358,121 S378,103 397,110 S417,124 437,102 S457,77 477,88 S495,105 516,91 S534,68 555,80 S575,93 594,71 S615,53 634,63 S653,49 680,40 L680,215 L38,215 Z",
      line: "M38,177 C55,170 60,154 78,158 S99,168 115,149 S137,136 155,142 S181,160 198,147 S218,111 239,121 S258,142 277,133 S298,114 316,119 S339,136 358,121 S378,103 397,110 S417,124 437,102 S457,77 477,88 S495,105 516,91 S534,68 555,80 S575,93 594,71 S615,53 634,63 S653,49 680,40",
      dotY: 40,
      labels: ["shape 1", "shape 2", "shape 3", "shape 4", "shape 5"],
    },
    "3M": {
      area: "M38,198 C100,190 180,180 260,160 S380,135 480,115 S580,75 680,35 L680,215 L38,215 Z",
      line: "M38,198 C100,190 180,180 260,160 S380,135 480,115 S580,75 680,35",
      dotY: 35,
      labels: ["shape 1", "shape 2", "shape 3", "shape 4", "shape 5"],
    },
    "1Y": {
      area: "M38,205 C120,200 220,180 320,150 S450,110 560,70 S640,45 680,25 L680,215 L38,215 Z",
      line: "M38,205 C120,200 220,180 320,150 S450,110 560,70 S640,45 680,25",
      dotY: 25,
      labels: ["shape 1", "shape 2", "shape 3", "shape 4", "shape 5"],
    },
  };

  const currentChart = chartPaths["1M"];

  // This is a demo ledger total, not a wallet balance or verified Bitcoin amount.
  const totalSats = Number(overview?.settledSats ?? routedSats ?? 0);


  const handleNav = (item: string) => {
    setActiveNavItem(item);
    setSidebarOpen(false);
    if (onSelectNav) onSelectNav(item);
  };

  const copyVaultAddress = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!vaultAddress) return;
    navigator.clipboard.writeText(vaultAddress);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2400);
  };

  // This is a scripted UI walkthrough only; it does not call a wallet, signer, node, or Tachi.
  const runExitDrill = async () => {
    setDrillStage("running");
    setDrillLogs([
      "Demo walkthrough only — no wallet or Bitcoin node is connected.",
      "No vault or UTXO is queried; the displayed CSV value is illustrative.",
      "No private key is loaded, no exit transaction is signed, and nothing is broadcast.",
      "Walkthrough complete — this is not a recovery test or proof of funds.",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    setDrillStage("complete");
  };

  // Navigation headers configuration
  const viewHeaders: Record<string, { eyebrow: string; title: string; subtitle: string }> = {
    dashboard: {
      eyebrow: "DEGRADED DEMO · NO BITCOIN SETTLEMENT",
      title: "Route scoring & invoice simulator",
      subtitle: "Inspect simulated invoice state and sample routes; no customer funds are received or moved.",
    },
    portfolio: {
      eyebrow: "SAMPLE ROUTES · NO MULTI-PATH EXECUTION",
      title: "Route scoring model",
      subtitle: "Compare illustrative route candidates. The API does not split payments or connect to live liquidity.",
    },
    telemetry: {
      eyebrow: "OPTIONAL SDK TELEMETRY · ADAPTER SPIKE",
      title: "Tachi connectivity information",
      subtitle: "The public API does not query the Tachi endpoint; inspect the optional local integration spike separately.",
    },
    wallets: {
      eyebrow: "VAULT UI PLACEHOLDER · NO ACTIVE VAULT",
      title: "TAURUS integration research",
      subtitle: "The UI does not create a vault, load keys, accept deposits, or build recovery transactions.",
    },
    transactions: {
      eyebrow: "SIMULATION RECORDS · NO FUNDS MOVED",
      title: "Demo events & webhook logs",
      subtitle: "Inspect state changes and allow-listed webhook attempts from this process; records are not Bitcoin transactions.",
    },
    automations: {
      eyebrow: "HTTP 402 PAYMENT REQUIRED · AUTONOMOUS AGENTS",
      title: "x402 challenge and receipt demo",
      subtitle: "Inspect a simulated HTTP 402 flow with a signed application receipt; no sats are charged or verified.",
    },
    goals: {
      eyebrow: "SAMPLE CATALOG · DEMO CHECKOUT",
      title: "SatsShop checkout simulator",
      subtitle: "Sample product data and simulated invoice confirmation; no order is paid or fulfilled.",
    },
  };

  const currentHeader = viewHeaders[activeNavItem] || viewHeaders.dashboard;

  return (
    <div className="dash-root">
      {/* Mobile sidebar backdrop overlay */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Unilateral Exit Drill Modal */}
      {exitDrillOpen && (
        <div className="modal-backdrop" onClick={() => setExitDrillOpen(false)}>
          <div className="modal-content exit-drill-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="drill-brand">
                <span className="shield-icon">🛡️</span>
                <div>
                  <h3>Scripted Exit Walkthrough</h3>
                  <p className="checkout-subtitle">Concept only · no recovery guarantee</p>
                </div>
              </div>
              <button className="close-btn" onClick={() => setExitDrillOpen(false)}>✕</button>
            </div>

            <div className="drill-body">
              <p className="drill-desc">
                This scripted walkthrough does not test custody, a vault, a key, or Bitcoin recovery. No funds are connected, and the app cannot verify or guarantee any unilateral exit.
              </p>

              <div className="drill-status-box">
                <div className="drill-status-header">
                  <span>Drill Status:</span>
                  <strong className={`status-text ${drillStage}`}>{drillStage.toUpperCase()}</strong>
                </div>
                <div className="drill-console">
                  {drillLogs.length === 0 ? (
                    <span className="faint-log">Click “Start Demo Drill” for the scripted walkthrough; no transaction will be made.</span>
                  ) : (
                    drillLogs.map((log, i) => <div key={i} className="drill-log-line">{log}</div>)
                  )}
                </div>
              </div>

              <div className="drill-actions">
                <button
                  className="btn-primary full-width"
                  onClick={runExitDrill}
                  disabled={drillStage === "running"}
                >
                  {drillStage === "complete" ? "↺ Replay Demo Drill" : "▶ Start Demo Drill"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="layout">
        {/* ================= SIDEBAR ================= */}
        <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} id="sidebar">
          <div className="sidebar-header-row">
            <div
              className="brand"
              onClick={() => {
                setSidebarOpen(false);
                onBackToHome();
              }}
              title="Return to SatsLoom Homepage"
            >
              <span className="brand-mark">₿</span>
              <span>SATS<b>LOOM</b></span>
            </div>
            <button
              className="sidebar-close-btn"
              aria-label="Close sidebar"
              onClick={() => setSidebarOpen(false)}
            >
              ✕
            </button>
          </div>

          {/* Active Vault & Router Workspace */}
          <div
            className="workspace"
            title={vaultAddress ? "Click to copy the configured vault address" : "No vault address is configured"}
            onClick={copyVaultAddress}
          >
            <span className="workspace-text">
              <span className="workspace-label">DEMO SERVICE</span>
              <span className="workspace-name">SatsLoom · no wallet connected</span>
              <span className="workspace-subaddress">
                <code>{vaultAddress || "No deposit address configured"}</code>
                {vaultAddress && <span className="copy-badge">{copiedAddr ? "✓ COPIED" : "COPY"}</span>}
              </span>
            </span>
          </div>

          {/* Navigation Links */}
          <nav>
            <div className="nav-group">
              <span className="nav-title">Demo &amp; Routing</span>
              <button
                className={`nav-item ${activeNavItem === "dashboard" ? "active" : ""}`}
                onClick={() => handleNav("dashboard")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                Node Dashboard
              </button>
              <button
                className={`nav-item ${activeNavItem === "portfolio" ? "active" : ""}`}
                onClick={() => handleNav("portfolio")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M3 17l5-5 4 4 8-9" />
                  <path d="M14 7h6v6" />
                </svg>
                Route Fabric
              </button>
              <button
                className={`nav-item ${activeNavItem === "telemetry" ? "active" : ""}`}
                onClick={() => handleNav("telemetry")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M4 19V5" />
                  <path d="M4 18h16" />
                  <path d="M8 15v-4" />
                  <path d="M12 15V8" />
                  <path d="M16 15v-7" />
                </svg>
                Tachi Telemetry
              </button>
            </div>

            <div className="nav-group">
              <span className="nav-title">Demo Operations &amp; Concepts</span>
              <button
                className={`nav-item ${activeNavItem === "wallets" ? "active" : ""}`}
                onClick={() => handleNav("wallets")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v10a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6" />
                  <path d="M16 14h.01" />
                </svg>
                TAURUS Vaults
              </button>
              <button
                className={`nav-item ${activeNavItem === "transactions" ? "active" : ""}`}
                onClick={() => handleNav("transactions")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M7 10l-3 3 3 3" />
                  <path d="M4 13h12a4 4 0 0 0 4-4V6" />
                  <path d="m17 14 3 3-3 3" />
                  <path d="M20 17H8a4 4 0 0 1-4-4V9" />
                </svg>
                Demo Events
                <span className="nav-badge">
                  {transactions.length}
                </span>
              </button>
              <button
                className="nav-item"
                onClick={() => {
                  setSidebarOpen(false);
                  onOpenReceive();
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M12 3v18" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="m7 16 5 5 5-5" />
                </svg>
                Receive &amp; Invoice
              </button>
            </div>

            <div className="nav-group">
              <span className="nav-title">Protocols &amp; Apps</span>
              <button
                className={`nav-item ${activeNavItem === "automations" ? "active" : ""}`}
                onClick={() => handleNav("automations")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M12 8v4l3 3" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
                x402 AI Gateway
              </button>
              <button
                className={`nav-item ${activeNavItem === "goals" ? "active" : ""}`}
                onClick={() => handleNav("goals")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M4 20V10" />
                  <path d="M10 20V4" />
                  <path d="M16 20v-7" />
                  <path d="M22 20H2" />
                </svg>
                SatsShop Storefront
              </button>
            </div>
          </nav>

          <div className="sidebar-bottom">
            <div className="help-card">
              <strong>Demo limitations</strong>
              <p>Demo only: simulated payment state; no live settlement or wallet.</p>
              <button onClick={() => setExitDrillOpen(true)}>
                Open scripted walkthrough →
              </button>
            </div>
            <button
              className="nav-item back-home-btn"
              onClick={() => {
                setSidebarOpen(false);
                onBackToHome();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              ← Back to Homepage
            </button>
            <div className="profile">
              <div className="avatar">SL</div>
              <div className="profile-copy">
                <strong>SatsLoom Operator</strong>
                <span>API demo · no wallet connected</span>
              </div>
            </div>
          </div>
        </aside>

        {/* ================= MAIN CONTENT ================= */}
        <main className="content">
          {/* Mobile Header Bar */}
          <div className="mobile-head">
            <div className="brand" onClick={onBackToHome}>
              <span className="brand-mark">₿</span>
              <span>SATS<b>LOOM</b></span>
            </div>
            <button
              className="icon-button menu-toggle"
              id="menuToggle"
              aria-label="Open menu"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          </div>

          {/* Top Bar with Breadcrumbs & Action Controls */}
          <header className="topbar">
            <div>
              <div className="eyebrow">{currentHeader.eyebrow}</div>
              <h1>{currentHeader.title}</h1>
              <p className="topbar-subtitle">{currentHeader.subtitle}</p>
            </div>
            <div className="top-actions">
              <button
                className="icon-button node-status-btn"
                title="The public API does not query Tachi; settlement is simulated"
                onClick={() => handleNav("telemetry")}
              >
                <span className="pulse-dot"></span>
                <span>{status?.daemon?.reachable ? "ENDPOINT REACHABLE" : "DEMO MODE"}</span>
              </button>

              <button
                className="secondary-btn"
                onClick={() => setExitDrillOpen(true)}
                title="Open a scripted concept walkthrough; no recovery test is performed"
              >
                🛡️ Exit Drill
              </button>

              <button
                className="primary-btn"
                onClick={onOpenReceive}
                title="Create a simulated invoice; no payment QR is issued"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span>+ Issue Invoice</span>
              </button>

              {theme && onToggleTheme && (
                <ThemeToggle theme={theme} onToggle={onToggleTheme} className="topbar-theme-toggle" />
              )}
            </div>
          </header>

          {/* ================= VIEW SWITCHER ================= */}

          {/* TAB 1: EXECUTIVE NODE DASHBOARD */}
          {activeNavItem === "dashboard" && (
            <div className="dashboard-content-view">
              {/* Demo ledger summary (not an on-chain balance) */}
              <div className="balance-card">
                <div>
                  <div className="balance-label">
                    <span className="dot"></span> SIMULATED SETTLEMENT TOTAL · NOT A WALLET BALANCE
                  </div>
                  <div className="balance-value" title="Simulation-only application state; not a wallet balance">
                    {totalSats.toLocaleString()} <span className="currency-unit">sats</span>
                  </div>
                  <div className="balance-usd">
                    Simulated ledger amount · no Bitcoin balance is connected
                  </div>
                </div>
                <div className="balance-actions">
                  <button className="secondary-btn" onClick={onOpenReceive}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 3v14" />
                      <path d="m7 8 5-5 5 5" />
                      <path d="M5 21h14" />
                    </svg>
                    Open Demo Invoice
                  </button>
                  <button className="secondary-btn" onClick={() => handleNav("transactions")}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 21V7" />
                      <path d="m17 12-5-5-5 5" />
                      <path d="M5 3h14" />
                    </svg>
                    Demo Operations
                  </button>
                  <button className="secondary-btn" onClick={() => setExitDrillOpen(true)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    Exit Drill
                  </button>
                </div>
              </div>

              {/* Stat Grid: Synchronized with Protocol Stats */}
              <div className="stat-grid">
                <article className="stat-card">
                  <div className="stat-top">
                    <span>Simulated settlement total</span>
                    <div className="stat-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                    </div>
                  </div>
                  <div className="stat-value">
                    {totalSats.toLocaleString()}{" "}
                    <span style={{ fontSize: "13px", color: "var(--faint)" }}>sats</span>
                  </div>
                  <div className="stat-change">
                    Demo records only <span>· no on-chain verification</span>
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span>Route model</span>
                    <div className="stat-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </div>
                  </div>
                  <div className="stat-value">
                    3 <span style={{ fontSize: "13px", color: "var(--faint)" }}>sample routes</span>
                  </div>
                  <div className="stat-change">
                    No live quote source <span>· no BOLT12 offer</span>
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span>Payment execution</span>
                    <div className="stat-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="12" cy="12" r="8" />
                        <path d="m12 7 3 5-3 5" />
                      </svg>
                    </div>
                  </div>
                  <div className="stat-value">SIM</div>
                  <div className="stat-change">
                    No live settlement adapter <span>· no liquidity feed</span>
                  </div>
                </article>
              </div>

              {/* Main Grid: Chart & Allocation */}
              <div className="main-grid">
                <article className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Illustrative route graphic</h2>
                      <p className="panel-subtitle">Decorative static shape · no historical or throughput data</p>
                    </div>
                  </div>

                  <div className="chart-wrap">
                    <svg className="chart-svg" viewBox="0 0 700 250" preserveAspectRatio="none" role="img" aria-label="Illustrative demo chart, not live throughput data">
                      <defs>
                        <linearGradient id="dashAreaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#F7931A" stopOpacity="0.25" />
                          <stop offset="100%" stopColor="#F7931A" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <line className="chart-gridline" x1="38" x2="680" y1="34" y2="34" />
                      <line className="chart-gridline" x1="38" x2="680" y1="86" y2="86" />
                      <line className="chart-gridline" x1="38" x2="680" y1="138" y2="138" />
                      <line className="chart-gridline" x1="38" x2="680" y1="190" y2="190" />
                      <text className="chart-label" x="2" y="37">high</text>
                      <text className="chart-label" x="2" y="89">—</text>
                      <text className="chart-label" x="2" y="141">—</text>
                      <text className="chart-label" x="2" y="193">low</text>
                      <path className="chart-area" fill="url(#dashAreaGrad)" d={currentChart.area} />
                      <path className="chart-line" d={currentChart.line} />
                      <circle className="chart-dot" cx="680" cy={currentChart.dotY} r="5" />
                      {currentChart.labels.map((lbl, i) => (
                        <text
                          key={lbl}
                          className="chart-label"
                          x={38 + (i * (640 / (currentChart.labels.length - 1)))}
                          y="232"
                        >
                          {lbl}
                        </text>
                      ))}
                    </svg>
                  </div>
                </article>

                {/* Allocation Donut: Protocol Collateral */}
                <article className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Integration status</h2>
                      <p className="panel-subtitle">No customer balance or collateral is connected</p>
                    </div>
                  </div>

                  <div className="allocation">
                    <div className="donut-row">
                      <div className="donut">
                        <div className="donut-center">
                          <strong>DEMO</strong>
                          <span>No balances</span>
                        </div>
                      </div>
                      <div className="asset-list">
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>TAURUS vault instance
                          </span>
                          <span className="asset-value">not connected</span>
                        </div>
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>Lightning liquidity
                          </span>
                          <span className="asset-value">not connected</span>
                        </div>
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>VTXO batch state
                          </span>
                          <span className="asset-value">not connected</span>
                        </div>
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>Exit reserve
                          </span>
                          <span className="asset-value">not connected</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              </div>

              {/* Bottom Grid: Recent Settlements & Protocol Security */}
              <div className="bottom-grid">
                <article className="panel activity">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Demo events</h2>
                      <p className="panel-subtitle">Current API process records · no verified Bitcoin transactions</p>
                    </div>
                    <button
                      className="view-link"
                      style={{ padding: 0, border: 0, background: "none" }}
                      onClick={() => handleNav("transactions")}
                    >
                      View all →
                    </button>
                  </div>

                  <div className="activity-list">
                    {invoice && (
                      <div className="activity-row">
                        <div className="activity-icon">↻</div>
                        <div>
                          <div className="activity-name">Demo invoice: {invoice.memo || invoice.id.slice(0, 12)}</div>
                          <div className="activity-date">Simulated state · {invoice.status.toUpperCase()}</div>
                        </div>
                        <div className="activity-amount in">{Number(invoice.amountSats).toLocaleString()} <small>sats</small></div>
                      </div>
                    )}
                    {transactions.map((transaction: any) => (
                      <div className="activity-row" key={transaction.id}>
                        <div className="activity-icon">↻</div>
                        <div>
                          <div className="activity-name">Simulated route: {transaction.routeId}</div>
                          <div className="activity-date">{transaction.status} · {transaction.txid ?? transaction.id} · not a Bitcoin txid</div>
                        </div>
                        <div className="activity-amount">DEMO</div>
                      </div>
                    ))}
                    {!invoice && transactions.length === 0 && <p className="activity-date">No demo events in this API process yet.</p>}
                  </div>
                  <button
                    className="view-link"
                    style={{ background: "none", borderLeft: "none", borderRight: "none", borderBottom: "none", width: "100%", textAlign: "left" }}
                    onClick={() => handleNav("transactions")}
                  >
                    See all settlement events →
                  </button>
                </article>

                {/* Fabric Runways & Protocol Security */}
                <article className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Modelled capacities</h2>
                      <p className="panel-subtitle">Hard-coded demo values · bars are decorative, not liquidity usage</p>
                    </div>
                  </div>
                  <div className="goals-content">
                    <div>
                      <div className="goal-title">
                        Sample VTXO capacity <span>{Number(liquidity?.vtxoSats ?? 0).toLocaleString()} sats</span>
                      </div>
                      <div className="progress">
                        <span style={{ width: "20%" }}></span>
                      </div>
                      <div className="goal-caption">Illustrative route candidate · no VTXO batch created</div>
                    </div>
                    <div>
                      <div className="goal-title">
                        Sample provider capacity <span>{Number(liquidity?.providerSats ?? 0).toLocaleString()} sats</span>
                      </div>
                      <div className="progress">
                        <span style={{ width: "35%" }}></span>
                      </div>
                      <div className="goal-caption">Sample only · no provider is connected</div>
                    </div>
                  </div>
                  <div className="security">
                    <div className="security-row">
                      <div className="security-check">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path d="m5 12 4 4L19 6" />
                        </svg>
                      </div>
                      <div>
                        <strong>No active vault or exit transaction</strong>
                        <span>This demo has no wallet keys, deposits, or Bitcoin broadcast capability.</span>
                      </div>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          )}

          {/* TAB 2: SINGLE-ROUTE SCORING MODEL */}
          {activeNavItem === "portfolio" && (
            <div className="dashboard-content-view">
              <div className="fabric-overview-card">
                <div className="fabric-header">
                  <div>
                    <h3>Sample Route Scoring</h3>
                    <p className="subtext">
                      Three illustrative route candidates. This implementation selects one route; it does not split or atomically execute multi-path payments.
                    </p>
                  </div>
                  <div className="fabric-stats-badge">
                    <span>{routes?.routes?.length ?? 0} sample candidates</span>
                    <strong>No live liquidity · no multi-path split</strong>
                  </div>
                </div>

                {routes && (
                  <RouteVisualizer
                    routes={routes.routes}
                    selectedRouteId={settlement?.decision?.selectedRouteId ?? invoice?.decision?.selectedRouteId}
                    onSelect={onSelectRoute ?? (() => {})}
                    onInvalidateAndSettle={onInvalidateAndSettle ?? (() => {})}
                    onSettle={onSettlePreferredRoute ?? (() => {})}
                    disabled={busy || invoice?.status !== "confirmed"}
                    settled={settlement?.lifecycle === "SETTLED"}
                    fallbackHistory={settlement?.fallbackHistory}
                  />
                )}
              </div>

              {/* Embedded Route Tuning Matrix */}
              <div className="lab-card" style={{ marginTop: "20px" }}>
                <div className="card-header-row">
                  <h4>Sample Route Scoring Simulator</h4>
                  <span className="mono-badge">Illustrative scoring model</span>
                </div>

                <div className="lab-controls-grid">
                  <div className="lab-input-group">
                    <label>
                      <span>Sample amount: <strong>{labAmount.toLocaleString()} sats</strong></span>
                      <input
                        type="range"
                        min="1000"
                        max="250000"
                        step="1000"
                        value={labAmount}
                        onChange={(e) => setLabAmount(Number(e.target.value))}
                      />
                    </label>
                  </div>

                  <div className="lab-priority-group">
                    <span>Scoring preference:</span>
                    <div className="seg-buttons">
                      {(["speed", "cost", "reliability"] as const).map((m) => (
                        <button
                          key={m}
                          className={`seg-btn ${labMode === m ? "active" : ""}`}
                          onClick={() => setLabMode(m)}
                        >
                          {m.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="lab-action-group">
                    <button
                      className="btn-primary"
                      disabled={labExecuting}
                      onClick={() => {
                        setLabExecuting(true);
                        setLabStatus("Scoring illustrative candidate values… no payment will be sent.");
                        setTimeout(() => {
                          const modelRoutes = routes?.routes ?? [];
                          const candidates = modelRoutes.filter((route: any) => route.available && Number(route.capacitySats) >= labAmount);
                          const times = modelRoutes.map((route: any) => Number(route.estimatedSettlementSeconds));
                          const fees = modelRoutes.map((route: any) => Number(route.feeSats));
                          const minTime = Math.min(...times);
                          const maxTime = Math.max(...times);
                          const minFee = Math.min(...fees);
                          const maxFee = Math.max(...fees);
                          const weights = labMode === "speed" ? [0.5, 0.25, 0.25] : labMode === "cost" ? [0.25, 0.5, 0.25] : [0.25, 0.25, 0.5];
                          const candidate = candidates.map((route: any) => {
                            const speed = maxTime === minTime ? 1 : 1 - (Number(route.estimatedSettlementSeconds) - minTime) / (maxTime - minTime);
                            const cost = maxFee === minFee ? 1 : 1 - (Number(route.feeSats) - minFee) / (maxFee - minFee);
                            const reliability = route.exitRisk === "none" ? 1 : route.exitRisk === "low" ? 0.75 : route.exitRisk === "medium" ? 0.5 : 0.25;
                            return { route, score: weights[0] * speed + weights[1] * cost + weights[2] * reliability };
                          }).sort((a: any, b: any) => b.score - a.score)[0]?.route;
                          setLabExecuting(false);
                          if (!candidate) {
                            setLabStatus("No candidate fits this sample amount. No split or settlement is attempted.");
                            return;
                          }
                          setLabStatus(`SIMULATION · ${labMode.toUpperCase()} preference would select ${candidate.id} (${candidate.estimatedSettlementSeconds}s sample estimate). No payment sent.`);
                        }, 600);
                      }}
                    >
                      {labExecuting ? "Scoring…" : "⚡ Score Sample Route"}
                    </button>
                  </div>
                </div>

                <div className="lab-status-banner">
                  <span className="status-indicator"></span>
                  <span>{labStatus}</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: TACHI TELEMETRY & SUBSTRATE */}
          {activeNavItem === "telemetry" && (
            <div className="dashboard-content-view">
              <TachiTelemetryView />
            </div>
          )}

          {/* TAB 4: TAURUS INTEGRATION CONCEPTS */}
          {activeNavItem === "wallets" && (
            <div className="dashboard-content-view">
              <div className="vault-custody-card">
                <div className="card-header-row">
                  <div>
                    <h3>TAURUS Integration Concept</h3>
                    <p className="subtext">
                      No merchant vault, deposit, private key, or recovery transaction is configured in this demo.
                    </p>
                  </div>
                  <div className="custody-tag">
                    <span>NO ACTIVE VAULT</span>
                  </div>
                </div>

                <div className="vault-address-display">
                  <div className="addr-meta">
                    <span>Vault address:</span>
                    <code>{vaultAddress || "Not configured — do not send funds"}</code>
                  </div>
                  {vaultAddress && <button className="copy-btn" onClick={copyVaultAddress}>{copiedAddr ? "✓ Copied" : "Copy Address"}</button>}
                </div>

                <div className="vault-leaves-grid">
                  <div className="leaf-card keypath">
                    <div className="leaf-top">
                      <span className="leaf-pill">KEY-PATH CONCEPT</span>
                      <span className="leaf-speed">illustrative only</span>
                    </div>
                    <h4>Key-path concept</h4>
                    <p>This card is an architecture sketch. The demo has no connected vault, merchant key, validator threshold, or VTXO transfer.</p>
                    <div className="script-box">
                      <code>Concept only · no vault script or key configured</code>
                    </div>
                  </div>

                  <div className="leaf-card timelock">
                    <div className="leaf-top">
                      <span className="leaf-pill warning">TIMELOCK CONCEPT</span>
                      <span className="leaf-speed">Parameter not configured</span>
                    </div>
                    <h4>Exit-path concept only</h4>
                    <p>No active vault or exit is available in this app. Do not use this card as evidence of a recovery path or funds safety.</p>
                    <div className="script-box">
                      <code>Concept only · no exit script or timelock configured</code>
                    </div>
                  </div>
                </div>

                <div className="vault-drill-row">
                  <div>
                    <strong>Demo walkthrough (not an exit test):</strong>
                    <p className="faint-desc">Displays scripted text only; it does not sign, validate, or broadcast a Bitcoin transaction.</p>
                  </div>
                  <button className="btn-secondary" onClick={() => setExitDrillOpen(true)}>
                    ▶ Run Demo Walkthrough
                  </button>
                </div>
              </div>

              {/* Payout Sweep to Cold Storage */}
              <div className="payout-panel" style={{ marginTop: "20px" }}>
                <h4>Simulate a payout record</h4>
                <p className="subtext">This action only adds a demo record and reserves sample capacity. It will not send Bitcoin or contact a wallet.</p>
                <form
                  className="payout-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.target as any;
                    const amt = form.payoutAmt.value;
                    const dest = form.payoutDest.value;
                    if (onQueuePayout) {
                      await onQueuePayout(amt, dest);
                      alert(`Demo payout record created for ${amt} sats. No Bitcoin was sent to ${dest}.`);
                    }
                  }}
                >
                  <div className="payout-inputs">
                    <label>
                      <span>Amount (Sats)</span>
                      <input name="payoutAmt" type="number" defaultValue="50000" min="1000" required />
                    </label>
                    <label>
                      <span>Destination label (not validated)</span>
                      <input name="payoutDest" type="text" placeholder="demo destination label (not validated)" required />
                    </label>
                    <button type="submit" className="btn-primary" disabled={busy}>
                      {busy ? "Recording..." : "Create Simulated Payout Record"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* TAB 5: SETTLEMENT FEED & OPERATIONS */}
          {activeNavItem === "transactions" && (
            <div className="dashboard-content-view">
              <OperationsView
                transactions={transactions}
                refunds={refunds}
                payouts={payouts}
                liquidity={liquidity}
                onQueuePayout={onQueuePayout ?? (async () => {})}
                busy={busy}
              />
            </div>
          )}

          {/* TAB 6: x402 AI AGENT GATEWAY */}
          {activeNavItem === "automations" && (
            <div className="dashboard-content-view">
              <X402Sandbox />
            </div>
          )}

          {/* TAB 7: SATSSHOP STOREFRONT */}
          {activeNavItem === "goals" && (
            <div className="dashboard-content-view">
              <SatsShop
                onBuyProduct={onBuyShopProduct ?? (async (product) => {
                  alert(`Created demo order for ${product.name} (${product.priceSats} sats)`);
                  onOpenReceive();
                })}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
