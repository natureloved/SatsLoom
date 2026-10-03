/**
 * Merchant dashboard, customer pay page, liquidity transparency, policy editor and plugin docs.
 *
 * Numbers come from the API as strings (bigint-safe JSON); every operator-facing figure is
 * formatted here so sats never render as a JS float.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError, type DeliveryView, type Envelope, type Evaluation, type InvoiceView, type PolicyView, type ProviderView, type RouteView, type SettlementView, type SummaryView } from "./api";
import { ActivityFeed, Copy, ErrorNote, ModeBanner, ModePill, Panel, Stat, StatusBadge, TxLink } from "./ui";

const SATS = 100_000_000n;
function group(value: string | number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function btc(sats: string): string {
  try {
    const value = BigInt(sats);
    const whole = value / SATS;
    const frac = (value % SATS).toString().padStart(8, "0").replace(/0+$/, "");
    return `${whole}${frac ? `.${frac}` : ""} BTC`;
  } catch {
    return "—";
  }
}
function ago(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function useApi<T>(path: string | null, pollMs?: number): { data: T | null; envelope: Envelope<T> | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [envelope, setEnvelope] = useState<Envelope<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.get<T>(path);
        if (cancelled) return;
        setData(response.data);
        setEnvelope(response);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
      }
    };
    void load();
    if (!pollMs) return () => { cancelled = true; };
    const timer = setInterval(load, pollMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [path, pollMs, tick]);

  return { data, envelope, error, reload: () => setTick((value) => value + 1) };
}

/* ============================================================== Dashboard */

export function Dashboard({ navigate }: { navigate: (to: string) => void }) {
  const summary = useApi<SummaryView>("/api/dashboard/summary", 4000);
  const invoices = useApi<InvoiceView[]>("/api/invoices", 4000);
  const [amount, setAmount] = useState("50000");
  const [memo, setMemo] = useState("Demo order #1");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      setToast(`${label} — done`);
      summary.reload();
      invoices.reload();
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: String(err) });
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 3000);
    }
  };

  const createInvoice = () =>
    act("Create invoice", async () => {
      const response = await api.post<InvoiceView>("/api/invoices", { amountSats: amount, memo });
      navigate(`#/pay/${response.data.id}`);
    });

  const list = invoices.data ?? [];
  const mode = summary.envelope?.mode ?? invoices.envelope?.mode ?? "degraded";

  return (
    <div className="stack">
      <ModeBanner envelope={summary.envelope} what="This dashboard" />
      {error && <ErrorNote error={error} />}

      <div className="grid c4">
        <Stat
          label="Off-chain (VTXO)"
          value={summary.data ? group(summary.data.balance.offchainSats) : "—"}
          sub={summary.data ? btc(summary.data.balance.offchainSats) : "sats on the Tachi ledger"}
          gold
        />
        <Stat
          label="On-chain"
          value={summary.data?.balance.onchainSats != null ? group(summary.data.balance.onchainSats) : "unknown"}
          sub={summary.data?.balance.note ?? "read through the node's RPC proxy"}
        />
        <Stat label="Confirmed volume" value={summary.data ? group(summary.data.totals.confirmedSats) : "—"} sub="all time, this process" />
        <Stat
          label="Invoices"
          value={summary.data ? String(summary.data.counts.confirmed) + " / " + String(Object.values(summary.data.counts).reduce((a, b) => a + b, 0)) : "—"}
          sub="confirmed / total"
        />
      </div>

      <div className="grid c2">
        <Panel
          title="New invoice"
          hint="Creates a real payment request against your Tachi account address. The customer pays that address; the ledger is the only thing that can confirm it."
        >
          <div className="field">
            <label>Amount (sats)</label>
            <input value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" />
          </div>
          <div className="field">
            <label>Memo</label>
            <input value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={120} />
          </div>
          <button className="primary" onClick={createInvoice} disabled={busy !== null || amount === "0" || amount === ""}>
            {busy === "Create invoice" ? <span className="spinner" /> : null} Create invoice &amp; open pay page
          </button>
        </Panel>

        <Panel title="Checkout" hint="Fund the merchant account and the demo payer, then run one payment end to end. Every step below is a real ledger transaction.">
          <div className="row wrap">
            <button className="small" disabled={busy !== null} onClick={() => act("Fund merchant", () => api.post("/api/demo/fund-merchant", { amountSats: "500000" }))}>
              Fund merchant
            </button>
            <button className="small" disabled={busy !== null} onClick={() => act("Fund payer", () => api.post("/api/demo/onboard-payer", { amountSats: "500000" }))}>
              Fund demo payer
            </button>
          </div>
          <p className="hint mt">
            The payer is a second account SatsLoom controls, holding its own mnemonic server-side. Clicking <em>Pay with demo wallet</em> on a
            pay page sends a real VTXO transfer from it, which is exactly what a third-party customer's wallet would do.
          </p>
          {summary.data?.payoutAddress && (
            <p className="small muted">
              Payout address: <span className="mono">{summary.data.payoutAddress}</span>
            </p>
          )}
        </Panel>
      </div>

      <Panel title="Invoices" actions={<span className="dim small">auto-refreshing every 4s</span>}>
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th className="num">Amount</th>
              <th>Memo</th>
              <th>Status</th>
              <th>Age</th>
              <th>Proof</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={7} className="dim small">
                  No invoices yet — create one above.
                </td>
              </tr>
            )}
            {list.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <a href={`#/pay/${invoice.id}`} className="mono small">
                    {invoice.id.slice(0, 8)}
                  </a>
                </td>
                <td className="num">{group(invoice.amountSats)}</td>
                <td className="small muted">{invoice.memo ?? "—"}</td>
                <td>
                  <StatusBadge status={invoice.status} />
                </td>
                <td className="small dim">{ago(invoice.createdAt)}</td>
                <td>
                  <TxLink txid={invoice.proof?.txid} explorerUrl={invoice.proof?.explorerUrl} />
                </td>
                <td className="right">
                  {(invoice.status === "confirmed" || invoice.status === "refunded") && (
                    <button
                      className="small ghost"
                      disabled={busy !== null || invoice.status === "refunded"}
                      onClick={() => act("Refund", () => api.post(`/api/invoices/${invoice.id}/refund`, { reason: "merchant-initiated refund" }))}
                    >
                      Refund
                    </button>
                  )}
                  {invoice.status === "confirmed" && (
                    <button
                      className="small ghost"
                      disabled={busy !== null}
                      onClick={() => act("Settle", () => api.post(`/api/invoices/${invoice.id}/settle`))}
                      title="Move the confirmed value along the selected route"
                    >
                      Settle
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="grid c2">
        <Panel title="Activity" hint="Append-only. Every confirmed payment, refund, payout and route change lands here with its proof link.">
          <ActivityFeed items={summary.data?.recentActivity ?? []} />
        </Panel>
        <Panel title="Payout" hint="Sweep confirmed value to cold storage, either as a ledger transfer or as an on-chain redemption that leaves the ledger entirely.">
          <PayoutForm onDone={() => { summary.reload(); invoices.reload(); }} />
        </Panel>
      </div>

      <div className="row">
        <span className="dim small">Daemon</span>
        <ModePill mode={mode} />
        <span className="dim small">{summary.envelope?.daemon?.detail}</span>
      </div>
      {toast && <div className="toast banner gold">{toast}</div>}
    </div>
  );
}

function PayoutForm({ onDone }: { onDone: () => void }) {
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("10000");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<{ payoutAddress: string | null }>("/api/merchant")
      .then((response) => setDestination((current) => current || response.data.payoutAddress || ""))
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ txid: string; explorerUrl: string; kind: string }>("/api/payouts", { toAddress: destination, amountSats: amount });
      setResult(`${response.data.kind} · ${response.data.txid.slice(0, 16)}…`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <ErrorNote error={error} />}
      <div className="field">
        <label>Destination (Taproot address for an on-chain sweep, or a 64-hex ledger key)</label>
        <input value={destination} onChange={(event) => setDestination(event.target.value.trim())} placeholder="bcrt1p… or 32-byte x-only key" />
      </div>
      <div className="field">
        <label>Amount (sats)</label>
        <input value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" />
      </div>
      <button className="primary" disabled={busy || !destination || !amount} onClick={submit}>
        {busy ? <span className="spinner" /> : null} Sweep
      </button>
      {result && <p className="small success mt mono">{result}</p>}
    </div>
  );
}

/* ============================================================== Pay page */

export function PayPage({ id }: { id: string }) {
  const [invoice, setInvoice] = useState<(InvoiceView & { proof?: InvoiceView["proof"] }) | null>(null);
  const [envelope, setEnvelope] = useState<Envelope<InvoiceView> | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [flash, setFlash] = useState(false);
  const previousStatus = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get<InvoiceView>(`/api/pay/${id}`);
      setInvoice(response.data);
      setEnvelope(response);
      setError(null);
      if (previousStatus.current && previousStatus.current !== response.data.status && response.data.status === "confirmed") setFlash(true);
      previousStatus.current = response.data.status;
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: String(err) });
    }
  }, [id]);

  useEffect(() => {
    void load();
    // 2s polling is the specification: fast enough to feel live, slow enough not to hammer the API.
    const timer = setInterval(load, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); clearInterval(clock); };
  }, [load]);

  useEffect(() => {
    if (!invoice?.paymentTarget?.address) return;
    // A wallet scans a URI, so the QR encodes bitcoin:<address>?amount=<btc>. The amount is
    // converted with BigInt so no float rounding ever reaches the customer's wallet.
    const amountBtc = (() => {
      try {
        const value = BigInt(invoice.amountSats);
        return `${value / SATS}.${(value % SATS).toString().padStart(8, "0")}`;
      } catch {
        return "0";
      }
    })();
    void QRCode.toDataURL(`bitcoin:${invoice.paymentTarget.address}?amount=${amountBtc}&label=SatsLoom`, {
      margin: 1,
      width: 420,
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).then(setQr).catch(() => setQr(null));
  }, [invoice?.paymentTarget?.address, invoice?.amountSats]);

  const remaining = invoice ? Math.max(0, Math.floor((Date.parse(invoice.expiresAt) - now) / 1000)) : 0;
  const expired = invoice ? remaining <= 0 && invoice.status === "created" : false;
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;

  const pay = async () => {
    setPaying(true);
    setError(null);
    try {
      await api.post(`/api/demo/pay-invoice/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: String(err) });
    } finally {
      setPaying(false);
    }
  };

  if (error && !invoice) {
    return (
      <div className="pay">
        <ErrorNote error={error} />
      </div>
    );
  }
  if (!invoice) {
    return (
      <div className="pay center">
        <span className="spinner" />
      </div>
    );
  }

  const confirmed = invoice.status === "confirmed" || invoice.status === "refunded";

  return (
    <div className="pay">
      <div className="spread" style={{ marginBottom: 14 }}>
        <span className="small muted">Pay with native sats</span>
        <ModePill mode={envelope?.mode ?? "degraded"} />
      </div>

      <div className="amount">
        {group(invoice.amountSats)} <small>sats</small>
      </div>
      <div className="btc">{btc(invoice.amountSats)}</div>
      {invoice.memo && <p className="center muted small">{invoice.memo}</p>}

      {confirmed ? (
        <div className="center mt">
          <div style={{ fontSize: 44 }} className="success">
            ✓
          </div>
          <h2 className="success">Payment confirmed</h2>
          <p className="small muted">
            Observed on the ledger{invoice.proof?.confirmations ? ` with ${invoice.proof.confirmations} confirmation` : ""}. This is not a
            receipt from us — check it yourself:
          </p>
          <a href={invoice.proof?.explorerUrl ?? "#"} target="_blank" rel="noreferrer" className="mono small">
            {invoice.proof?.txid}
          </a>
          {flash && <p className="tiny dim mt">Status changed while this page was open.</p>}
        </div>
      ) : (
        <>
          <div className="qr">{qr ? <img src={qr} alt="Payment address QR code" /> : <span className="dim small">QR unavailable</span>}</div>
          <div className="addr">
            {invoice.paymentTarget?.address}
            <div className="row" style={{ marginTop: 8 }}>
              <Copy value={invoice.paymentTarget?.address ?? ""} label="Copy address" />
              <span className="tiny dim" title="Advanced: the ledger credits a 32-byte x-only owner key. The address is the Taproot form of it.">
                owner key {invoice.paymentTarget?.owner.slice(0, 12)}…
              </span>
            </div>
          </div>

          <div className="spread mt">
            <span className="small muted">{invoice.status === "pending" ? "Payment seen, awaiting the epoch" : "Awaiting payment"}</span>
            <span className="countdown">{expired ? "expired" : `${mm}:${String(ss).padStart(2, "0")}`}</span>
          </div>

          {invoice.status === "pending" && (
            <div className="banner amber mt">
              <span className="spinner" />
              <span>The transfer is in the mempool. It becomes confirmed when the next Tachi epoch commits it.</span>
            </div>
          )}
          {expired && <div className="banner red mt">This payment request expired. Create a new one to continue.</div>}

          <div className="mt">
            <button className="primary" style={{ width: "100%" }} onClick={pay} disabled={paying || invoice.status !== "created"}>
              {paying ? <span className="spinner" /> : null} Pay with demo wallet
            </button>
            <p className="tiny dim mt center">
              Sends a real off-chain VTXO transfer from a second funded account. A customer would scan the QR instead — or pay the address
              from any Tachi-enabled wallet.
            </p>
          </div>
        </>
      )}

      <div className="mt" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
        <div className="spread">
          <span className="tiny dim mono">invoice {invoice.id.slice(0, 8)}</span>
          <span className="tiny dim">expires {new Date(invoice.expiresAt).toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================== Routes / liquidity */

const RISK_TITLE: Record<string, string> = {
  none: "Self-custody: the funds are already yours. No third party has to stay honest.",
  low: "A provider co-signs. If it stops responding your fallback is an on-chain exit, which costs time.",
  medium: "Needs a cooperative signature for the quoted speed; fallback is an on-chain exit.",
  high: "Settles on the base chain. Nothing can censor it, but you wait for blocks.",
};

export function RoutesPage() {
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const invoices = useApi<InvoiceView[]>("/api/invoices", 8000);
  const directory = useApi<{ providers: ProviderView[]; decisionLog: { at: string; kind: string; reason: string; invoiceId: string }[] }>("/api/routes/liquidity", 5000);
  const routes = useApi<{ routes: RouteView[] } & Record<string, unknown>>(invoiceId ? `/api/invoices/${invoiceId}/routes` : null, 5000);
  const settlement = useApi<SettlementView | null>(invoiceId ? `/api/invoices/${invoiceId}/settlement` : null, 3000);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!invoiceId && invoices.data?.length) setInvoiceId(invoices.data[0].id);
  }, [invoices.data, invoiceId]);

  const evaluations = (routes.envelope?.evaluations as Evaluation[] | undefined) ?? [];
  const winnerId = evaluations.find((evaluation) => evaluation.rank === 1)?.route.id;
  const display = evaluations.length
    ? [...evaluations].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.route.id.localeCompare(b.route.id))
    : (routes.data?.routes ?? []).map((route) => ({ route, score: null, rank: null, eligible: route.available, explanation: route.unavailableReason ?? "", timelock: { friendly: "—", advanced: "—" }, feeBps: 0 }) as Evaluation);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      routes.reload();
      settlement.reload();
      directory.reload();
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, code: err.code } : { message: String(err) });
    } finally {
      setBusy(null);
    }
  };

  const killBest = () =>
    act("Kill best route", async () => {
      await api.post(`/api/invoices/${invoiceId}/invalidate-best-route`, {});
      await api.post(`/api/invoices/${invoiceId}/settle`);
    });

  return (
    <div className="stack">
      {error && <ErrorNote error={error} />}

      <Panel
        title="Liquidity directory"
        hint="Every settlement source SatsLoom can see right now, evaluated live. Capacity is read from the ledger, not from a config file."
        actions={<span className="dim small">refreshed {directory.envelope?.daemon?.checkedAt ? ago(directory.envelope.daemon.checkedAt) : "…"} ago</span>}
      >
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Kind</th>
              <th className="num">Capacity</th>
              <th className="num">Fee</th>
              <th>Timing</th>
              <th>Exit risk</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(directory.data?.providers ?? []).map((provider) => (
              <tr key={provider.id}>
                <td>
                  <div>{provider.name}</div>
                  {provider.detail && <div className="tiny dim">{provider.detail}</div>}
                </td>
                <td className="small muted mono">{provider.kind}</td>
                <td className="num">{group(provider.capacitySats)}</td>
                <td className="num">
                  {group(provider.feeSats)}
                  {provider.feeBps > 0 && <div className="tiny dim">{provider.feeBps} bps</div>}
                </td>
                <td className="small">
                  {provider.timelock.friendly}
                  {advanced && <div className="tiny dim mono">{provider.timelock.advanced}</div>}
                </td>
                <td className="small" title={RISK_TITLE[provider.exitRisk]}>
                  {provider.exitRisk}
                </td>
                <td>
                  <span className={`pill ${provider.status === "live" ? "live" : provider.status === "degraded" ? "degraded" : ""}`}>
                    <span className="dot" />
                    {provider.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Route selection"
        hint="Deterministic scoring: fee, latency, exit risk and liquidity pressure, weighted by the merchant's policy. Same inputs, same choice — try it twice."
        actions={
          <div className="row">
            <label style={{ margin: 0 }} className="tiny dim">
              <input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} style={{ width: "auto", marginRight: 6 }} />
              Advanced (show CSV blocks)
            </label>
            <select value={invoiceId ?? ""} onChange={(event) => setInvoiceId(event.target.value)} style={{ width: "auto" }}>
              {(invoices.data ?? []).map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.id.slice(0, 8)} · {group(invoice.amountSats)} sats · {invoice.status}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {!invoiceId && <p className="dim small">Create an invoice first — routes are quoted per invoice, because eligibility depends on the amount.</p>}
        {invoiceId && (
          <>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Route</th>
                  <th className="num">Fee</th>
                  <th className="num">Settle in</th>
                  <th className="num">Capacity</th>
                  <th>Risk</th>
                  <th className="num">Score</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {display.map((evaluation) => (
                  <tr key={evaluation.route.id} className={evaluation.eligible ? "" : "route-dead"}>
                    <td className="rank">{evaluation.rank ?? <span className="dim">—</span>}</td>
                    <td>
                      <div className={evaluation.route.id === winnerId ? "gold mono small" : "mono small"}>{evaluation.route.provider ?? evaluation.route.id}</div>
                      <div className="tiny dim">{evaluation.route.source}</div>
                    </td>
                    <td className="num">{group(evaluation.route.feeSats)}</td>
                    <td className="num small">{evaluation.timelock.friendly}</td>
                    <td className="num">{group(evaluation.route.capacitySats)}</td>
                    <td className="small">{evaluation.route.exitRisk}</td>
                    <td className="num">{evaluation.score === null ? "—" : evaluation.score.toFixed(4)}</td>
                    <td className="small">
                      {evaluation.eligible ? (
                        evaluation.rank === 1 ? (
                          <span className="gold">selected</span>
                        ) : (
                          <span className="dim">eligible</span>
                        )
                      ) : (
                        <span className="muted" title={evaluation.explanation}>
                          {evaluation.reason}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {advanced && (
              <div className="mt">
                {display.map((evaluation) => (
                  <div key={evaluation.route.id} className="tiny dim mono">
                    {evaluation.route.id}: {evaluation.timelock.advanced}
                  </div>
                ))}
              </div>
            )}

            <div className="banner gold mt">
              <strong>Why this route</strong>
              <span className="reason">{evaluations.find((evaluation) => evaluation.rank === 1)?.explanation ?? "Select a route to publish a decision reason."}</span>
            </div>

            <div className="row wrap mt">
              <button className="small" disabled={busy !== null} onClick={() => act("Select route", () => api.post(`/api/invoices/${invoiceId}/select-route`))}>
                Select route
              </button>
              <button className="small" disabled={busy !== null} onClick={() => act("Re-quote", () => api.get(`/api/invoices/${invoiceId}/routes?refresh=1`))}>
                Re-quote
              </button>
              <button className="small danger" disabled={busy !== null} onClick={killBest} title="Invalidate the currently selected route, then settle so the router has to fall back">
                {busy === "Kill best route" ? <span className="spinner" /> : null} Kill best route → auto-fallback
              </button>
              <button className="small primary" disabled={busy !== null} onClick={() => act("Settle", () => api.post(`/api/invoices/${invoiceId}/settle`))}>
                Settle
              </button>
            </div>

            {settlement.data && (
              <div className="mt panel" style={{ background: "var(--bg)" }}>
                <div className="spread">
                  <span className="small muted">Settlement</span>
                  <StatusBadge status={settlement.data.status} />
                </div>
                <div className="small mono mt">
                  route: {settlement.data.routeId}
                  {settlement.data.fallbackFrom && (
                    <>
                      {" "}
                      <span className="gold">(fell back from {settlement.data.fallbackFrom})</span>
                    </>
                  )}
                </div>
                <div className="small mt">
                  tx <TxLink txid={settlement.data.txid} explorerUrl={settlement.data.explorerUrl} />
                </div>
                {settlement.data.error && <div className="small red mt">{settlement.data.error}</div>}
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel title="Decision log" hint="Every decision, fallback and invalidation the router made, in order.">
        {(directory.data?.decisionLog ?? []).length === 0 && <p className="dim small">No decisions yet.</p>}
        <div className="feed">
          {(directory.data?.decisionLog ?? []).map((entry, index) => (
            <div className="item" key={`${entry.at}-${index}`}>
              <span className="kind">{entry.kind}</span>
              <span className="msg small">{entry.reason}</span>
              <span className="when">{new Date(entry.at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================== Settings / policy */

export function SettingsPage() {
  const policy = useApi<PolicyView>("/api/policy", 0);
  const capabilities = useApi<{ capabilities: { id: string; label: string; ok: boolean; mode: string; detail?: string; remediation?: string }[]; mode: string; daemon: { baseUrl: string; reachable: boolean } }>("/api/tachi/capabilities", 10000);
  const [draft, setDraft] = useState<PolicyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (policy.data && !draft) setDraft(policy.data);
  }, [policy.data, draft]);

  const total = draft ? draft.feeWeight + draft.latencyWeight + draft.exitRiskWeight + draft.liquidityPenalty : 0;

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await api.post("/api/policy", draft);
      policy.reload();
      setMessage("Policy saved. Re-quote an invoice on the Routes page to see the weights change the winner.");
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const sliders: { key: keyof PolicyView; label: string; hint: string }[] = [
    { key: "feeWeight", label: "Fee weight", hint: "How much a sat of fee costs you relative to the other factors." },
    { key: "latencyWeight", label: "Latency weight", hint: "How impatient you are. High values favour the fastest route even when it costs more." },
    { key: "exitRiskWeight", label: "Exit risk weight", hint: "How much you care about needing an on-chain exit if a counterparty stops responding." },
    { key: "liquidityPenalty", label: "Liquidity pressure", hint: "Penalises routes whose capacity is barely larger than the invoice." },
  ];

  return (
    <div className="stack">
      <Panel
        title="Settlement policy"
        hint="Weights only change which route is chosen — never whether a payment is real. Change one, then re-quote an invoice and watch the winner move. Set them back and the original route returns, bit for bit."
        actions={
          <button className="primary small" onClick={save} disabled={busy || !draft}>
            {busy ? <span className="spinner" /> : null} Save policy
          </button>
        }
      >
        {message && <div className="banner gold">{message}</div>}
        {draft && (
          <div className="weights mt">
            {sliders.map((slider) => (
              <div className="weight" key={String(slider.key)}>
                <div className="spread">
                  <label htmlFor={String(slider.key)}>{slider.label}</label>
                  <span className="val">{Number(draft[slider.key]).toFixed(2)}</span>
                </div>
                <input
                  id={String(slider.key)}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={Number(draft[slider.key])}
                  onChange={(event) => setDraft({ ...draft, [slider.key]: Number(event.target.value) })}
                />
                <p className="tiny dim">{slider.hint}</p>
              </div>
            ))}
          </div>
        )}
        <div className="row wrap mt">
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label>Max fee (sats)</label>
            <input value={draft?.maxFeeSats ?? ""} onChange={(event) => draft && setDraft({ ...draft, maxFeeSats: event.target.value.replace(/[^0-9]/g, "") || "0" })} />
          </div>
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label>Max settlement seconds</label>
            <input
              value={draft?.maxSettlementSeconds ?? ""}
              onChange={(event) => draft && setDraft({ ...draft, maxSettlementSeconds: Number(event.target.value.replace(/[^0-9]/g, "") || "0") })}
            />
          </div>
          <div className="stat" style={{ minWidth: 150 }}>
            <div className="k">Weight total</div>
            <div className="v">{total.toFixed(2)}</div>
            <div className="sub">{total <= 0 ? "must exceed zero" : "relative, not normalised"}</div>
          </div>
        </div>
      </Panel>

      <Panel title="Tachi capability probe" hint="What is actually working against the configured daemon right now. A failing probe lists what to do about it — this is the same check `npm run spike:tachi` runs.">
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Result</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {(capabilities.data?.capabilities ?? []).map((capability) => (
              <tr key={capability.id}>
                <td className="small">{capability.label}</td>
                <td>
                  <span className={`pill ${capability.ok ? "live" : "degraded"}`}>
                    <span className="dot" />
                    {capability.ok ? "pass" : "fail"}
                  </span>
                </td>
                <td className="small muted">
                  {capability.detail}
                  {!capability.ok && capability.remediation && <div className="tiny dim">fix: {capability.remediation}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small dim mt mono">daemon: {capabilities.data?.daemon.baseUrl}</p>
      </Panel>

      <WebhooksPanel />
    </div>
  );
}

function WebhooksPanel() {
  const registrations = useApi<{ id: string; url: string; events: string[]; secretFingerprint: string }[]>("/api/webhooks", 0);
  const deliveries = useApi<DeliveryView[]>("/api/webhooks/deliveries", 5000);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const register = async () => {
    setError(null);
    try {
      const response = await api.post<{ id: string; secret: string }>("/api/webhooks/register", { url, events: ["invoice.created", "invoice.pending", "invoice.confirmed", "invoice.expired", "payout.settled", "refund.settled"] });
      setSecret(response.data.secret);
      registrations.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <Panel title="Webhooks" hint="Signed with HMAC-SHA256 over the exact bytes delivered. Three retries with backoff; every attempt is visible below with its signature.">
      {error && <ErrorNote error={{ message: error }} />}
      {secret && (
        <div className="banner amber">
          <span>
            Signing secret (shown once): <code>{secret}</code> — verify with{" "}
            <code>HMAC-SHA256(secret, "&lt;t&gt;.&lt;body&gt;")</code>.
          </span>
        </div>
      )}
      <div className="row mt">
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-shop.example/webhooks/satsloom" />
        <button onClick={register} disabled={!/^https?:\/\//.test(url)}>
          Register
        </button>
      </div>
      <table className="mt">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Events</th>
            <th>Secret</th>
          </tr>
        </thead>
        <tbody>
          {(registrations.data ?? []).map((registration) => (
            <tr key={registration.id}>
              <td className="mono small">{registration.url}</td>
              <td className="tiny dim">{registration.events.join(", ")}</td>
              <td className="tiny mono dim">{registration.secretFingerprint}</td>
            </tr>
          ))}
          {(registrations.data ?? []).length === 0 && (
            <tr>
              <td colSpan={3} className="dim small">
                No endpoints registered.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="mt">Delivery log</h3>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Endpoint</th>
            <th>Status</th>
            <th className="num">Attempts</th>
            <th>Signature</th>
          </tr>
        </thead>
        <tbody>
          {(deliveries.data ?? []).map((delivery) => (
            <tr key={delivery.id}>
              <td className="mono small">{delivery.event}</td>
              <td className="tiny dim">{delivery.url.replace(/^https?:\/\//, "").slice(0, 34)}</td>
              <td>
                <span className={`status ${delivery.status === "delivered" ? "confirmed" : delivery.status === "failed" ? "failed" : "pending"}`}>{delivery.status}</span>
                {delivery.error && <div className="tiny dim">{delivery.error}</div>}
              </td>
              <td className="num small">
                {delivery.attempts}/{delivery.maxAttempts}
              </td>
              <td className="tiny mono dim">{delivery.signature.slice(0, 22)}…</td>
            </tr>
          ))}
          {(deliveries.data ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="dim small">
                Nothing delivered yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

/* ============================================================== Plugin / embed docs */

function embedSnippet(id: string) {
  return `<script src="${window.location.origin}/embed.js"
  data-satsloom-invoice="${id}"
  data-satsloom-api="${(import.meta.env.VITE_API_URL as string | undefined) ?? window.location.origin}"
  data-satsloom-label="Pay with sats"></script>`;
}

/**
 * Mounts the real `embed.js` exactly as a merchant's page would.
 *
 * A `<script>` injected through `dangerouslySetInnerHTML` never executes — the browser's parser
 * does not run scripts created that way — so the preview would silently show nothing while telling
 * the merchant "that is the live button". Creating the element and appending it is what actually
 * reproduces the integration, which is the entire point of showing it.
 */
export function EmbedPreview({ invoiceId }: { invoiceId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    const script = document.createElement("script");
    script.src = "/embed.js";
    script.async = true;
    script.setAttribute("data-satsloom-invoice", invoiceId);
    script.setAttribute("data-satsloom-api", (import.meta.env.VITE_API_URL as string | undefined) ?? window.location.origin);
    host.appendChild(script);
    return () => {
      // Closing an open modal first, or the overlay would outlive the preview that opened it.
      (window as unknown as { SatsLoom?: { close?: () => void } }).SatsLoom?.close?.();
      host.innerHTML = "";
    };
  }, [invoiceId]);

  return <div className="embed-preview" ref={hostRef} />;
}

export function PluginPage() {
  const invoices = useApi<InvoiceView[]>("/api/invoices", 0);
  const example = invoices.data?.[0]?.id ?? "INVOICE_ID";
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? "https://your-satsloom-api.example";
  const snippet = embedSnippet(example);

  return (
    <div className="stack">
      <Panel
        title="Add sats checkout to any shop"
        hint="SatsLoom is a payment router, not a hosted checkout: the button below is yours to style, and the money goes straight to your Tachi account."
      >
        <div className="embed-box">
          {example === "INVOICE_ID" ? (
            <div className="small muted">
              Create an invoice first — the live preview below mounts the real button against your newest invoice.
            </div>
          ) : (
            <>
              <EmbedPreview invoiceId={example} />
              <div className="small muted">
                That is the real <code>embed.js</code>, mounted on this page against invoice{" "}
                <code className="mono">{example.slice(0, 12)}…</code>. Click it: the pay page opens here in a modal,
                so the customer never leaves your shop.
              </div>
            </>
          )}
        </div>
      </Panel>

      <Panel title="1 · Create an invoice on your server" hint="Never from the browser — the API key stays server-side, and so does every mnemonic.">
        <pre>{`const invoice = await fetch("${base}/api/invoices", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": process.env.SATSLOOM_API_KEY },
  body: JSON.stringify({ amountSats: "50000", memo: "Order #1042", orderId: "1042" }),
}).then((r) => r.json());

const payUrl = \`${window.location.origin}/#/pay/\${invoice.data.id}\`;`}</pre>
      </Panel>

      <Panel title="2 · Put the button on the product page">
        <pre>{snippet}</pre>
        <p className="small muted mt">
          Attributes: <code>data-satsloom-invoice</code> (required), <code>data-satsloom-api</code> (defaults to the script's origin),{" "}
          <code>data-satsloom-label</code>, <code>data-satsloom-theme</code> (<code>dark</code> | <code>light</code>).
          The older <code>data-satsloom-pay-origin</code> still works as an alias for{" "}
          <code>data-satsloom-api</code>.
        </p>
      </Panel>

      <Panel title="3 · Fulfil on the webhook, not on the redirect" hint="The redirect can be closed, spoofed or lost. The webhook is signed and retried, and only fires on a ledger proof.">
        <pre>{`app.post("/webhooks/satsloom", (req, res) => {
  const [t, v1] = req.header("SatsLoom-Signature").split(",");
  const timestamp = t.split("=")[1];
  const expected = crypto.createHmac("sha256", process.env.SATSLOOM_WEBHOOK_SECRET)
    .update(\`\${timestamp}.\${req.rawBody}\`).digest("hex");
  if (expected !== v1.split("=")[1]) return res.sendStatus(400);   // reject forgeries
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return res.sendStatus(400); // reject replays

  if (req.body.event === "invoice.confirmed") {
    const { id, orderId, proof } = req.body.data;
    // Ship the order. proof.txid and proof.vtxoId are your receipt.
    fulfil(orderId ?? id);
  }
  res.sendStatus(200);
});`}</pre>
      </Panel>

      <Panel title="What the customer sees" hint="Mobile-first, no wallet install required to see the amount or the QR.">
        <a href={`#/pay/${example}`} className="btn">
          Open the pay page ↗
        </a>
      </Panel>
    </div>
  );
}
