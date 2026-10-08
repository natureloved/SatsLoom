import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

interface Props {
  invoice: any;
  onClose: () => void;
  onSimulatePay: () => void;
  isSimulated: boolean;
  onSwitchToLive?: () => void;
  isLiveAvailable?: boolean;
}

export function CustomerCheckoutModal({
  invoice,
  onClose,
  onSimulatePay,
  isSimulated,
  onSwitchToLive,
  isLiveAvailable,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const amountSats = Number(invoice?.amountSats ?? 0);
  const checkoutUrl = `${window.location.origin}/#checkout/${encodeURIComponent(invoice?.id ?? "")}`;

  const qrPayload = useMemo(() => {
    if (invoice?.payment?.bolt11) return invoice.payment.bolt11;
    if (invoice?.bolt11) return invoice.bolt11;
    if (invoice?.payment?.bip21) return invoice.payment.bip21;
    if (invoice?.bip21) return invoice.bip21;
    if (invoice?.id) {
      return `lightning:${invoice.id}`;
    }
    return checkoutUrl;
  }, [invoice, checkoutUrl]);

  useEffect(() => {
    const expiresAt = Date.parse(invoice?.expiresAt ?? "");
    const update = () => setSecondsRemaining(Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0);
    update();
    if (isSimulated) return;
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [invoice?.expiresAt, isSimulated]);

  useEffect(() => {
    if (!canvasRef.current || !qrPayload) return;
    QRCode.toCanvas(canvasRef.current, qrPayload, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#0D0B07", light: "#FFFFFF" },
    }).catch(() => {
      if (canvasRef.current && invoice?.id) {
        QRCode.toCanvas(canvasRef.current, invoice.id, { width: 220, margin: 2 }).catch(() => {});
      }
    });
  }, [qrPayload, invoice?.id]);

  const copyCheckoutUrl = async () => {
    await navigator.clipboard.writeText(checkoutUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyPayload = async () => {
    await navigator.clipboard.writeText(qrPayload);
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  };

  const timeFormatted = `${Math.floor(secondsRemaining / 60).toString().padStart(2, "0")}:${(secondsRemaining % 60).toString().padStart(2, "0")}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content checkout-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="checkout-brand">
            <span className="bitcoin-logo">₿</span>
            <div>
              <h3>SatsLoom Invoice Checkout</h3>
              <p className="checkout-subtitle">
                {isLiveAvailable ? "Scannable Lightning payment QR" : "Demo simulation · Scannable QR code"}
              </p>
            </div>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Close modal">✕</button>
        </div>

        {isSimulated ? (
          <div className="checkout-success-view">
            <div className="success-icon-wrap" aria-hidden="true">✓</div>
            <h2>Simulation recorded</h2>
            <p className="success-amount"><strong>{amountSats.toLocaleString()} sats</strong> — simulated invoice confirmation</p>
            <div className="checkout-simulation-banner" role="status">
              <div className="banner-info">
                <strong>No Bitcoin moved.</strong> This demo changes application state only; it did not verify a transaction or contact Tachi for settlement.
              </div>
            </div>
            <div className="invoice-meta-box">
              <div>Invoice: <code>{invoice?.id}</code></div>
              <div>Payment: <strong>SIMULATED</strong></div>
              <div>Settlement: <strong>Not performed by checkout</strong></div>
            </div>
            <button className="btn-primary full-width" onClick={onClose}>Close demo checkout</button>
          </div>
        ) : (
          <div className="checkout-body">
            <div className="amount-banner">
              <div className="sats-display">
                <span className="amount-number">{amountSats.toLocaleString()}</span>
                <span className="sats-label">SATS</span>
              </div>
              <div className="usd-equivalent">
                {isLiveAvailable ? "Signet test coins · real settlement" : "Demo amount · simulated drill"}
              </div>
            </div>

            <div className="qr-container">
              <canvas
                ref={canvasRef}
                width={220}
                height={220}
                className="qr-image"
                aria-label="Bitcoin payment QR code"
              />
              <div className="timer-badge">
                <span className="pulse-dot"></span>
                <span>Invoice expires in {timeFormatted}</span>
              </div>
            </div>

            <div className="uri-copy-row">
              <input readOnly value={qrPayload} className="uri-input" aria-label="Invoice payment URI" />
              <button className="copy-btn" onClick={copyPayload} title="Copy payment string">
                {copiedPayload ? "✓ Copied" : "Copy URI"}
              </button>
            </div>

            <p className="checkout-memo"><strong>Memo:</strong> {invoice?.memo || "SatsLoom Demo Invoice"}</p>

            {onSwitchToLive && (
              <div className="checkout-live-switch-callout">
                <div className="live-callout-text">
                  <strong>Prefer a real Lightning payment?</strong>
                  <span>Switch to the Live Signet rail for a real BOLT11 invoice and node-verified settlement.</span>
                </div>
                <button
                  type="button"
                  className="btn-secondary live-switch-btn full-width"
                  onClick={onSwitchToLive}
                >
                  ⚡ Switch to Live Signet Invoice →
                </button>
              </div>
            )}

            <div className="checkout-simulation-banner">
              <div className="banner-info">
                <strong>Demo simulator:</strong> Click below to simulate invoice confirmation and route event delivery.
              </div>
              <button className="btn-pay-simulate" onClick={onSimulatePay} disabled={secondsRemaining === 0}>
                <span>Simulate invoice confirmation</span>
              </button>
            </div>

            <div className="checkout-link-row">
              <button className="btn-ghost-link" onClick={copyCheckoutUrl}>
                {copied ? "✓ Checkout link copied" : "Copy checkout page URL"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
