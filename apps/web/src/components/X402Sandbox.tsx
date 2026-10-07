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

        // Step 2: The demo marks this sample invoice paid in application state only.
        setStage("paying");
        addLog("⚠️ Running a settlement simulation only; no sats are sent or verified.");

        const payRes = await fetch("/api/x402/agent-pay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invoiceId }),
        });
        const payResult = await payRes.json();
        if (!payRes.ok || !payResult.data?.proofToken) throw new Error(payResult.error ?? payResult.data?.error ?? "Demo receipt was not issued");
        const proofToken = payResult.data.proofToken as string;
        addLog("✓ Sample invoice state marked confirmed/settled in simulation; no Bitcoin transaction exists.");
        addLog("🔏 Short-lived signed demo receipt issued (not proof of payment)." );

        await new Promise((r) => setTimeout(r, 1000));

        // Step 3: Replay with the signed simulation receipt, not an invoice ID.
        addLog("🔓 Replaying with the signed SatsLoom-Demo receipt (not a payment proof).");
        const unlockedRes = await fetch("/api/x402/resource", {
          headers: { authorization: proofToken },
        });

        if (unlockedRes.ok) {
          const payload = await unlockedRes.json();
          setStage("unlocked");
          setUnlockedPayload(payload.data);
          addLog("✓ 200 OK: demo resource unlocked after signature and simulation-state checks; no funds moved.");
        } else {
          addLog(`❌ Failed to unlock: ${unlockedRes.status}`);
        }
      } else {
        const payload = await initialRes.json();
        if (!initialRes.ok) throw new Error(payload.error ?? payload.data?.error ?? `Demo endpoint returned ${initialRes.status}`);
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
          <h2>x402 Agent Workflow Demo</h2>
          <p className="sandbox-subtitle">
            Explore an HTTP 402 challenge with a signed simulation receipt. This sandbox does not charge sats or verify a Bitcoin payment.
          </p>
        </div>
        <button className="btn-primary" onClick={runAgentWorkflow} disabled={busy}>
          {busy ? "Running simulation…" : "▶ Simulate the x402 Flow"}
        </button>
      </div>

      <div className="x402-flow-cards">
        <div className={`flow-step-card ${stage === "requesting" ? "active" : ""}`}>
          <div className="sandbox-step-num">Step 1</div>
          <h4>Request API</h4>
          <p>Agent calls <code>GET /api/x402/resource</code> with zero credentials.</p>
        </div>

        <div className={`flow-step-card ${stage === "challenged" ? "active" : ""}`}>
          <div className="sandbox-step-num">Step 2</div>
          <h4>HTTP 402 Challenge</h4>
          <p>Server returns a <code>SatsLoom-Demo</code> challenge for 50 simulated sats.</p>
        </div>

        <div className={`flow-step-card ${stage === "paying" ? "active" : ""}`}>
          <div className="sandbox-step-num">Step 3</div>
          <h4>Settlement Simulation</h4>
          <p>The demo marks sample state as settled; no Tachi call or Bitcoin transfer occurs.</p>
        </div>

        <div className={`flow-step-card ${stage === "unlocked" ? "active" : ""}`}>
          <div className="sandbox-step-num">Step 4</div>
          <h4>Data Unlocked</h4>
          <p>Signed demo receipt checked. This is not a proof of payment.</p>
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
              <p>Inspector output will appear here as the demo challenge and signed simulation receipt are checked.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
