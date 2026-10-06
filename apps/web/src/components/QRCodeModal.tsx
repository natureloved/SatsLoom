import React, { useEffect, useState } from "react";

interface Props {
  invoice: any;
  onClose: () => void;
  onSimulatePay: () => void;
  isSimulated: boolean;
}

export function CustomerCheckoutModal({ invoice, onClose, onSimulatePay, isSimulated }: Props) {
  const [copied, setCopied] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const amountSats = Number(invoice?.amountSats ?? 0);
  const checkoutUrl = `${window.location.origin}/#checkout/${encodeURIComponent(invoice?.id ?? "")}`;

  useEffect(() => {
    const expiresAt = Date.parse(invoice?.expiresAt ?? "");
    const update = () => setSecondsRemaining(Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0);
    update();
    if (isSimulated) return;
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [invoice?.expiresAt, isSimulated]);

  const copyCheckoutUrl = async () => {
    await navigator.clipboard.writeText(checkoutUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const timeFormatted = `${Math.floor(secondsRemaining / 60).toString().padStart(2, "0")}:${(secondsRemaining % 60).toString().padStart(2, "0")}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content checkout-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="checkout-brand">
            <span className="bitcoin-logo">₿</span>
            <div>
              <h3>SatsLoom Demo Checkout</h3>
              <p className="checkout-subtitle">No Bitcoin network payment is connected</p>
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
              <div className="usd-equivalent">Demo amount · not payable</div>
            </div>

            <div className="qr-container">
              <div className="qr-placeholder">No payment QR or Bitcoin address is available in demo mode.</div>
              <div className="timer-badge">
                <span className="pulse-dot"></span>
                <span>Demo invoice expires in {timeFormatted}</span>
              </div>
            </div>

            <div className="uri-copy-row">
              <input readOnly value={invoice?.id ?? ""} className="uri-input" aria-label="Invoice ID" />
              <button className="copy-btn" onClick={copyCheckoutUrl} title="Copy checkout link">
                {copied ? "✓ Link copied" : "Copy link"}
              </button>
            </div>

            <p className="checkout-memo"><strong>Memo:</strong> {invoice?.memo || "SatsLoom Demo Invoice"}</p>

            <div className="checkout-simulation-banner">
              <div className="banner-info">
                <strong>Simulation only:</strong> no funds are received, sent, or verified.
              </div>
              <button className="btn-pay-simulate" onClick={onSimulatePay} disabled={secondsRemaining === 0}>
                <span>Simulate invoice confirmation</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
