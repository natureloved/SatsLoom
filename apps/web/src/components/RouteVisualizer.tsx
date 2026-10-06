import React from "react";

interface Props {
  routes: any[];
  selectedRouteId?: string;
  onSelect: () => void;
  onInvalidateAndSettle: () => void;
  onSettle: () => void;
  disabled: boolean;
  settled: boolean;
  fallbackHistory?: any[];
}

export function RouteVisualizer({
  routes,
  selectedRouteId,
  onSelect,
  onInvalidateAndSettle,
  onSettle,
  disabled,
  settled,
  fallbackHistory = [],
}: Props) {
  if (!routes || routes.length === 0) return null;

  const maxLatency = Math.max(...routes.map((r) => r.estimatedSettlementSeconds), 600);

  return (
    <div className="route-visualizer-section">
      <div className="section-title-row">
        <div>
          <h3>Illustrative Single-Route Scoring</h3>
          <p className="section-desc">
            Hard-coded candidate values only. The demo selects one sample route; it does not split payments or contact a provider.
          </p>
        </div>
        <div className="route-action-buttons">
          <button className="btn-secondary" onClick={onSelect} disabled={disabled || settled}>
            ⚡ 1. Score sample routes
          </button>
          <button className="btn-accent" onClick={onSettle} disabled={disabled || settled || !selectedRouteId}>
            ✓ 2. Simulate selected route
          </button>
          <button className="btn-warning" onClick={onInvalidateAndSettle} disabled={disabled || settled}>
            ⚠️ Invalidate candidate + simulate fallback
          </button>
        </div>
      </div>

      {fallbackHistory.length > 0 && (
        <div className="fallback-banner">
          <div className="fallback-icon">🔄</div>
          <div>
            <strong>Simulated fallback recorded:</strong>
            <p>{fallbackHistory[0].reason}</p>
          </div>
        </div>
      )}

      <div className="routes-grid">
        {routes.map((route) => {
          const isSelected = selectedRouteId === route.id;
          const isInvalidated = !route.available;
          const latencyPercent = Math.min(100, Math.round((route.estimatedSettlementSeconds / maxLatency) * 100));

          return (
            <div
              key={route.id}
              className={`route-card ${isSelected ? "selected" : ""} ${isInvalidated ? "invalidated" : ""}`}
            >
              <div className="route-card-header">
                <div className="route-title-badge">
                  <span className={`source-tag ${route.source}`}>{route.source.toUpperCase()}</span>
                  <h4>{route.id}</h4>
                </div>
                <span className={`status-pill ${route.available ? "active" : "disabled"}`}>
                  {route.available ? "Sample candidate" : "Excluded in demo"}
                </span>
              </div>

              <div className="route-metrics">
                <div className="metric">
                  <span className="metric-label">Sample time estimate</span>
                  <span className="metric-val">{route.estimatedSettlementSeconds}s</span>
                  <div className="progress-bar-bg">
                    <div
                      className={`progress-bar-fill ${route.estimatedSettlementSeconds < 30 ? "fast" : route.estimatedSettlementSeconds < 100 ? "medium" : "slow"}`}
                      style={{ width: `${Math.max(10, latencyPercent)}%` }}
                    ></div>
                  </div>
                </div>

                <div className="metric-row">
                  <div>
                    <span className="metric-label">Sample fee</span>
                    <span className="metric-val highlight">{route.feeSats} sats</span>
                  </div>
                  <div>
                    <span className="metric-label">Sample capacity</span>
                    <span className="metric-val">{Number(route.capacitySats).toLocaleString()} sats</span>
                  </div>
                </div>

                <div className="metric-row">
                  <div>
                    <span className="metric-label">Illustrative exit-risk input</span>
                    <span className={`risk-tag risk-${route.exitRisk}`}>
                      {route.exitRisk.toUpperCase()}
                      {route.timelockBlocks ? ` (${route.timelockBlocks} blks)` : ""}
                    </span>
                  </div>
                  <div>
                    <span className="metric-label">Execution method</span>
                    <span className="metric-val">Not configured</span>
                  </div>
                </div>
              </div>

              {isSelected && (
                <div className="selected-indicator">
                  <span>★ Selected sample candidate</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
