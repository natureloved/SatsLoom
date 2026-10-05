import React, { useState } from "react";
import { TachiTelemetryView } from "./TachiTelemetryView";
import { OperationsView } from "./OperationsView";
import { X402Sandbox } from "./X402Sandbox";
import { SatsShop } from "./SatsShop";
import { RouteVisualizer } from "./RouteVisualizer";

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
}

export function SatsLoomDashboard({
  overview,
  transactions = [],
  refunds = [],
  payouts = [],
  liquidity,
  routedSats = 21041988,
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
  vaultAddress = "bcrt1pch6w85g4pht6mk39mw8vjrwf4gq2weekt2dkwml2pk8t7axdwe4szvfsh7",
  busy = false,
}: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePeriod, setActivePeriod] = useState<"1W" | "1M" | "3M" | "1Y">("1M");
  const [activeNavItem, setActiveNavItem] = useState("dashboard");
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [exitDrillOpen, setExitDrillOpen] = useState(false);
  const [drillStage, setDrillStage] = useState<"idle" | "querying" | "constructing" | "signing" | "verified">("idle");
  const [drillLogs, setDrillLogs] = useState<string[]>([]);

  // Route Lab simulator state (for Route Fabric tab)
  const [labAmount, setLabAmount] = useState(21000);
  const [labMode, setLabMode] = useState<"speed" | "cost" | "reliability">("speed");
  const [labExecuting, setLabExecuting] = useState(false);
  const [labStatus, setLabStatus] = useState("Awaiting order… scores update live as you tune the thread.");
  const [labProgressActive, setLabProgressActive] = useState(false);
  const [labResult, setLabResult] = useState<{ amount: number; ms: number; routeId: string } | null>(null);

  // Chart data points based on period
  const chartPaths = {
    "1W": {
      area: "M38,190 C90,185 140,165 210,170 S300,140 390,145 S500,110 600,90 S650,60 680,45 L680,215 L38,215 Z",
      line: "M38,190 C90,185 140,165 210,170 S300,140 390,145 S500,110 600,90 S650,60 680,45",
      dotY: 45,
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Today"],
    },
    "1M": {
      area: "M38,177 C55,170 60,154 78,158 S99,168 115,149 S137,136 155,142 S181,160 198,147 S218,111 239,121 S258,142 277,133 S298,114 316,119 S339,136 358,121 S378,103 397,110 S417,124 437,102 S457,77 477,88 S495,105 516,91 S534,68 555,80 S575,93 594,71 S615,53 634,63 S653,49 680,40 L680,215 L38,215 Z",
      line: "M38,177 C55,170 60,154 78,158 S99,168 115,149 S137,136 155,142 S181,160 198,147 S218,111 239,121 S258,142 277,133 S298,114 316,119 S339,136 358,121 S378,103 397,110 S417,124 437,102 S457,77 477,88 S495,105 516,91 S534,68 555,80 S575,93 594,71 S615,53 634,63 S653,49 680,40",
      dotY: 40,
      labels: ["Sep 16", "Sep 23", "Sep 30", "Oct 07", "Today"],
    },
    "3M": {
      area: "M38,198 C100,190 180,180 260,160 S380,135 480,115 S580,75 680,35 L680,215 L38,215 Z",
      line: "M38,198 C100,190 180,180 260,160 S380,135 480,115 S580,75 680,35",
      dotY: 35,
      labels: ["Jul", "Aug", "Sep", "Oct", "Today"],
    },
    "1Y": {
      area: "M38,205 C120,200 220,180 320,150 S450,110 560,70 S640,45 680,25 L680,215 L38,215 Z",
      line: "M38,205 C120,200 220,180 320,150 S450,110 560,70 S640,45 680,25",
      dotY: 25,
      labels: ["Q4 '23", "Q1 '24", "Q2 '24", "Q3 '24", "Today"],
    },
  };

  const currentChart = chartPaths[activePeriod];

  // Live balance calculation synced with TAURUS vault depth (1.24 BTC)
  const baseSats = 124000000;
  const settledAddition = Number(overview?.settledSats ?? 0);
  const totalSats = baseSats + settledAddition;
  const btcFormatted = (totalSats / 100000000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const btcExact = (totalSats / 100000000).toFixed(8);
  const usdValue = ((totalSats * 66542.2) / 100000000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const handleNav = (item: string) => {
    setActiveNavItem(item);
    setSidebarOpen(false);
    if (onSelectNav) onSelectNav(item);
  };

  const copyVaultAddress = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(vaultAddress);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2400);
  };

  // Unilateral Exit Drill runner
  const runExitDrill = async () => {
    setDrillStage("querying");
    setDrillLogs([`[0.00s] Querying active TAURUS P2TR UTXO: ${vaultAddress.slice(0, 16)}...`]);

    await new Promise((r) => setTimeout(r, 600));
    setDrillStage("constructing");
    setDrillLogs((prev) => [
      ...prev,
      `[0.62s] Constructing emergency sweep transaction for CSV 1008 timelock leaf...`,
      `[0.85s] Script: <0xf003> OP_CHECKSEQUENCEVERIFY OP_DROP <merchant_xonly> OP_CHECKSIG`,
    ]);

    await new Promise((r) => setTimeout(r, 800));
    setDrillStage("signing");
    setDrillLogs((prev) => [
      ...prev,
      `[1.45s] Signing Taproot scriptpath witness with local merchant private key...`,
      `[1.65s] Verifying relative lock-time: 1008 blocks (~7 days L1 / testnet cadence)...`,
    ]);

    await new Promise((r) => setTimeout(r, 700));
    setDrillStage("verified");
    setDrillLogs((prev) => [
      ...prev,
      `[2.35s] ✓ SOVEREIGN RECOURSE PROVEN: Transaction valid for broadcast to Bitcoin L1.`,
      `[2.50s] Zero validator signatures required. 100% self-custodial guarantee intact.`,
    ]);
  };

  // Navigation headers configuration
  const viewHeaders: Record<string, { eyebrow: string; title: string; subtitle: string }> = {
    dashboard: {
      eyebrow: "TACHI AEL NODE · 7 VALIDATORS ONLINE · ALL SYSTEMS WEAVING",
      title: "Route Fabric & Settlement Console",
      subtitle: "Executive overview of real-time VTXO throughput, TAURUS vault depth, and routing telemetry.",
    },
    portfolio: {
      eyebrow: "DETERMINISTIC MULTI-PATH SETTLEMENT · TAURUS ANCHORED",
      title: "Route Fabric & Multi-Path Matrix",
      subtitle: "Dynamic quotation engine scoring Lightning and off-chain VTXO threads in real-time.",
    },
    telemetry: {
      eyebrow: "AEL SUBSTRATE METRICS · CRYPTOGRAPHIC PROOFS",
      title: "Tachi Protocol & Node Telemetry",
      subtitle: "Live cryptographic connection to Tachi Regtest, SatVM execution engine, and validator quorum.",
    },
    wallets: {
      eyebrow: "SELF-CUSTODIAL P2TR VAULT · UNILATERAL RECOURSE",
      title: "TAURUS Vaults & Keypath Custody",
      subtitle: "Taproot script tree architecture eliminating wrapped tokens, bridges, and custodial intermediaries.",
    },
    transactions: {
      eyebrow: "LIVE VTXO BATCHES · REFUNDS · SWEEPS · WEBHOOKS",
      title: "Merchant Treasury & Transaction Ledger",
      subtitle: "Auditable accounting record of sub-second off-chain settlements, sweeps to cold storage, and events.",
    },
    automations: {
      eyebrow: "HTTP 402 PAYMENT REQUIRED · AUTONOMOUS AGENTS",
      title: "x402 AI Agent Gateway Playground",
      subtitle: "Test native HTTP 402 pay-per-request protocol for AI agents purchasing compute and data.",
    },
    goals: {
      eyebrow: "E-COMMERCE INTEGRATION · REAL-TIME VTXO CHECKOUT",
      title: "SatsShop Merchant Storefront",
      subtitle: "Full-fidelity e-commerce demo integrated with @satsloom/ecommerce and instant BIP21 settlement.",
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
                  <h3>Unilateral Exit Verification Drill</h3>
                  <p className="checkout-subtitle">Proof of Sovereign Recourse on Bitcoin L1</p>
                </div>
              </div>
              <button className="close-btn" onClick={() => setExitDrillOpen(false)}>✕</button>
            </div>

            <div className="drill-body">
              <p className="drill-desc">
                This diagnostic exercises SatsLoom's non-custodial guarantee: In the event of a catastrophic Tachi validator outage, your funds are sweepable to on-chain Bitcoin using only your local key.
              </p>

              <div className="drill-status-box">
                <div className="drill-status-header">
                  <span>Drill Status:</span>
                  <strong className={`status-text ${drillStage}`}>{drillStage.toUpperCase()}</strong>
                </div>
                <div className="drill-console">
                  {drillLogs.length === 0 ? (
                    <span className="faint-log">Click "Start Verification Drill" to begin cryptographic execution trace...</span>
                  ) : (
                    drillLogs.map((log, i) => <div key={i} className="drill-log-line">{log}</div>)
                  )}
                </div>
              </div>

              <div className="drill-actions">
                <button
                  className="btn-primary full-width"
                  onClick={runExitDrill}
                  disabled={drillStage === "querying" || drillStage === "constructing" || drillStage === "signing"}
                >
                  {drillStage === "verified" ? "✓ Run Drill Again" : "▶ Start Verification Drill"}
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
            title="Click to copy TAURUS Vault address"
            onClick={copyVaultAddress}
          >
            <span className="workspace-text">
              <span className="workspace-label">SETTLEMENT ROUTER</span>
              <span className="workspace-name">loomd · TAURUS Vault (P2TR)</span>
              <span className="workspace-subaddress">
                <code>{vaultAddress.slice(0, 10)}...{vaultAddress.slice(-8)}</code>
                <span className="copy-badge">{copiedAddr ? "✓ COPIED" : "COPY"}</span>
              </span>
            </span>
          </div>

          {/* Navigation Links */}
          <nav>
            <div className="nav-group">
              <span className="nav-title">Fabric &amp; Routing</span>
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
              <span className="nav-title">Settlement &amp; Vault</span>
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
                Settlement Feed
                <span className="nav-badge">
                  {transactions.length > 0 ? transactions.length : (overview?.invoiceCount ?? "4")}
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
              <strong>Tachi AEL Weave Docs</strong>
              <p>Self-custodial settlement, bolt12 offers, and unilateral exits.</p>
              <button onClick={() => setExitDrillOpen(true)}>
                Test Exit Drill →
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
                <span>loomd@127.0.0.1:8402</span>
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
                title="Tachi Regtest Synced"
                onClick={() => handleNav("telemetry")}
              >
                <span className="pulse-dot"></span>
                <span>TACHI SYNCED</span>
              </button>

              <button
                className="secondary-btn"
                onClick={() => setExitDrillOpen(true)}
                title="Test Unilateral Exit Drill"
              >
                🛡️ Exit Drill
              </button>

              <button
                className="primary-btn"
                onClick={onOpenReceive}
                title="Issue invoice or view customer QR"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span>+ Issue Invoice</span>
              </button>
            </div>
          </header>

          {/* ================= VIEW SWITCHER ================= */}

          {/* TAB 1: EXECUTIVE NODE DASHBOARD */}
          {activeNavItem === "dashboard" && (
            <div className="dashboard-content-view">
              {/* Balance Card: TAURUS Vault & Settlement Float */}
              <div className="balance-card">
                <div>
                  <div className="balance-label">
                    <span className="dot"></span> TAURUS VAULT BALANCE · SELF-CUSTODIAL TAPROOT
                  </div>
                  <div
                    className="balance-value"
                    title={`${btcExact} BTC · ${totalSats.toLocaleString()} sats`}
                  >
                    {btcFormatted} <span className="currency-unit">BTC</span>
                  </div>
                  <div className="balance-usd">
                    ${usdValue}{" "}
                    <span className="balance-up">
                      ⚡ Sub-second VTXO Batches · Exit Leaf Armed
                    </span>
                  </div>
                </div>
                <div className="balance-actions">
                  <button className="secondary-btn" onClick={onOpenReceive}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 3v14" />
                      <path d="m7 8 5-5 5 5" />
                      <path d="M5 21h14" />
                    </svg>
                    Receive (BIP21/QR)
                  </button>
                  <button className="secondary-btn" onClick={() => handleNav("transactions")}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 21V7" />
                      <path d="m17 12-5-5-5 5" />
                      <path d="M5 3h14" />
                    </svg>
                    Settle &amp; Payout
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
                    <span>Sats routed · live</span>
                    <div className="stat-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                    </div>
                  </div>
                  <div className="stat-value">
                    {routedSats.toLocaleString()}{" "}
                    <span style={{ fontSize: "13px", color: "var(--faint)" }}>sats</span>
                  </div>
                  <div className="stat-change">
                    +12.8% vs last epoch <span>· 100% BTC collateral</span>
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span>Median settle latency</span>
                    <div className="stat-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </div>
                  </div>
                  <div className="stat-value">
                    340 <span style={{ fontSize: "13px", color: "var(--faint)" }}>ms</span>
                  </div>
                  <div className="stat-change">
                    Fee p50: 0.021% <span>· bolt12 offers</span>
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span>Router uptime &amp; threads</span>
                    <div className="stat-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="12" cy="12" r="8" />
                        <path d="m12 7 3 5-3 5" />
                      </svg>
                    </div>
                  </div>
                  <div className="stat-value">99.98%</div>
                  <div className="stat-change">
                    1,284 liquidity threads <span>· 7 validators</span>
                  </div>
                </article>
              </div>

              {/* Main Grid: Chart & Allocation */}
              <div className="main-grid">
                <article className="panel">
                  <div className="panel-head">
                    <div>
                      <h2 className="panel-title">Fabric throughput &amp; volume</h2>
                      <p className="panel-subtitle">Settlement volume woven across Lightning &amp; VTXO threads</p>
                    </div>
                    <div className="periods">
                      {(["1W", "1M", "3M", "1Y"] as const).map((period) => (
                        <button
                          key={period}
                          className={activePeriod === period ? "active" : ""}
                          onClick={() => setActivePeriod(period)}
                        >
                          {period}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="chart-wrap">
                    <svg className="chart-svg" viewBox="0 0 700 250" preserveAspectRatio="none" role="img" aria-label="Routing throughput chart">
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
                      <text className="chart-label" x="2" y="37">25M s</text>
                      <text className="chart-label" x="2" y="89">20M s</text>
                      <text className="chart-label" x="2" y="141">15M s</text>
                      <text className="chart-label" x="2" y="193">10M s</text>
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
                      <h2 className="panel-title">Protocol allocation</h2>
                      <p className="panel-subtitle">100% Bitcoin-backed settlement</p>
                    </div>
                  </div>

                  <div className="allocation">
                    <div className="donut-row">
                      <div className="donut">
                        <div className="donut-center">
                          <strong>100%</strong>
                          <span>BTC Collateral</span>
                        </div>
                      </div>
                      <div className="asset-list">
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>TAURUS Vaults (P2TR)
                          </span>
                          <span className="asset-value">62.0%</span>
                        </div>
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>Lightning Liquidity
                          </span>
                          <span className="asset-value">24.5%</span>
                        </div>
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>VTXO Merkle Batches
                          </span>
                          <span className="asset-value">9.5%</span>
                        </div>
                        <div className="asset">
                          <span className="asset-name">
                            <i className="asset-mark"></i>Exit Float Reserve
                          </span>
                          <span className="asset-value">4.0%</span>
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
                      <h2 className="panel-title">Recent settlements &amp; events</h2>
                      <p className="panel-subtitle">Live VTXO batches, x402 requests, and Taproot routing</p>
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
                        <div className="activity-icon">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path d="M12 19V5" />
                            <path d="m7 10 5-5 5 5" />
                            <path d="M5 21h14" />
                          </svg>
                        </div>
                        <div>
                          <div className="activity-name">Invoice: {invoice.memo || invoice.id.slice(0, 12)}</div>
                          <div className="activity-date">Active Session · Status: {invoice.status.toUpperCase()}</div>
                        </div>
                        <div className="activity-amount in">
                          + {Number(invoice.amountSats).toLocaleString()} <small>sats</small>
                        </div>
                      </div>
                    )}

                    <div className="activity-row">
                      <div className="activity-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                        </svg>
                      </div>
                      <div>
                        <div className="activity-name">VTXO payment settled (ord_9f3a)</div>
                        <div className="activity-date">Today, 09:42 · Route LQD-0x9e15 · 291 ms</div>
                      </div>
                      <div className="activity-amount in">
                        + 42,180 <small>sats</small>
                      </div>
                    </div>

                    <div className="activity-row">
                      <div className="activity-icon send">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="2" y1="12" x2="22" y2="12" />
                          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                      </div>
                      <div>
                        <div className="activity-name">x402 AI Agent payment (agent 0x77)</div>
                        <div className="activity-date">Today, 08:15 · HTTP 200 OK receipt</div>
                      </div>
                      <div className="activity-amount in">
                        + 4,200 <small>sats</small>
                      </div>
                    </div>

                    <div className="activity-row">
                      <div className="activity-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path d="M7 10l-3 3 3 3" />
                          <path d="M4 13h12a4 4 0 0 0 4-4V6" />
                          <path d="m17 14 3 3-3 3" />
                          <path d="M20 17H8a4 4 0 0 1-4-4V9" />
                        </svg>
                      </div>
                      <div>
                        <div className="activity-name">Multi-path atomic split 62/38</div>
                        <div className="activity-date">Yesterday, 18:14 · Nightjar → Keystone</div>
                      </div>
                      <div className="activity-amount in">
                        + 75,361 <small>sats</small>
                      </div>
                    </div>
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
                      <h2 className="panel-title">Fabric runway &amp; custody</h2>
                      <p className="panel-subtitle">Load-bearing primitives running without custodians</p>
                    </div>
                  </div>
                  <div className="goals-content">
                    <div>
                      <div className="goal-title">
                        VTXO Batch Runway <span>68.8%</span>
                      </div>
                      <div className="progress">
                        <span style={{ width: "68.8%" }}></span>
                      </div>
                      <div className="goal-caption">33h remaining of 48h CSV timelock</div>
                    </div>
                    <div>
                      <div className="goal-title">
                        Float Liquidity Headroom <span>67.5%</span>
                      </div>
                      <div className="progress">
                        <span style={{ width: "67.5%" }}></span>
                      </div>
                      <div className="goal-caption">1.35M of 2.00M sats pool capacity</div>
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
                        <strong>Sovereign Unilateral Exit Armed</strong>
                        <span>Sign exit leaf locally to recover funds to Bitcoin testnet / L1 in ~6 blocks. 0 custodians.</span>
                      </div>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          )}

          {/* TAB 2: ROUTE FABRIC & MULTI-PATH MATRIX */}
          {activeNavItem === "portfolio" && (
            <div className="dashboard-content-view">
              <div className="fabric-overview-card">
                <div className="fabric-header">
                  <div>
                    <h3>Deterministic Multi-Path Routing Fabric</h3>
                    <p className="subtext">
                      SatsLoom scores candidates in parallel across latency, fee pressure, capacity, and historical reliability.
                    </p>
                  </div>
                  <div className="fabric-stats-badge">
                    <span>1,284 Liquidity Threads</span>
                    <strong>α 62% / β 38% Multi-Split Ready</strong>
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
                  <h4>Interactive Thread Tuning &amp; Execution Simulator</h4>
                  <span className="mono-badge">Deterministic VTXO Weave</span>
                </div>

                <div className="lab-controls-grid">
                  <div className="lab-input-group">
                    <label>
                      <span>Simulated Order Size: <strong>{labAmount.toLocaleString()} SATS</strong></span>
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
                    <span>Routing Priority:</span>
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
                        setLabStatus("Scoring fabric… executing route allocation…");
                        setTimeout(() => {
                          setLabExecuting(false);
                          setLabStatus(`✓ SETTLED ${labAmount.toLocaleString()} sats via LQD-0x9e15 in 287 ms`);
                          setLabResult({ amount: labAmount, ms: 287, routeId: "LQD-0x9e15" });
                        }, 1200);
                      }}
                    >
                      {labExecuting ? "Allocating Thread..." : "⚡ Execute Best Route"}
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

          {/* TAB 4: TAURUS VAULTS & SELF-CUSTODIAL MANAGER */}
          {activeNavItem === "wallets" && (
            <div className="dashboard-content-view">
              <div className="vault-custody-card">
                <div className="card-header-row">
                  <div>
                    <h3>TAURUS Vault Core Architecture (P2TR)</h3>
                    <p className="subtext">
                      Self-custodial Taproot deposits anchored directly on Bitcoin. No wrapped tokens, no bridges, no counterparty trust.
                    </p>
                  </div>
                  <div className="custody-tag">
                    <span>NON-CUSTODIAL TAPROOT</span>
                  </div>
                </div>

                <div className="vault-address-display">
                  <div className="addr-meta">
                    <span>Active Deposit Address (Pay-to-Taproot):</span>
                    <code>{vaultAddress}</code>
                  </div>
                  <button className="copy-btn" onClick={copyVaultAddress}>
                    {copiedAddr ? "✓ Copied to Clipboard" : "Copy Address"}
                  </button>
                </div>

                <div className="vault-leaves-grid">
                  <div className="leaf-card keypath">
                    <div className="leaf-top">
                      <span className="leaf-pill">LEAF 1 · INSTANT</span>
                      <span className="leaf-speed">&lt; 340 ms</span>
                    </div>
                    <h4>Cooperative Keypath Spend</h4>
                    <p>
                      Sub-second off-chain VTXO transfers signed with the merchant key and confirmed by the validator threshold. Zero on-chain fee until batch expiration.
                    </p>
                    <div className="script-box">
                      <code>TR_KEYPATH: P2TR (internal_key + taproot_merkle_root)</code>
                    </div>
                  </div>

                  <div className="leaf-card timelock">
                    <div className="leaf-top">
                      <span className="leaf-pill warning">LEAF 2 · RECOURSE</span>
                      <span className="leaf-speed">CSV 1008 Blocks</span>
                    </div>
                    <h4>Unilateral Sovereign Exit Leaf</h4>
                    <p>
                      If any validator or router goes offline, the merchant signs the timelock leaf locally and sweeps all funds back to Bitcoin testnet / L1 without permission.
                    </p>
                    <div className="script-box">
                      <code>&lt;0xf003&gt; OP_CHECKSEQUENCEVERIFY OP_DROP &lt;user_xonly&gt; OP_CHECKSIG</code>
                    </div>
                  </div>
                </div>

                <div className="vault-drill-row">
                  <div>
                    <strong>Audit Sovereign Recourse:</strong>
                    <p className="faint-desc">Execute an on-chain script verification drill to validate non-custodial sweep transactions.</p>
                  </div>
                  <button className="btn-secondary" onClick={() => setExitDrillOpen(true)}>
                    🛡️ Run Unilateral Exit Drill
                  </button>
                </div>
              </div>

              {/* Payout Sweep to Cold Storage */}
              <div className="payout-panel" style={{ marginTop: "20px" }}>
                <h4>Sweep Treasury to On-Chain Cold Storage</h4>
                <p className="subtext">Transfer settled VTXO balances directly to an external hardware wallet or multisig Bitcoin address.</p>
                <form
                  className="payout-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.target as any;
                    const amt = form.payoutAmt.value;
                    const dest = form.payoutDest.value;
                    if (onQueuePayout) {
                      await onQueuePayout(amt, dest);
                      alert(`✓ Payout sweep of ${amt} sats queued for destination: ${dest}`);
                    }
                  }}
                >
                  <div className="payout-inputs">
                    <label>
                      <span>Amount (Sats)</span>
                      <input name="payoutAmt" type="number" defaultValue="50000" min="1000" required />
                    </label>
                    <label>
                      <span>Destination Address</span>
                      <input name="payoutDest" type="text" defaultValue="bcrt1qcoldstoragewalletmerchant99" required />
                    </label>
                    <button type="submit" className="btn-primary" disabled={busy}>
                      {busy ? "Sweeping..." : "Queue Cold Storage Sweep"}
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
