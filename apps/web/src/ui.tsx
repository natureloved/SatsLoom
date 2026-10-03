/**
 * Shared UI atoms.
 *
 * The one rule that matters here: nothing in the UI may render a value as if it were live unless
 * the envelope that carried it said `mode: "live"`. `StatusPill` and `ModeBanner` are the only
 * places that decide how that looks, so the distinction cannot drift between screens.
 */
import type { ReactNode } from "react";
import type { Envelope } from "./api";

export function ModePill({ mode }: { mode: string }) {
  const label = mode === "live" ? "LIVE · regtest" : mode === "fixture" ? "FIXTURE LEDGER" : "DEGRADED";
  const title =
    mode === "live"
      ? "Every value on this screen came from the Tachi daemon."
      : mode === "fixture"
        ? "An in-process ledger is answering. Signatures are real; the daemon is not. Nothing here is a live network result."
        : "The Tachi daemon is unreachable. Nothing is being simulated to fill the gap.";
  return (
    <span className={`pill ${mode}`} title={title}>
      <span className="dot" />
      {label}
    </span>
  );
}

export function Panel({ title, hint, children, actions }: { title?: string; hint?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div className="spread" style={{ marginBottom: hint ? 4 : 12 }}>
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, gold }: { label: string; value: ReactNode; sub?: ReactNode; gold?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className={`v${gold ? " gold" : ""}`}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status ${status}`}>{status}</span>;
}

export function TxLink({ txid, explorerUrl }: { txid?: string; explorerUrl?: string }) {
  if (!txid) return <span className="dim">—</span>;
  const short = `${txid.slice(0, 10)}…${txid.slice(-6)}`;
  return explorerUrl ? (
    <a href={explorerUrl} target="_blank" rel="noreferrer" className="mono small" title={txid}>
      {short} ↗
    </a>
  ) : (
    <span className="mono small" title={txid}>
      {short}
    </span>
  );
}

export function Copy({ value, label }: { value: string; label?: string }) {
  return (
    <button
      className="small ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
      }}
      title={`Copy ${value}`}
    >
      {label ?? "Copy"}
    </button>
  );
}

export function ErrorNote({ error }: { error: { message: string; code?: string } | null }) {
  if (!error) return null;
  return (
    <div className="banner red">
      <strong className="mono small">{error.code ?? "error"}</strong>
      <span>{error.message}</span>
    </div>
  );
}

/** Renders the honest-mode banner whenever the envelope is not live. */
export function ModeBanner({ envelope, what }: { envelope: Envelope<unknown> | null; what?: string }) {
  if (!envelope) return null;
  if (envelope.mode === "live") {
    return (
      <div className="banner gold">
        <strong>LIVE</strong>
        <span>
          {what ?? "This screen"} is reading the Tachi regtest daemon at {envelope.daemon?.network ?? "regtest"}
          {envelope.daemon?.version ? ` (v${envelope.daemon.version})` : ""}. Every settlement below is a real ledger transaction.
        </span>
      </div>
    );
  }
  if (envelope.mode === "fixture") {
    return (
      <div className="banner blue">
        <strong>FIXTURE</strong>
        <span>
          An in-process ledger is answering because <code>TACHI_PROVIDER=fixture</code>. Key derivation, BIP-340 signing, transaction
          encoding and webhook signatures are the real implementations; the ledger is not. Set <code>TACHI_PROVIDER=live</code> (and a
          merchant mnemonic) to run against regtest.
        </span>
      </div>
    );
  }
  return (
    <div className="banner amber">
      <strong>DEGRADED</strong>
      <span>
        {envelope.daemon?.detail ?? "The Tachi daemon is unreachable."} Nothing is being simulated to fill the gap, so invoices cannot be
        created and payments cannot be detected until it returns.
      </span>
    </div>
  );
}

export function ActivityFeed({ items }: { items: { id: string; kind: string; message: string; at: string; explorerUrl?: string }[] }) {
  if (items.length === 0) return <p className="dim small">No activity yet.</p>;
  return (
    <div className="feed">
      {items.map((item) => (
        <div className="item" key={item.id}>
          <span className="kind">{item.kind}</span>
          <span className="msg">
            {item.message}
            {item.explorerUrl && (
              <>
                {" "}
                <a href={item.explorerUrl} target="_blank" rel="noreferrer" className="tiny">
                  proof ↗
                </a>
              </>
            )}
          </span>
          <span className="when">{new Date(item.at).toLocaleTimeString()}</span>
        </div>
      ))}
    </div>
  );
}
