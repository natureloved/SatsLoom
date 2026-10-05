import React, { useState } from "react";

interface Props {
  transactions: any[];
  refunds: any[];
  payouts: any[];
  liquidity: any;
  onQueuePayout: (amount: string, destination: string) => Promise<void>;
  busy: boolean;
}

export function OperationsView({
  transactions,
  refunds,
  payouts,
  liquidity,
  onQueuePayout,
  busy,
}: Props) {
  const [subTab, setSubTab] = useState<"transactions" | "refunds" | "payouts" | "webhooks">("transactions");
  const [payoutAmount, setPayoutAmount] = useState("25000");
  const [destination, setDestination] = useState("bcrt1qmerchantdev779xxpayoutaddress");
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadWebhooks = () => {
    fetch("/api/webhooks")
      .then((res) => res.json())
      .then((data) => setWebhooks(data.data ?? []))
      .catch((err) => console.error(err));
  };

  const handleSubTabChange = (tab: "transactions" | "refunds" | "payouts" | "webhooks") => {
    setSubTab(tab);
    if (tab === "webhooks") loadWebhooks();
  };

  const submitPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payoutAmount || busy) return;
    await onQueuePayout(payoutAmount, destination);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const filterItems = (list: any[]) => {
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
  };

  const vtxoPool = Number(liquidity?.vtxoSats ?? 100000);
  const lpFloat = Number(liquidity?.providerSats ?? 250000);
  const reserved = Number(liquidity?.reservedSats ?? 50000);

  return (
    <div className="operations-container">
      {/* 3-Card Treasury Metrics Overview */}
      <div className="treasury-kpi-deck">
        <div className="treasury-card">
          <div className="t-card-top">
            <span className="t-card-label">VTXO Liquid Depth</span>
            <span className="t-card-badge settled">
              <span className="pulse-dot green"></span> Live Settled
            </span>
          </div>
          <div className="t-card-val">
            {vtxoPool.toLocaleString()} <span className="t-unit">sats</span>
          </div>
          <div className="t-card-desc">Off-chain VTXO instant settlement capacity</div>
        </div>

        <div className="treasury-card">
          <div className="t-card-top">
            <span className="t-card-label">LP Routing Float</span>
            <span className="t-card-badge float">
              <span className="pulse-dot amber"></span> Provider Float
            </span>
          </div>
          <div className="t-card-val">
            {lpFloat.toLocaleString()} <span className="t-unit">sats</span>
          </div>
          <div className="t-card-desc">Multi-hop liquidity provider reserve for atomic routing</div>
        </div>

        <div className="treasury-card">
          <div className="t-card-top">
            <span className="t-card-label">Reserved In-Flight</span>
            <span className="t-card-badge reserved">
              <span className="pulse-dot gold"></span> Escrow Lock
            </span>
          </div>
          <div className="t-card-val">
            {reserved.toLocaleString()} <span className="t-unit">sats</span>
          </div>
          <div className="t-card-desc">Committed to active routing batches &amp; queued sweeps</div>
        </div>
      </div>

      {/* Operations Toolbar with Subtabs and Search */}
      <div className="operations-toolbar">
        <div className="subtab-buttons">
          <button
            type="button"
            className={`subtab-btn ${subTab === "transactions" ? "active" : ""}`}
            onClick={() => handleSubTabChange("transactions")}
          >
            Settlements <span className="subtab-count">{transactions.length}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn ${subTab === "refunds" ? "active" : ""}`}
            onClick={() => handleSubTabChange("refunds")}
          >
            Refunds <span className="subtab-count">{refunds.length}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn ${subTab === "payouts" ? "active" : ""}`}
            onClick={() => handleSubTabChange("payouts")}
          >
            Payouts <span className="subtab-count">{payouts.length}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn ${subTab === "webhooks" ? "active" : ""}`}
            onClick={() => handleSubTabChange("webhooks")}
          >
            Webhook Logs {webhooks.length > 0 && <span className="subtab-count">{webhooks.length}</span>}
          </button>
        </div>

        <div className="search-wrap">
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="11" cy="11" r="8" strokeWidth="2" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            placeholder="Search transactions, txids, IDs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button className="search-clear-btn" onClick={() => setSearchQuery("")} title="Clear search">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Payout Sweep Form (Active when Payouts tab is selected) */}
      {subTab === "payouts" && (
        <div className="payout-panel-card">
          <div className="payout-card-head">
            <div>
              <h4>Initiate Merchant Payout / Sweep to Cold Storage</h4>
              <p className="payout-card-subtitle">
                Transfer settled off-chain VTXO balances directly to an external on-chain Bitcoin testnet or hardware wallet address.
              </p>
            </div>
            <div className="payout-limit-badge">
              <span>Max Liquid: <strong>{vtxoPool.toLocaleString()} sats</strong></span>
            </div>
          </div>

          <form className="payout-form-grid" onSubmit={submitPayout}>
            <div className="payout-field">
              <label htmlFor="payout-amt">
                <span>Sweep Amount (sats)</span>
                <span className="field-min">Min: 1,000 sats</span>
              </label>
              <div className="input-with-unit">
                <input
                  id="payout-amt"
                  type="number"
                  className="form-input"
                  value={payoutAmount}
                  onChange={(e) => setPayoutAmount(e.target.value)}
                  min="1000"
                  max={String(vtxoPool)}
                  required
                />
                <span className="input-unit">SATS</span>
              </div>
              <div className="quick-amount-row">
                <button type="button" className="quick-amt-btn" onClick={() => setPayoutAmount("10000")}>10k</button>
                <button type="button" className="quick-amt-btn" onClick={() => setPayoutAmount("25000")}>25k</button>
                <button type="button" className="quick-amt-btn" onClick={() => setPayoutAmount("50000")}>50k</button>
                <button
                  type="button"
                  className="quick-amt-btn max"
                  onClick={() => setPayoutAmount(String(vtxoPool))}
                >
                  Max VTXO
                </button>
              </div>
            </div>

            <div className="payout-field flex-grow">
              <label htmlFor="payout-dest">
                <span>Destination Bitcoin Address (Testnet / Regtest)</span>
                <span className="field-type">P2TR / P2WPKH</span>
              </label>
              <input
                id="payout-dest"
                type="text"
                className="form-input mono"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="bcrt1q... or tb1q..."
                required
              />
              <span className="field-subtext">Direct non-custodial sweep broadcasted into the next regtest/testnet block.</span>
            </div>

            <div className="payout-action-col">
              <button type="submit" className="btn-primary payout-submit-btn" disabled={busy}>
                {busy ? (
                  <>
                    <span className="btn-spinner"></span>
                    <span>Sweeping...</span>
                  </>
                ) : (
                  <>
                    <span>⚡ Queue Payout Sweep</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Ledger Tables for each subtab */}
      <div className="table-responsive">
        {subTab === "transactions" && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th style={{ width: "26%" }}>TxID / Settlement ID</th>
                <th style={{ width: "16%" }}>Invoice</th>
                <th style={{ width: "20%" }}>Route</th>
                <th style={{ width: "14%" }}>Status</th>
                <th style={{ width: "14%" }}>Execution</th>
                <th style={{ width: "10%", textAlign: "right" }}>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {filterItems(transactions).length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-row-card">
                    <div className="empty-state">
                      <div className="empty-icon">⚡</div>
                      <div className="empty-title">No settlements recorded yet</div>
                      <div className="empty-desc">Settled VTXO batches and off-chain payments will stream here automatically.</div>
                    </div>
                  </td>
                </tr>
              ) : (
                filterItems(transactions).map((tx) => (
                  <tr key={tx.id || tx.txid}>
                    <td>
                      <div className="mono-cell">
                        <code className="code-badge">{(tx.txid ?? tx.id)?.slice(0, 16)}...</code>
                        <button
                          type="button"
                          className="cell-copy-btn"
                          onClick={() => copyToClipboard(tx.txid ?? tx.id, tx.txid ?? tx.id)}
                          title="Copy full TxID"
                        >
                          {copiedId === (tx.txid ?? tx.id) ? "✓" : "❐"}
                        </button>
                      </div>
                    </td>
                    <td>
                      <code className="code-faint">{tx.invoiceId ? `${tx.invoiceId.slice(0, 8)}...` : "—"}</code>
                    </td>
                    <td>
                      <span className="route-cell-tag">{tx.routeId || "TACHI-VTXO"}</span>
                    </td>
                    <td>
                      <span className="status-badge settled">
                        <span className="dot settled"></span>
                        {tx.status}
                      </span>
                    </td>
                    <td>
                      <span className="badge-sim">{tx.simulation ? "Tachi Regtest" : "Live Testnet"}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn-inspect" onClick={() => setSelectedItem(tx)}>
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {subTab === "refunds" && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th style={{ width: "24%" }}>Refund ID</th>
                <th style={{ width: "16%" }}>Invoice</th>
                <th style={{ width: "18%" }}>Amount</th>
                <th style={{ width: "22%" }}>Reason</th>
                <th style={{ width: "12%" }}>Timestamp</th>
                <th style={{ width: "8%", textAlign: "right" }}>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {filterItems(refunds).length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-row-card">
                    <div className="empty-state">
                      <div className="empty-icon">↩</div>
                      <div className="empty-title">No refunds issued</div>
                      <div className="empty-desc">Instant customer refunds will be logged with full cryptographic provenance.</div>
                    </div>
                  </td>
                </tr>
              ) : (
                filterItems(refunds).map((ref) => (
                  <tr key={ref.id}>
                    <td>
                      <div className="mono-cell">
                        <code className="code-badge">{ref.id?.slice(0, 14)}...</code>
                        <button
                          type="button"
                          className="cell-copy-btn"
                          onClick={() => copyToClipboard(ref.id, ref.id)}
                          title="Copy full Refund ID"
                        >
                          {copiedId === ref.id ? "✓" : "❐"}
                        </button>
                      </div>
                    </td>
                    <td>
                      <code className="code-faint">{ref.invoiceId ? `${ref.invoiceId.slice(0, 8)}...` : "—"}</code>
                    </td>
                    <td>
                      <strong className="amt-sats">{Number(ref.amountSats).toLocaleString()} <span>sats</span></strong>
                    </td>
                    <td>
                      <span className="reason-text">{ref.reason}</span>
                    </td>
                    <td>
                      <span className="time-text">{new Date(ref.createdAt).toLocaleTimeString()}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn-inspect" onClick={() => setSelectedItem(ref)}>
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {subTab === "payouts" && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th style={{ width: "22%" }}>Payout ID</th>
                <th style={{ width: "18%" }}>Amount</th>
                <th style={{ width: "32%" }}>Destination Address</th>
                <th style={{ width: "14%" }}>Status</th>
                <th style={{ width: "14%" }}>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {filterItems(payouts).length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-row-card">
                    <div className="empty-state">
                      <div className="empty-icon">📦</div>
                      <div className="empty-title">No payouts queued yet</div>
                      <div className="empty-desc">Queue a cold storage sweep above to transfer settled treasury balances to an external wallet.</div>
                    </div>
                  </td>
                </tr>
              ) : (
                filterItems(payouts).map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="mono-cell">
                        <code className="code-badge">{p.id?.slice(0, 14)}...</code>
                        <button
                          type="button"
                          className="cell-copy-btn"
                          onClick={() => copyToClipboard(p.id, p.id)}
                          title="Copy full Payout ID"
                        >
                          {copiedId === p.id ? "✓" : "❐"}
                        </button>
                      </div>
                    </td>
                    <td>
                      <strong className="amt-sats">{Number(p.amountSats).toLocaleString()} <span>sats</span></strong>
                    </td>
                    <td>
                      <div className="dest-addr-cell">
                        <code className="mono-addr" title={p.destination}>
                          {p.destination?.length > 30 ? `${p.destination.slice(0, 16)}...${p.destination.slice(-10)}` : p.destination}
                        </code>
                        <button
                          type="button"
                          className="cell-copy-btn"
                          onClick={() => copyToClipboard(p.destination, `dest-${p.id}`)}
                          title="Copy Address"
                        >
                          {copiedId === `dest-${p.id}` ? "✓" : "❐"}
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${p.status?.toLowerCase() || "queued"}`}>
                        <span className={`dot ${p.status?.toLowerCase() || "queued"}`}></span>
                        {p.status}
                      </span>
                    </td>
                    <td>
                      <span className="time-text">{new Date(p.createdAt).toLocaleTimeString()}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {subTab === "webhooks" && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th style={{ width: "22%" }}>Event Type</th>
                <th style={{ width: "18%" }}>Invoice ID</th>
                <th style={{ width: "32%" }}>Target Endpoint</th>
                <th style={{ width: "14%" }}>HTTP Status</th>
                <th style={{ width: "14%" }}>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {filterItems(webhooks).length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-row-card">
                    <div className="empty-state">
                      <div className="empty-icon">🔔</div>
                      <div className="empty-title">No webhook deliveries dispatched yet</div>
                      <div className="empty-desc">Provide a webhookUrl when creating merchant invoices to monitor live HTTP webhook delivery traces.</div>
                    </div>
                  </td>
                </tr>
              ) : (
                filterItems(webhooks).map((hook) => (
                  <tr key={hook.id}>
                    <td>
                      <span className="event-type-badge">{hook.event}</span>
                    </td>
                    <td>
                      <code className="code-faint">{hook.invoiceId ? `${hook.invoiceId.slice(0, 8)}...` : "—"}</code>
                    </td>
                    <td>
                      <code className="mono-addr">{hook.url}</code>
                    </td>
                    <td>
                      <span className={`http-status-pill ${hook.status === 200 ? "ok" : "err"}`}>
                        {hook.status} {hook.status === 200 ? "OK" : "FAILED"}
                      </span>
                    </td>
                    <td>
                      <span className="time-text">{new Date(hook.timestamp).toLocaleTimeString()}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* JSON Record Details Modal */}
      {selectedItem && (
        <div className="modal-backdrop" onClick={() => setSelectedItem(null)}>
          <div className="modal-content json-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon">📜</div>
                <div>
                  <h3>Cryptographic Record Details</h3>
                  <p className="modal-subtitle">Verifiable JSON schema trace for settlement auditing</p>
                </div>
              </div>
              <button className="close-btn" onClick={() => setSelectedItem(null)}>✕</button>
            </div>
            <pre className="json-pre">{JSON.stringify(selectedItem, null, 2)}</pre>
            <div className="modal-actions-row">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(selectedItem, null, 2));
                  alert("Record copied to clipboard");
                }}
              >
                📋 Copy JSON
              </button>
              <button type="button" className="btn-primary" onClick={() => setSelectedItem(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
