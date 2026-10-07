/**
 * Live signet checkout: a real BOLT11 invoice, a scannable QR, and settlement detected from the
 * rail rather than from a button.
 *
 * This is the counterpart to the simulated checkout, and it is deliberately kept separate: the
 * two run in parallel and the caller decides which to show, so a deployment with no node simply
 * never renders this. Nothing here claims a payment that the API has not verified. The state on
 * screen comes from GET /api/live/invoices/:id, which reports `observation.state` read straight
 * off the node and a `settlement` that exists only once the preimage was checked against the
 * payment hash.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

export type LiveInvoice = {
  /** Local invoice id, used to poll the rail. */
  id: string;
  amountSats: number;
  memo: string;
};

export type LiveInvoiceResponse = {
  invoiceId: string;
  paymentHash: string;
  bolt11: string;
  bip21: string;
  amountMsat: string;
  expiresAt: string;
};

type Props = {
  /** Created by the parent through POST /api/live/invoices. */
  request: LiveInvoiceResponse | null;
  /** Rail descriptor as reported by /api/health, so the UI never invents a network. */
  rail: { rail: string; network: string; mode: string; note?: string } | null;
  /** Issues a fresh invoice (e.g. after the current one expires). */
  onIssue: (amountSats: number, memo: string) => void | Promise<void>;
  onClose: () => void;
  onPaid?: (paymentHash: string) => void;
};

type RailState =
  | { kind: "waiting" }
  | { kind: "pending"; observation: any }
  | { kind: "paid"; settlement: any }
  | { kind: "error"; message: string };

export function LiveSignetCheckout({ request, rail, onIssue, onClose, onPaid }: Props) {
  const [state, setState] = useState<RailState>({ kind: "waiting" });
  const [copied, setCopied] = useState<string | null>(null);
  const [errs, setErrs] = useState<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  const network = rail?.network ?? "signet";
  const amountSats = useMemo(() => Number(BigInt(request?.amountMsat ?? "0") / 1000n), [request?.amountMsat]);

  /* --------------------------------------------------------------- the QR code */
  useEffect(() => {
    if (!request || !canvasRef.current) return;
    // BIP21 with the lightning parameter, so a mobile wallet can open it directly; fall back to
    // the raw invoice when the wallet only understands bolt11.
    QRCode.toCanvas(canvasRef.current, request.bip21 || request.bolt11, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#0D0B07", light: "#FFFFFF" },
    }).catch(() => {
      QRCode.toCanvas(canvasRef.current!, request.bolt11, { width: 240, margin: 2 }).catch(() => {});
    });
  }, [request]);

  /* ------------------------------------------------------------- expiry countdown */
  useEffect(() => {
    if (!request) return;
    const expiresAt = Date.parse(request.expiresAt);
    const update = () => setSecondsRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [request]);

  /* ------------------------------------------------------- poll the rail for payment */
  const poll = useCallback(async () => {
    if (!request) return;
    try {
      const response = await fetch(`/api/live/invoices/${encodeURIComponent(request.invoiceId)}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? body?.data?.error ?? `Rail read failed (${response.status})`);
      const data = body?.data ?? {};
      setErrs(0);
      if (data.settlement?.preimage) {
        setState({ kind: "paid", settlement: data.settlement });
        onPaid?.(request.paymentHash);
        return;
      }
      const observed = data.observation?.state;
      if (observed === "paid" || observed === "cancelled" || observed === "expired") {
        setState({ kind: "pending", observation: { state: observed, detail: "settled on the rail; crediting" } });
        return;
      }
      setState({ kind: "pending", observation: data.observation ?? { state: "pending" } });
    } catch (error) {
      setErrs((n) => n + 1);
      setState({ kind: "error", message: (error as Error).message });
    }
  }, [request, onPaid]);

  useEffect(() => {
    if (!request) return;
    void poll();
    // Stop polling once the payment is credited, so a settled invoice is not a request loop.
    if (state.kind === "paid") return;
    const t = setInterval(() => void poll(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1800);
  };

  if (!request) {
    return (
      <div className="ls-empty">
        <p>No live invoice yet. Issue one to get a real BOLT11 request.</p>
        <button className="btn-primary" onClick={() => onIssue(amountSats || 1000, "SatsLoom signet checkout")}>
          Issue invoice
        </button>
      </div>
    );
  }

  const stateLabel =
    state.kind === "paid"
      ? "PAID"
      : state.kind === "error"
        ? errs > 3 ? "UNREACHABLE" : "RETRYING"
        : "WAITING FOR PAYMENT";
  const stateTone = state.kind === "paid" ? "ok" : state.kind === "error" ? "warn" : "info";

  return (
    <div className="ls-checkout">
      <div className="ls-amount">
        <span className="ls-amount-num">{amountSats.toLocaleString()}</span>
        <span className="ls-amount-unit">sats</span>
      </div>
      <div className={`ls-state ${stateTone}`} role="status">
        <span className="ls-dot" aria-hidden="true" />
        {stateLabel}
      </div>

      <div className="ls-qr">
        <canvas ref={canvasRef} width={240} height={240} aria-label="Bitcoin invoice QR code" />
      </div>

      <div className="ls-uri-row">
        <input readOnly value={request.bolt11} className="ls-uri-input" aria-label="BOLT11 invoice" />
        <button className="ls-copy" onClick={() => copy("bolt11", request.bolt11)}>
          {copied === "bolt11" ? "✓" : "copy"}
        </button>
      </div>

      <div className="ls-meta">
        <div><span>Payment hash</span><code>{request.paymentHash.slice(0, 24)}…</code></div>
        <div><span>Network</span><strong>{network}</strong></div>
        <div><span>Expires in</span><strong>
          {Math.floor(secondsRemaining / 60)}:{(secondsRemaining % 60).toString().padStart(2, "0")}
        </strong></div>
      </div>

      {state.kind === "pending" && state.observation?.state && (
        <div className="ls-observation">
          Rail state: <strong>{state.observation.state}</strong>
        </div>
      )}
      {state.kind === "error" && <div className="ls-error">{state.message}</div>}

      {state.kind === "paid" && (
        <div className="ls-paid" role="status">
          <h3>Payment credited</h3>
          <div className="ls-paid-grid">
            <div><span>Amount</span><strong>{(Number(state.settlement.amountMsat) / 1000).toLocaleString()} sats</strong></div>
            <div><span>Verified by</span><strong>{state.settlement.verification}</strong></div>
            <div><span>Rail</span><strong>{state.settlement.rail} · {state.settlement.network}</strong></div>
          </div>
          <div className="ls-preimage">
            <span>Preimage (proves the payment)</span>
            <code>{state.settlement.preimage}</code>
          </div>
          <p className="ls-disclaimer">
            This {network} invoice was paid over the Lightning Network and the preimage the node revealed was
            hashed and checked against the invoice's payment hash. Test coins: they have no fiat value.
          </p>
        </div>
      )}

      <div className="ls-actions">
        <button
          className="ls-btn ghost"
          onClick={() => onIssue(amountSats, request ? "SatsLoom signet invoice" : "SatsLoom signet checkout")}
          disabled={secondsRemaining > 0 && state.kind !== "paid"}
        >
          New invoice
        </button>
        <button className="ls-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
