import React, { useState } from "react";

export function X402Sandbox() {
  const [stage, setStage] = useState<"idle" | "requesting" | "challenged" | "paying" | "unlocked">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [challengeData, setChallengeData] = useState<any>(null);
  const [unlockedPayload, setUnlockedPayload] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const addLog = (msg: string) => {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const runAgentWorkflow = async () => {
    setBusy(true);
    setStage("requesting");
    setLog([]);
    setChallengeData(null);
    setUnlockedPayload(null);

    addLog("🤖 AI Agent initiating autonomous request: GET /api/x402/resource");

    try {
      // Step 1: Request protected resource
      const initialRes = await fetch("/api/x402/resource");
      addLog(`📡 Server responded with HTTP status ${initialRes.status} (${initialRes.statusText})`);

      if (initialRes.status === 402) {
        const authHeader = initialRes.headers.get("www-authenticate");
        const invoiceId = initialRes.headers.get("x-402-invoice-id");
        const priceSats = initialRes.headers.get("x-402-price-sats");
        const body = await initialRes.json();

        setStage("challenged");
        setChallengeData({ authHeader, invoiceId, priceSats, body });
        addLog(`⚠️ HTTP 402 Payment Required intercepted by Agent!`);
        addLog(`📋 Invoice challenge ID: ${invoiceId} (Required: ${priceSats} sats)`);

        // Wait briefly for visual demo pacing
        await new Promise((r) => setTimeout(r, 1200));

        // Step 2: Agent auto-settles invoice via SatsLoom router
        setStage("paying");
        addLog(`⚡ Agent executing autonomous payment via SatsLoom VTXO router...`);

        const payRes = await fetch("/api/x402/agent-pay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invoiceId }),
        });
        const payResult = await payRes.json();
        addLog(`✓ SatsLoom settled 50 sats off-chain via VTXO route (tx: ${payResult.data?.settlement?.txid})`);

        await new Promise((r) => setTimeout(r, 1000));

        // Step 3: Replay request with payment proof
        addLog(`🔓 Agent replaying request with 'X-Payment-Invoice: ${invoiceId}'`);
        const unlockedRes = await fetch("/api/x402/resource", {
          headers: { "x-payment-invoice": invoiceId! },
        });

        if (unlockedRes.ok) {
          const payload = await unlockedRes.json();
          setStage("unlocked");
          setUnlockedPayload(payload.data);
          addLog("🎉 200 OK: Protected resource successfully unlocked & received by Agent!");
        } else {
          addLog(`❌ Failed to unlock: ${unlockedRes.status}`);
        }
      } else {
        const payload = await initialRes.json();
        setStage("unlocked");
        setUnlockedPayload(payload.data);
      }
    } catch (err) {
      addLog(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="x402-sandbox-container">
      <div className="sandbox-header">
        <div>
          <h2>x402 Agentic Payment Playground</h2>
          <p className="sandbox-subtitle">
            Experience Bitcoin's native HTTP 402 protocol: Autonomous AI agents paying for compute, models, and data in real-time.
          </p>
        </div>
        <button className="btn-primary" onClick={runAgentWorkflow} disabled={busy}>
          {busy ? "Agent Executing..." : "▶ Simulate AI Agent (x402 Flow)"}
        </button>
      </div>

      <div className="x402-flow-cards">
        <div className={`flow-step-card ${stage === "requesting" ? "active" : ""}`}>
          <div className="step-num">Step 1</div>
          <h4>Request API</h4>
          <p>Agent calls <code>GET /api/x402/resource</code> with zero credentials.</p>
        </div>

        <div className={`flow-step-card ${stage === "challenged" ? "active" : ""}`}>
          <div className="step-num">Step 2</div>
          <h4>HTTP 402 Challenge</h4>
          <p>Server challenges with <code>L402</code> invoice header & 50 sat price.</p>
        </div>

        <div className={`flow-step-card ${stage === "paying" ? "active" : ""}`}>
          <div className="step-num">Step 3</div>
          <h4>Router Settlement</h4>
          <p>Agent settles sats instantaneously via Tachi off-chain VTXO.</p>
        </div>

        <div className={`flow-step-card ${stage === "unlocked" ? "active" : ""}`}>
          <div className="step-num">Step 4</div>
          <h4>Data Unlocked</h4>
          <p>Proof verified; high-value autonomous intelligence released.</p>
        </div>
      </div>

      <div className="sandbox-split">
        <div className="console-panel">
          <h4>Agent Execution Terminal</h4>
          <div className="terminal-screen">
            {log.length === 0 ? (
              <span className="placeholder-text">Click "Simulate AI Agent" above to start execution trace...</span>
            ) : (
              log.map((line, idx) => <div key={idx} className="terminal-line">{line}</div>)
            )}
          </div>
        </div>

        <div className="payload-panel">
          <h4>Result & Headers Inspection</h4>
          {challengeData && stage === "challenged" && (
            <div className="challenge-box">
              <span className="badge-warning">HTTP 402 Captured</span>
              <pre>{JSON.stringify(challengeData, null, 2)}</pre>
            </div>
          )}

          {unlockedPayload && (
            <div className="unlocked-box">
              <span className="badge-success">HTTP 200 Payload Unlocked</span>
              <pre>{JSON.stringify(unlockedPayload, null, 2)}</pre>
            </div>
          )}

          {!challengeData && !unlockedPayload && (
            <div className="empty-payload-state">
              <p>Inspector output will appear here as the agent negotiates payment.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
