/**
 * Pay-to-vault checkout: an invoice paid with BTC (signet) into the merchant's
 * Tachi vault, instead of over Lightning.
 *
 * The customer pays the invoice amount in L1 BTC to the merchant vault's P2TR
 * address; the API watches the address, registers the deposit as a VTXO
 * (TxVaultOpen), and marks the invoice paid. No quorum cosign is involved —
 * a deposit is a plain Bitcoin transaction the customer's wallet signs alone —
 * so this is the settlement rail that works today. The honest claim is
 * "payment settles into the merchant's Tachi vault", never a Tachi transfer
 * to a third party.
 *
 * Creating the payment intent is an operator action (admin token, like the
 * fund flow): it starts the background watcher on the API. The customer side
 * needs nothing but the address and the amount. Every transaction links out:
 * the L1 deposit to mempool.space (the Tachi explorer does not index L1
 * Bitcoin transactions, so its link renders an empty page for them) and the
 * registration to the Tachi Explorer.
 */
import React, { useEffect, useRef, useState } from "react";

type PayVaultPayment = {
  id: string;
  invoiceId: string;
  amountSats: string;
  vaultAddress: string;
  status: "watching" | "paid" | "failed";
  stage: string;
  deposit: { txid: string; explorerUrl: string; bitcoinExplorerUrl?: string; amountSats?: string } | null;
  registration: { broadcastHash: string; explorerUrl: string; vtxoId: string; feeSats: string } | null;
  error: string | null;
};

type Props = {
  /** Fired once, when a payment settles — the parent shows the toast with the link. */
  onPaid?: (label: string, url: string) => void;
};

export function PayVaultCheckout({ onPaid }: Props) {
  const [amount, setAmount] = useState("10000");
  const [memo, setMemo] = useState("SatsLoom pay-to-vault invoice");
  const [adminToken, setAdminToken] = useState("");
  const [payment, setPayment] = useState<PayVaultPayment | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const notifiedRef = useRef<string | null>(null);

  // Poll the payment while it is being watched. Signet blocks average
  // ~10 minutes, so a settlement takes a while; the payment record is the
  // source of truth, not this view.
  useEffect(() => {
    if (!payment || !invoiceId || payment.status !== "watching") return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/tachi/invoices/${encodeURIComponent(invoiceId)}/pay-vault/${encodeURIComponent(payment.id)}`);
        const body = await response.json().catch(() => ({}));
        if (response.ok && body.data) setPayment(body.data);
      } catch {
        // Polling is best-effort; a failed poll leaves the last known state.
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [payment?.id, payment?.status, invoiceId]);

  // Fire the toast once, when a payment settles — with the registration link.
  useEffect(() => {
    if (payment?.status === "paid" && payment.registration && notifiedRef.current !== payment.id) {
      notifiedRef.current = payment.id;
      onPaid?.("Invoice paid into the merchant vault — VTXO registered. Verify on the Tachi Explorer:", payment.registration.explorerUrl);
    }
  }, [payment, onPaid]);

  const startPayment = async () => {
    setError("");
    setBusy(true);
    try {
      const amountSats = Number(amount);
      if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw new Error("Enter a positive amount in sats.");
      // A demo invoice first: the pay-vault intent attaches to it.
      const invoiceRes = await fetch("/api/invoices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountSats, memo: memo.trim() || undefined }),
      });
      const invoiceBody = await invoiceRes.json().catch(() => ({}));
      if (!invoiceRes.ok) throw new Error(invoiceBody.error ?? invoiceBody.data?.error ?? `Invoice creation failed (${invoiceRes.status})`);
      const createdInvoiceId = invoiceBody.data.id as string;
      setInvoiceId(createdInvoiceId);
      const res = await fetch(`/api/tachi/invoices/${encodeURIComponent(createdInvoiceId)}/pay-vault`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
        },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? body.data?.error ?? `Pay-to-vault request failed (${res.status})`);
      notifiedRef.current = null;
      setPayment(body.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied((current) => (current === label ? null : current)), 2000);
    } catch {
      // Clipboard unavailable; the value is still shown in full.
    }
  };

  const watching = payment !== null && payment.status === "watching";

  return (
    <div className="live-panel panel rv d1" style={{ marginTop: 16 }}>
      <div className="live-panel-head">
        <span className="live-tag"><i></i>BTC SIGNET</span>
        <span className="live-net">Tachi vault · no Lightning node needed</span>
      </div>

      <div className="live-form">
        <label className="live-field">
          <span>Amount (sats)</span>
          <input
            type="number"
            min="1"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ""))}
            aria-label="Amount in satoshis"
            disabled={watching}
          />
        </label>
        <label className="live-field grow">
          <span>Memo</span>
          <input
            type="text"
            maxLength={200}
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            aria-label="Invoice memo"
            disabled={watching}
          />
        </label>
        <button
          className="live-go"
          disabled={busy || watching || !amount || Number(amount) <= 0}
          onClick={() => { void startPayment(); }}
        >
          {busy ? "Starting…" : watching ? "Waiting for payment…" : "Pay with BTC (signet)"}
        </button>
      </div>

      <div className="live-notes">
        <span>Pay the exact amount in L1 BTC to the merchant vault address below — any signet wallet works.</span>
        <span>The merchant's funds land in Tachi as a VTXO. Test coins only — they have no fiat value.</span>
      </div>

      <details className="live-howto">
        <summary>
          How settlement works <span>no cosign, no Lightning →</span>
        </summary>
        <ol className="live-steps">
          <li>
            <b>Pay the vault address.</b> Send exactly the invoice amount to the merchant's Tachi vault P2TR address shown below. A deposit is a plain Bitcoin transaction your wallet signs alone.
          </li>
          <li>
            <b>The API watches and registers.</b> Once a block confirms the deposit, the API registers it as a VTXO (TxVaultOpen) and marks the invoice paid — usually within one signet block (~10 minutes).
          </li>
          <li>
            <b>Verify every transaction.</b> The deposit links to mempool.space and the registration links to the Tachi Explorer. This settles <em>into</em> the merchant's vault; it is not a Tachi transfer to a third party, which would need 5-of-7 quorum cosignatures the SDK does not expose.
          </li>
        </ol>
      </details>

      <div className="live-form" style={{ marginTop: 12 }}>
        <label className="live-field grow">
          <span>Admin token (starts the watcher — never stored)</span>
          <input
            type="password"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            placeholder="SATSLOOM_ADMIN_TOKEN"
            autoComplete="off"
            aria-label="Admin token"
          />
        </label>
      </div>

      {error && <div className="live-error" role="status">{error}</div>}

      {payment && (
        <div className="p2tr-details-box" style={{ marginTop: 12 }}>
          <div className="detail-item">
            <span>Merchant vault:</span>
            <span>
              <code>{payment.vaultAddress}</code>{" "}
              <button type="button" onClick={() => { void copy("vault", payment.vaultAddress); }}>
                {copied === "vault" ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
          <div className="detail-item">
            <span>Pay exactly:</span>
            <span>
              <code>{payment.amountSats} sats</code>{" "}
              <button type="button" onClick={() => { void copy("amount", payment.amountSats); }}>
                {copied === "amount" ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
          <div className="detail-item">
            <span>Status:</span>
            <code>{payment.status} · {payment.stage}</code>
          </div>
          {payment.deposit && (
            <div className="detail-item">
              <span>Deposit:</span>
              <span>
                {payment.deposit.bitcoinExplorerUrl ? (
                  <a href={payment.deposit.bitcoinExplorerUrl} target="_blank" rel="noreferrer">{payment.deposit.txid.slice(0, 16)}… ↗</a>
                ) : (
                  <a href={payment.deposit.explorerUrl} target="_blank" rel="noreferrer">{payment.deposit.txid.slice(0, 16)}… ↗</a>
                )}
                {` · ${payment.deposit.amountSats ?? payment.amountSats} sats`}
              </span>
            </div>
          )}
          {payment.registration && (
            <div className="detail-item">
              <span>VTXO registration:</span>
              <span>
                <a href={payment.registration.explorerUrl} target="_blank" rel="noreferrer">{payment.registration.broadcastHash.slice(0, 16)}… ↗</a>
                {` · VTXO ${payment.registration.vtxoId.slice(0, 16)}… · fee ${payment.registration.feeSats} sats`}
              </span>
            </div>
          )}
          {payment.error && (
            <div className="detail-item">
              <span>Error:</span>
              <code>{payment.error}</code>
            </div>
          )}
          {payment.status === "paid" && (
            <div className="detail-item">
              <span>Result:</span>
              <span>Invoice paid — the merchant holds a VTXO for {payment.amountSats} sats. Verify both transactions via the links above.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
