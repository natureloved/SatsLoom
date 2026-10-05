import React, { useEffect, useState } from "react";
import QRCode from "qrcode";

interface Props {
  invoice: any;
  onClose: () => void;
  onSimulatePay: () => void;
  isPaid: boolean;
}

export function CustomerCheckoutModal({ invoice, onClose, onSimulatePay, isPaid }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(15 * 60);

  const amountSats = invoice?.amountSats ? Number(invoice.amountSats) : 50000;
  const usdValue = ((amountSats * 95000) / 100000000).toFixed(2);
  const regtestVaultAddress = "bcrt1p4m2ttqsx8veyvh62ezehxf9y2732yyymve4qvr76qw7ue5ttu66qppnr0q";
  const btcAmount = (amountSats / 100000000).toFixed(8);
  const bip21Uri = `bitcoin:${regtestVaultAddress}?amount=${btcAmount}&label=SatsLoom&message=${invoice?.id ?? ""}`;

  useEffect(() => {
    QRCode.toDataURL(bip21Uri, {
      width: 260,
      margin: 2,
      color: {
        dark: "#0a0f17",
        light: "#ffffff",
      },
    })
      .then(setQrDataUrl)
      .catch((err) => console.error("QR generation failed", err));
  }, [bip21Uri]);

  // Countdown timer
  useEffect(() => {
    if (isPaid) return;
    const interval = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [isPaid]);

  const copyUri = () => {
    navigator.clipboard.writeText(bip21Uri);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const timeFormatted = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content checkout-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="checkout-brand">
            <span className="bitcoin-logo">₿</span>
            <div>
              <h3>Pay with Tachi Sats</h3>
              <p className="checkout-subtitle">Self-Custodial Native BTC Settlement</p>
            </div>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Close modal">
            ✕
          </button>
        </div>

        {isPaid ? (
          <div className="checkout-success-view">
            <div className="success-icon-wrap">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#10b981" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M7 13l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2>Payment Confirmed!</h2>
            <p className="success-amount">
              <strong>{amountSats.toLocaleString()} sats</strong> received off-chain
            </p>
            <div className="success-badge">VTXO Settle Ready • Verified on Tachi</div>
            <div className="invoice-meta-box">
              <div>Invoice: <code>{invoice?.id?.slice(0, 12)}...</code></div>
              <div>Network: <strong>Tachi Regtest / TAURUS</strong></div>
              <div>Status: <strong>SETTLED</strong></div>
            </div>
            <button className="btn-primary full-width" onClick={onClose}>
              Done / Return to Merchant
            </button>
          </div>
        ) : (
          <div className="checkout-body">
            <div className="amount-banner">
              <div className="sats-display">
                <span className="amount-number">{amountSats.toLocaleString()}</span>
                <span className="sats-label">SATS</span>
              </div>
              <div className="usd-equivalent">≈ ${usdValue} USD</div>
            </div>

            <div className="qr-container">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="BIP21 QR Code" className="qr-image" />
              ) : (
                <div className="qr-placeholder">Generating QR code...</div>
              )}
              <div className="timer-badge">
                <span className="pulse-dot"></span>
                <span>Expires in {timeFormatted}</span>
              </div>
            </div>

            <div className="uri-copy-row">
              <input readOnly value={regtestVaultAddress} className="uri-input" />
              <button className="copy-btn" onClick={copyUri} title="Copy Bitcoin address">
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </div>

            <p className="checkout-memo">
              <strong>Memo:</strong> {invoice?.memo || "SatsLoom Invoice"}
            </p>

            <div className="checkout-simulation-banner">
              <div className="banner-info">
                <span>Demo Environment:</span> Click to trigger instant simulated payment
              </div>
              <button className="btn-pay-simulate" onClick={onSimulatePay}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>Pay {amountSats.toLocaleString()} Sats Now</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
