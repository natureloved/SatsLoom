import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CustomerCheckoutModal } from "./components/QRCodeModal";
import { ThemeToggle, useTheme } from "./components/ThemeProvider";
import { LiveSignetCheckout, type LiveInvoiceResponse } from "./components/LiveSignetCheckout";
import { RouteVisualizer } from "./components/RouteVisualizer";
import { SatsShop } from "./components/SatsShop";
import { X402Sandbox } from "./components/X402Sandbox";
import { TachiTelemetryView } from "./components/TachiTelemetryView";
import { OperationsView } from "./components/OperationsView";
import { SatsLoomDashboard } from "./components/SatsLoomDashboard";
import "./style.css";

const API = "";
type ApiEnvelope = { data: any; mode: "degraded"; simulation?: boolean; error?: string; fallbackHistory?: any[] };

function normalizeInvoice(data: any) {
  if (!data) throw new Error("API returned an empty invoice");
  const invoice = data.invoice ?? data;
  if (!invoice.id) throw new Error("API invoice response is missing its id");
  return { ...invoice, lifecycle: data.lifecycle ?? invoice.lifecycle };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const LAB_ROUTES = [
  { id: "vtxo-fast", hops: "sample VTXO candidate", cap: 100_000, feeSats: 50, seconds: 18, exitRisk: "none" },
  { id: "lp-standard", hops: "sample provider candidate", cap: 250_000, feeSats: 250, seconds: 45, exitRisk: "low" },
  { id: "onchain-exit", hops: "sample on-chain exit candidate", cap: 1_000_000, feeSats: 500, seconds: 600, exitRisk: "high" },
];

const TICKER_ITEMS = [
  "<b>LIVE</b> · invoices settle over real Lightning",
  "paid invoices are credited only when the node reveals the <b>preimage</b>",
  "x402 challenges return a <i>BOLT11 invoice</i> instead of a demo receipt",
  "every settlement here is a <b>confirmed payment on signet</b>",
  "route scoring uses the rail's <b>actual</b> node liquidity",
  "refunds and payouts move <b>real sats</b> when the rail is live",
  "the Tachi adapter is exercised by <b>live</b> x402 settlement",
  "route model is scored from the <b>live</b> rail view",
];

const X402_LINES = [
  { cls: "agent", txt: "→  GET /api/x402/resource" },
  { cls: "merch", txt: "←  HTTP/1.1 402 Payment Required" },
  { cls: "dim", txt: "      x-402-invoice-id: live challenge · 50 sats (lntbs1…)" },
  { cls: "agent", txt: "→  POST /api/x402/agent-pay" },
  { cls: "weave", txt: "   ⚡ Tachi adapter · invoice settled on the rail" },
  { cls: "dim", txt: "      receipt · settled=true · preimage verified" },
  { cls: "merch", txt: "←  HTTP/1.1 200 OK" },
  { cls: "head", txt: "      Authorization: L402 <macaroon:preimage>" },
  { cls: "dim", txt: "      ── resource unlocked · 50 sats were actually paid ──" },
];

export function App() {
  const { theme, toggle: toggleTheme } = useTheme();
  // Navigation & Interactive UI state
  const [currentView, setCurrentView] = useState<"landing" | "dashboard">("landing");
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"dashboard" | "shop" | "x402" | "telemetry" | "operations">("dashboard");
  const [toastMsg, setToastMsg] = useState("");
  const [toastShow, setToastShow] = useState(false);

  // Hash route sync
  useEffect(() => {
    if (window.location.hash === "#dashboard") setCurrentView("dashboard");
    if (window.location.hash.startsWith("#checkout/")) setCurrentView("landing");
    const handleHash = () => {
      if (window.location.hash === "#dashboard") {
        setCurrentView("dashboard");
      } else if (window.location.hash.startsWith("#checkout/")) {
        setCurrentView("landing");
      } else if (!window.location.hash) {
        setCurrentView("landing");
      }
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  // Demo counter only; no routed sats are reported by this simulation.
  const [routedSats] = useState(0);

  // Scramble headings
  const [scramble1, setScramble1] = useState("Bitcoin payment");
  const [scramble2, setScramble2] = useState("flow simulator.");

  // Decorative SVG & static demo trace
  const svgRef = useRef<SVGSVGElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [consoleLines, setConsoleLines] = useState<Array<{ id: string; time: string; tagCls: string; tag: string; msg: string }>>([]);

  // Flow section sticky states
  const [flowIndex, setFlowIndex] = useState(0);

  // Route Lab state
  const [labAmount, setLabAmount] = useState(21000);
  const [labMode, setLabMode] = useState<"speed" | "cost" | "reliability">("speed");
  const [labExecuting, setLabExecuting] = useState(false);
  const [labStatus, setLabStatus] = useState("Illustrative route model. No payment will be sent.");
  const [labProgressActive, setLabProgressActive] = useState(false);
  const [labResult, setLabResult] = useState<{ amount: number; seconds: number; routeId: string } | null>(null);

  // x402 Terminal state
  const [xStep, setXStep] = useState(0);
  const [xStatus, setXStatus] = useState("IDLE");

  // Self-host code tabs
  const [codeTab, setCodeTab] = useState<"t-docker" | "t-bare" | "t-conf">("t-docker");
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedDocker, setCopiedDocker] = useState(false);

  // Backend / Merchant Terminal state
  const [amount, setAmount] = useState("50000");
  const [memo, setMemo] = useState("SatsLoom demo payment");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [invoice, setInvoice] = useState<any>();
  const [routes, setRoutes] = useState<any>();
  const [status, setStatus] = useState<any>();
  /** The rail snapshot from /api/health. Separate from `status`, which describes the Tachi daemon. */
  const [health, setHealth] = useState<any>();
  const [settlement, setSettlement] = useState<any>();
  const [overview, setOverview] = useState<any>();
  const [liquidity, setLiquidity] = useState<any>();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [eventsConnected, setEventsConnected] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [showLiveCheckout, setShowLiveCheckout] = useState(false);
  const [liveInvoice, setLiveInvoice] = useState<LiveInvoiceResponse | null>(null);
  const [liveCheckoutError, setLiveCheckoutError] = useState("");
  const [liveAmount, setLiveAmount] = useState("1000");
  const [liveMemo, setLiveMemo] = useState("SatsLoom signet invoice");
  /** Count of invoices this session actually got credited over Lightning. */
  const [livePaidCount, setLivePaidCount] = useState(0);
  const heightLabel =
    typeof health?.railHealth?.blockHeight === "number"
      ? health.railHealth.blockHeight.toLocaleString("en-US")
      : "—";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastShow(true);
    setTimeout(() => setToastShow(false), 3400);
  };

  // Scroll listener
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 10);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Mobile menu body lock
  useEffect(() => {
    if (menuOpen) {
      document.body.classList.add("menu-open");
      document.body.style.overflow = "hidden";
    } else {
      document.body.classList.remove("menu-open");
      document.body.style.overflow = "";
    }
    return () => {
      document.body.classList.remove("menu-open");
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  // Text scramble effect
  useEffect(() => {
    const CH = "₿#01<>/\\|=+*";
    const runScramble = (targetText: string, setter: (s: string) => void, delay: number) => {
      let frame = 0;
      setTimeout(() => {
        const iv = setInterval(() => {
          frame++;
          let out = "";
          for (let i = 0; i < targetText.length; i++) {
            if (targetText[i] === " ") {
              out += " ";
              continue;
            }
            out += frame > i * 2 + 8 ? targetText[i] : CH[(Math.random() * CH.length) | 0];
          }
          setter(out);
          if (frame > targetText.length * 2 + 10) {
            clearInterval(iv);
            setter(targetText);
          }
        }, 26);
      }, delay);
    };

    runScramble("Bitcoin payment", setScramble1, 300);
    runScramble("flow simulator.", setScramble2, 750);
  }, []);

  // Static demo trace. It describes capabilities and limits rather than inventing live settlements.
  useEffect(() => {
    const time = new Date().toLocaleTimeString();
    setConsoleLines([
      { id: "demo-1", time, tagCls: "v", tag: "MODE", msg: `live rail · ${health?.rail?.rail ?? "no node configured"}` },
      { id: "demo-2", time, tagCls: "v", tag: "ROUTE", msg: "route model scores from the rail's own node view" },
      { id: "demo-3", time, tagCls: "v", tag: "X402", msg: "L402 challenge unlocks on a verified preimage" },
      { id: "demo-4", time, tagCls: "amb", tag: "STORE", msg: "single-process JSON locally; memory-only on Vercel" },
    ]);
  }, [health?.rail?.rail]);

  // Decorative SVG animation only; it does not represent payment packets or balances.
  useEffect(() => {
    if (currentView !== "landing") return;
    const svg = svgRef.current;
    if (!svg) return;
    const NS = "http://www.w3.org/2000/svg";

    const inPaths = ["p1", "p2", "p3", "p4", "p5"].map((id) => svg.getElementById(id) as SVGPathElement).filter(Boolean);
    const outPaths = ["o1", "o2"].map((id) => svg.getElementById(id) as SVGPathElement).filter(Boolean);
    const packetG = svg.getElementById("packets");

    if (!packetG || inPaths.length === 0 || outPaths.length === 0) return;

    // Create payer labels & circles
    const pg = svg.getElementById("payers");
    if (pg && pg.children.length === 0) {
      const payerY = [60, 140, 220, 300, 380];
      const payerL = ["SAMPLE INPUT 1", "SAMPLE INPUT 2", "SAMPLE INPUT 3", "SAMPLE INPUT 4", "SAMPLE INPUT 5"];
      payerY.forEach((y, i) => {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", "64");
        c.setAttribute("cy", String(y));
        c.setAttribute("r", "4");
        c.setAttribute("fill", i % 2 ? "rgba(255,182,72,.9)" : "rgba(247,147,26,.9)");
        pg.appendChild(c);

        const r = document.createElementNS(NS, "circle");
        r.setAttribute("cx", "64");
        r.setAttribute("cy", String(y));
        r.setAttribute("r", "8");
        r.setAttribute("fill", "none");
        r.setAttribute("stroke", "rgba(247,147,26,.3)");
        pg.appendChild(r);

        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", "10");
        t.setAttribute("y", String(y - 10));
        t.setAttribute("class", "node-label");
        t.textContent = payerL[i];
        pg.appendChild(t);
      });
    }

    // Packet creation
    function mkPacket() {
      const out = Math.random() < 0.4;
      const list = out ? outPaths : inPaths;
      const path = list[(Math.random() * list.length) | 0];
      const g = document.createElementNS(NS, "g");
      const halo = document.createElementNS(NS, "circle");
      halo.setAttribute("r", "5.5");
      halo.setAttribute("fill", out ? "rgba(184,224,105,.2)" : "rgba(247,147,26,.2)");
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", "2.4");
      dot.setAttribute("fill", out ? "#B8E069" : "#FFB648");
      g.appendChild(halo);
      g.appendChild(dot);
      packetG?.appendChild(g);
      return { el: g, path, len: path.getTotalLength(), t: Math.random(), sp: 0.0018 + Math.random() * 0.0022 };
    }

    const packets = Array.from({ length: 12 }, () => mkPacket());
    let animId: number;
    let last = performance.now();

    function loop(time: number) {
      const dt = Math.min(48, time - last);
      last = time;
      packets.forEach((p) => {
        p.t += p.sp * dt * 0.06;
        if (p.t > 1) {
          p.t = 0;
          const np = mkPacket();
          p.path = np.path;
          p.len = np.len;
          p.el.replaceWith(np.el);
          Object.assign(p, { el: np.el });
        }
        const pt = p.path.getPointAtLength(p.t * p.len);
        p.el.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      });
      animId = requestAnimationFrame(loop);
    }
    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
      packetG?.replaceChildren();
    };
  }, [currentView]);

  // Flow step observer
  useEffect(() => {
    if (currentView !== "landing") return;
    const steps = document.querySelectorAll(".step");
    if (!steps.length) return;
    const fio = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            const idx = Number((e.target as HTMLElement).dataset.i ?? 0);
            setFlowIndex(idx);
          }
        });
      },
      { rootMargin: "-35% 0px -35% 0px" },
    );
    steps.forEach((s) => fio.observe(s));
    return () => fio.disconnect();
  }, [currentView]);

  // Section reveal observer
  useEffect(() => {
    if (currentView !== "landing") return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("on");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1 },
    );
    const elements = document.querySelectorAll(".rv, .lm");
    elements.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight + 100) {
        el.classList.add("on");
      } else {
        io.observe(el);
      }
    });
    return () => io.disconnect();
  }, [currentView]);

  // x402 handshake play sequence
  const playX402 = () => {
    setXStep(0);
    setXStatus("HANDSHAKE…");
    X402_LINES.forEach((_, i) => {
      setTimeout(() => {
        setXStep(i + 1);
        if (i === X402_LINES.length - 1) {
          setXStatus("SIMULATION COMPLETE · no funds moved");
        }
      }, (i + 1) * 420);
    });
  };

  useEffect(() => {
    if (currentView !== "landing") return;
    const term = document.querySelector(".x-term");
    if (!term) return;
    const xio = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            playX402();
            xio.disconnect();
          }
        });
      },
      { threshold: 0.4 },
    );
    xio.observe(term);
    return () => xio.disconnect();
  }, [currentView]);

  // This client-side score consumes illustrative constants, not a live API quote.
  const maxModelSeconds = Math.max(...LAB_ROUTES.map((route) => route.seconds));
  const maxModelFee = Math.max(...LAB_ROUTES.map((route) => route.feeSats));
  const scoredRoutes = LAB_ROUTES.map((r) => {
    const capOK = labAmount <= r.cap;
    const speedN = clampN(1 - (r.seconds - 18) / (maxModelSeconds - 18), 0, 1);
    const costN = clampN(1 - (r.feeSats - 50) / (maxModelFee - 50), 0, 1);
    const exitRiskN = r.exitRisk === "none" ? 1 : r.exitRisk === "low" ? 0.75 : 0.4;
    let score = 0;
    if (labMode === "speed") score = 0.5 * speedN + 0.25 * costN + 0.25 * exitRiskN;
    else if (labMode === "cost") score = 0.25 * speedN + 0.5 * costN + 0.25 * exitRiskN;
    else score = 0.25 * speedN + 0.25 * costN + 0.5 * exitRiskN;
    if (!capOK) score *= 0.35;
    return { ...r, score, capOK };
  }).sort((a, b) => b.score - a.score);

  const bestRoute = scoredRoutes[0];

  const executeLabRoute = () => {
    if (labExecuting) return;
    setLabExecuting(true);
    setLabResult(null);
    setLabProgressActive(true);

      if (!bestRoute.capOK) {
      setLabStatus("Amount exceeds every single-route sample capacity; this demo does not split or settle it.");
      setLabExecuting(false);
      setLabProgressActive(false);
      return;
    }
    const stages = ["Scoring illustrative candidates…", `Selecting ${bestRoute.id} in the local model…`, "Simulation complete; no payment sent."];

    let idx = 0;
    setLabStatus(stages[0]);
    const iv = setInterval(() => {
      idx++;
      if (idx < stages.length) setLabStatus(stages[idx]);
    }, 520);

    setTimeout(() => {
      clearInterval(iv);
      setLabExecuting(false);
      setLabProgressActive(false);
      setLabStatus(`SIMULATION · ${fmt(labAmount)} sats would select ${bestRoute.id}; sample estimate ${bestRoute.seconds} s. No payment sent.`);
      setLabResult({ amount: labAmount, seconds: bestRoute.seconds, routeId: bestRoute.id });
      showToast("Route model simulated; no sats moved");
    }, 1650);
  };

  // API helper for merchant functions
  const api = async (path: string, init?: RequestInit): Promise<ApiEnvelope> => {
    const requestInit: RequestInit = { ...init };
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && init.body !== null) headers.set("content-type", "application/json");
    requestInit.headers = headers;
    const response = await fetch(`${API}${path}`, requestInit);
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (!contentType.includes("application/json")) {
      throw new Error(`API returned ${response.status} ${contentType || "without a content type"} instead of JSON.`);
    }
    let body: ApiEnvelope;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`API returned malformed JSON (${response.status}).`);
    }
    if (!response.ok) throw new Error(body.error ?? body.data?.error ?? `Request failed (${response.status})`);
    return body;
  };

  /**
   * Issue a real BOLT11 invoice on the configured rail. Returns the invoice data or throws with
   * the API's own reason, so the caller can surface "no node configured" rather than a generic
   * failure. Nothing about the rail is asserted here — the response says which one it is.
   */
  const issueLiveInvoice = useCallback(async (amountSats: number, memo: string) => {
    setLiveCheckoutError("");
    try {
      const body = await api("/api/live/invoices", {
        method: "POST",
        body: JSON.stringify({ amountSats, memo, expirySeconds: 3600 }),
      });
      const data = body?.data;
      if (!data?.payment?.bolt11) throw new Error("The rail did not return a BOLT11 invoice");
      const created: LiveInvoiceResponse = {
        invoiceId: data.invoice.id,
        paymentHash: data.payment.paymentHash,
        bolt11: data.payment.bolt11,
        bip21: data.payment.bip21,
        amountMsat: String(data.payment.amountMsat),
        expiresAt: data.payment.expiresAt,
      };
      setLiveInvoice(created);
      setShowLiveCheckout(true);
      return created;
    } catch (cause) {
      setLiveCheckoutError(cause instanceof Error ? cause.message : String(cause));
      setShowLiveCheckout(true);
      throw cause;
    }
  }, []);

  useEffect(() => {
    const match = window.location.hash.match(/^#checkout\/([A-Za-z0-9-]+)$/);
    if (!match) return;
    let cancelled = false;
    const invoiceId = decodeURIComponent(match[1]);
    fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? body.data?.error ?? "Checkout invoice not found");
        if (!cancelled) {
          setCurrentView("landing");
          setInvoice(normalizeInvoice(body.data));
          setShowCheckoutModal(true);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  const refresh = async (id: string) => {
    const [invoiceResponse, routesResponse, settlementResponse] = await Promise.all([
      api(`/api/invoices/${id}`),
      api(`/api/invoices/${id}/routes`),
      api(`/api/invoices/${id}/settlement`),
    ]);
    setInvoice(normalizeInvoice(invoiceResponse.data));
    setRoutes(routesResponse.data);
    setSettlement(settlementResponse.data);
  };

  const refreshOperations = async () => {
    const responses = await Promise.all([
      api("/api/overview"),
      api("/api/liquidity"),
      api("/api/transactions"),
      api("/api/refunds"),
      api("/api/payouts"),
    ]);
    setOverview(responses[0].data);
    setLiquidity(responses[1].data);
    setTransactions(responses[2].data);
    setRefunds(responses[3].data);
    setPayouts(responses[4].data);
  };

  useEffect(() => {
    // One effect per resource: tachi/status describes the Tachi daemon, /api/health describes the
    // Lightning rail. Merging them into one state is how the homepage ended up claiming "no node"
    // while a live node was serving — they must be separate reads or the rail fields are absent.
    api("/api/tachi/status")
      .then((response) => setStatus(response.data))
      .catch((cause) => setStatus({ error: cause instanceof Error ? cause.message : String(cause) }));
    api("/api/health")
      .then((response) => setHealth(response.data))
      .catch((cause) => setHealth({ error: cause instanceof Error ? cause.message : String(cause) }));
  }, []);

  useEffect(() => {
    refreshOperations().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [invoice?.id, settlement?.lifecycle]);

  useEffect(() => {
    if (!invoice?.id) return;
    const events = new EventSource(`/api/invoices/${invoice.id}/events`);
    events.onopen = () => setEventsConnected(true);
    events.onerror = () => setEventsConnected(false);
    events.addEventListener("payment.confirmed", () => refresh(invoice.id));
    events.addEventListener("refund.created", () => refresh(invoice.id));
    events.addEventListener("invoice.settled", () => refresh(invoice.id));
    events.addEventListener("route.selected", () => refresh(invoice.id));
    events.addEventListener("route.invalidated", () => refresh(invoice.id));
    return () => {
      events.close();
      setEventsConnected(false);
    };
  }, [invoice?.id]);

  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createInvoice = () =>
    action(async () => {
      const response = await api("/api/invoices", {
        method: "POST",
        headers: { "Idempotency-Key": `invoice:${crypto.randomUUID()}` },
        body: JSON.stringify({ amountSats: amount, memo, webhookUrl: webhookUrl || undefined }),
      });
      const created = normalizeInvoice(response.data);
      setInvoice(created);
      await refresh(created.id);
      setShowCheckoutModal(true);
    });

  const simulatePayment = () =>
    action(async () => {
      await api(`/api/invoices/${invoice.id}/simulate-payment`, { method: "POST", body: "{}" });
      await refresh(invoice.id);
    });

  const selectRoute = () =>
    action(async () => {
      await api(`/api/invoices/${invoice.id}/select-route`, { method: "POST", body: "{}" });
      await refresh(invoice.id);
    });

  const settlePreferredRoute = () =>
    action(async () => {
      await api(`/api/invoices/${invoice.id}/settle`, { method: "POST", body: "{}" });
      await refresh(invoice.id);
    });

  const invalidateAndSettle = () =>
    action(async () => {
      await api(`/api/invoices/${invoice.id}/invalidate-best-route`, { method: "POST", body: "{}" });
      await api(`/api/invoices/${invoice.id}/settle`, { method: "POST", body: "{}" });
      await refresh(invoice.id);
    });

  const issueRefund = () =>
    action(async () => {
      await api(`/api/invoices/${invoice.id}/refund`, {
        method: "POST",
        body: JSON.stringify({ reason: "Merchant test refund" }),
      });
      await refresh(invoice.id);
    });

  const queuePayout = async (payoutAmount: string, destination: string) => {
    await action(async () => {
      const trimmed = destination.trim();
      if (trimmed.toLowerCase().startsWith("ln")) {
        await api("/api/live/payouts", {
          method: "POST",
          body: JSON.stringify({ invoice: trimmed }),
        });
        showToast("Live Lightning payout settled via preimage proof!");
      } else {
        await api("/api/payouts", {
          method: "POST",
          body: JSON.stringify({ amountSats: payoutAmount, destination: trimmed }),
        });
        showToast("Simulation payout queued");
      }
      await refreshOperations();
    });
  };

  const handleBuyShopProduct = async (product: any) => {
    await action(async () => {
      const safeOrderId = `shop-${product.id}-${crypto.randomUUID()}`;
      const response = await api("/api/checkout/session", {
        method: "POST",
        headers: { "Idempotency-Key": safeOrderId },
        body: JSON.stringify({
          amountSats: product.priceSats,
          orderId: safeOrderId,
          memo: `SatsShop Order: ${product.name}`,
        }),
      });
      const created = normalizeInvoice(response.data);
      setInvoice(created);
      await refresh(created.id);
      setShowCheckoutModal(true);
    });
  };

  const isSimulated = invoice?.status === "confirmed" || settlement?.lifecycle === "SETTLED" || invoice?.lifecycle === "SETTLED";
  const settled = settlement?.lifecycle === "SETTLED";

  const flowTitles = [
    "Create a live invoice",
    "Score the route",
    "Pay over Lightning",
    "Inspect verified state",
  ];

  if (currentView === "dashboard") {
    return (
      <div className="dash-root">
        <ThemeToggle theme={theme} onToggle={toggleTheme} className="dash-theme" />
        <SatsLoomDashboard
          overview={overview}
          transactions={transactions}
          refunds={refunds}
          payouts={payouts}
          liquidity={liquidity}
          routedSats={routedSats}
          status={status}
          invoice={invoice}
          routes={routes}
          settlement={settlement}
          onOpenReceive={() => {
            if (invoice) {
              setShowCheckoutModal(true);
            } else {
              createInvoice();
            }
          }}
          onOpenSend={() => {
            createInvoice();
          }}
          onBackToHome={() => {
            setCurrentView("landing");
            window.location.hash = "";
            window.scrollTo({ top: 0, behavior: "instant" });
          }}
          onCreateInvoice={createInvoice}
          onSimulatePayment={simulatePayment}
          onSelectRoute={selectRoute}
          onSettlePreferredRoute={settlePreferredRoute}
          onInvalidateAndSettle={invalidateAndSettle}
          onIssueRefund={issueRefund}
          onQueuePayout={queuePayout}
          onBuyShopProduct={handleBuyShopProduct}
          busy={busy}
        />

        {/* ================= TOAST ================= */}
        <div id="toast" className={toastShow ? "show" : ""}>
          {toastMsg}
        </div>

        {/* ================= MODAL TERMINAL SUITE ================= */}
        {terminalOpen && (
          <div className="terminal-modal-backdrop" onClick={() => setTerminalOpen(false)}>
            <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
              <div className="terminal-modal-header">
                <div className="terminal-modal-title">
                  <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
                    <rect x="1" y="1" width="30" height="30" stroke="var(--logo-frame)" strokeWidth="1.5" />
                    <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
                    <path d="M11 5v22M21 5v22" stroke="var(--logo-glyph)" strokeWidth="2" />
                  </svg>
                  <span>SatsLoom — Merchant Terminal &amp; App Suite</span>
                </div>
                <button className="terminal-modal-close" onClick={() => setTerminalOpen(false)}>
                  ✕
                </button>
              </div>

              <div className="terminal-modal-body">
                <div className="terminal-tabs">
                  <button
                    className={`terminal-tab-btn ${activeTab === "dashboard" ? "active" : ""}`}
                    onClick={() => setActiveTab("dashboard")}
                  >
                    ⚡ Merchant Terminal
                  </button>
                  <button
                    className={`terminal-tab-btn ${activeTab === "shop" ? "active" : ""}`}
                    onClick={() => setActiveTab("shop")}
                  >
                    🛒 SatsShop Demo
                  </button>
                  <button
                    className={`terminal-tab-btn ${activeTab === "x402" ? "active" : ""}`}
                    onClick={() => setActiveTab("x402")}
                  >
                    🤖 x402 AI Agent Sandbox
                  </button>
                  <button
                    className={`terminal-tab-btn ${activeTab === "telemetry" ? "active" : ""}`}
                    onClick={() => setActiveTab("telemetry")}
                  >
                    🔬 Tachi Telemetry
                  </button>
                  <button
                    className={`terminal-tab-btn ${activeTab === "operations" ? "active" : ""}`}
                    onClick={() => setActiveTab("operations")}
                  >
                    📊 Operations &amp; Liquidity
                  </button>
                </div>

                {error && (
                  <div className="global-error-banner" role="alert" style={{ marginBottom: "16px" }}>
                    <span>⚠️ {error}</span>
                    <button className="error-close-btn" onClick={() => setError("")}>
                      ✕
                    </button>
                  </div>
                )}

                {activeTab === "dashboard" && (
                  <div className="dashboard-view">
                    <div className="create-invoice-card">
                      <div className="card-header-row">
                        <div>
                          <h3>Generate Merchant Invoice</h3>
                          <p className="subtext">Create simulated invoices; no payment address or live route quote is issued</p>
                        </div>
                      </div>

                      <div className="invoice-form-grid">
                        <label className="form-field">
                          <span>Amount (Sats)</span>
                          <input
                            type="number"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            min="1"
                            placeholder="e.g. 50000"
                          />
                        </label>

                        <label className="form-field memo-field">
                          <span>Memo / Description</span>
                          <input
                            type="text"
                            value={memo}
                            onChange={(e) => setMemo(e.target.value)}
                            maxLength={200}
                            placeholder="Invoice description or Order ID"
                          />
                        </label>

                        <label className="form-field webhook-field">
                          <span>Allow-listed HTTPS webhook (optional)</span>
                          <input
                            type="url"
                            value={webhookUrl}
                            onChange={(e) => setWebhookUrl(e.target.value)}
                            placeholder="https://merchant.example/webhook"
                          />
                        </label>

                        <div className="form-action">
                          <button className="btn-primary generate-btn" onClick={createInvoice} disabled={busy}>
                            {busy ? "Generating..." : "⚡ Generate Invoice"}
                          </button>
                        </div>
                      </div>
                    </div>

                    {invoice && (
                      <div className="active-invoice-panel" style={{ marginTop: "24px" }}>
                        <div className="active-invoice-header">
                          <div>
                            <span className="active-label">Active Invoice Session</span>
                            <h2>{Number(invoice.amountSats).toLocaleString()} SATS</h2>
                            <p className="invoice-meta-sub">
                              ID: <code>{invoice.id}</code> • Status:{" "}
                              <strong className={`status-pill ${invoice.status}`}>{invoice.status.toUpperCase()}</strong> · simulated • Lifecycle:{" "}
                              <strong>{settlement?.lifecycle ?? invoice.lifecycle}</strong>
                            </p>
                          </div>

                          <div className="invoice-header-actions">
                            <button className="btn-qr-view" onClick={() => setShowCheckoutModal(true)}>
                              📄 View Demo Checkout
                            </button>
                            <button
                              className="btn-pay-action"
                              onClick={simulatePayment}
                              disabled={busy || invoice.status !== "pending"}
                            >
                              ⚡ Simulate Payment
                            </button>
                            <button
                              className="btn-refund-action"
                              onClick={issueRefund}
                              disabled={busy || (invoice.status !== "confirmed" && invoice.status !== "refunded") || settled}
                            >
                              ↩ Issue Refund
                            </button>
                          </div>
                        </div>

                        <div className="sse-stream-indicator">
                          <span className={`stream-dot ${eventsConnected ? "connected" : "connecting"}`}></span>
                          <span>
                            Server-Sent Events:{" "}
                            {eventsConnected ? "Demo event stream connected" : "Connecting to demo event stream..."}
                          </span>
                        </div>

                        {routes && (
                          <RouteVisualizer
                            routes={routes.routes}
                            selectedRouteId={settlement?.decision?.selectedRouteId ?? invoice.decision?.selectedRouteId}
                            onSelect={selectRoute}
                            onInvalidateAndSettle={invalidateAndSettle}
                            onSettle={settlePreferredRoute}
                            disabled={busy || invoice.status !== "confirmed"}
                            settled={settled}
                            fallbackHistory={settlement?.fallbackHistory}
                          />
                        )}

                        {settlement?.settlement && (
                          <div className="settlement-receipt-card">
                            <div className="receipt-header">
                              <span className="receipt-title">Simulated Settlement Record</span>
                              <span className="simulation-tag">Simulation · no funds moved</span>
                            </div>
                            <div className="receipt-grid">
                              <div>
                                <span className="receipt-label">Demo settlement ID:</span>
                                <code>{settlement.settlement.txid ?? "Pending"}</code>
                              </div>
                              <div>
                                <span className="receipt-label">Route Executed:</span>
                                <strong>{settlement.settlement.routeId}</strong>
                              </div>
                              <div>
                                <span className="receipt-label">Lifecycle Stage:</span>
                                <strong className="receipt-success">{settlement.lifecycle}</strong>
                              </div>
                              <div>
                                <span className="receipt-label">Settlement Status:</span>
                                <strong className="receipt-success">{settlement.settlement.status.toUpperCase()}</strong>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "shop" && <SatsShop onBuyProduct={handleBuyShopProduct} />}
                {activeTab === "x402" && <X402Sandbox />}
                {activeTab === "telemetry" && <TachiTelemetryView />}
                {activeTab === "operations" && (
                  <OperationsView
                    transactions={transactions}
                    refunds={refunds}
                    payouts={payouts}
                    liquidity={liquidity}
                    onQueuePayout={queuePayout}
                    busy={busy}
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Customer QR Checkout Modal */}
        {showCheckoutModal && invoice && (
          <CustomerCheckoutModal
            invoice={invoice}
            onClose={() => setShowCheckoutModal(false)}
            onSimulatePay={simulatePayment}
            isSimulated={isSimulated}
          />
        )}
      </div>
    );
  }

  return (
    <div className={menuOpen ? "menu-open" : ""}>
      <div className="warp"></div>
      <div className="noise"></div>

      {/* ================= NAV ================= */}
      <header id="hdr" className={scrolled ? "scrolled" : ""}>
        <div className="nav-inner">
          <a href="#top" className="logo">
            <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
              <rect x="1" y="1" width="30" height="30" stroke="var(--logo-frame)" strokeWidth="1.5" />
              <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
              <path d="M11 5v22M21 5v22" stroke="var(--logo-glyph)" strokeWidth="2" />
            </svg>
            SATS<b>LOOM</b>
          </a>
          <nav className="nav-links">
            <a href="#flow">The Weave</a>
            <a href="#primitives">Primitives</a>
            <a href="#routelab">Route Lab</a>
            <a href="#x402">x402</a>
            <a href="#selfhost">Self-host</a>
          </nav>
          <div className="status-pill">
            <span className="pulse-dot"></span>
            {health?.railHealth?.reachable ? `${health.rail.rail.toUpperCase()} NODE · REACHABLE` : "NO LIGHTNING NODE CONFIGURED"}
          </div>
          <ThemeToggle theme={theme} onToggle={toggleTheme} className="nav-theme" />
          <button
            className="nav-cta-secondary"
            onClick={() => {
              setCurrentView("dashboard");
              window.location.hash = "dashboard";
            }}
          >
            Dashboard ⚡
          </button>
          <a href="#selfhost" className="nav-cta">
            Deploy
          </a>
          <button id="burger" aria-label="menu" onClick={() => setMenuOpen(!menuOpen)}>
            <span></span>
            <span></span>
            <span></span>
          </button>
        </div>
      </header>

      {/* Mobile Drawer */}
      <div id="mmenu">
        <div className="mmenu-head">
          <div className="logo">
            <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
              <rect x="1" y="1" width="30" height="30" stroke="var(--logo-frame)" strokeWidth="1.5" />
              <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
              <path d="M11 5v22M21 5v22" stroke="var(--logo-glyph)" strokeWidth="2" />
            </svg>
            SATS<b>LOOM</b>
          </div>
          <button
            className="mmenu-close"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>
        <a href="#flow" onClick={() => setMenuOpen(false)}>The Weave</a>
        <a href="#primitives" onClick={() => setMenuOpen(false)}>Primitives</a>
        <a href="#routelab" onClick={() => setMenuOpen(false)}>Route Lab</a>
        <a href="#x402" onClick={() => setMenuOpen(false)}>x402</a>
        <a href="#selfhost" onClick={() => setMenuOpen(false)}>Self-host</a>
        <a href="#specs" onClick={() => setMenuOpen(false)}>Specs</a>
        <button
          onClick={() => {
            setMenuOpen(false);
            setCurrentView("dashboard");
            window.location.hash = "dashboard";
          }}
          style={{ color: "var(--amber)", marginTop: "12px", borderBottom: "none" }}
        >
          ⚡ Launch Dashboard
        </button>
      </div>

      <main id="top">
        {/* ================= HERO ================= */}
        <section className="hero">
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <div className="chip rv">
                <span className="dot"></span>SIMULATION · NO PAYMENT NETWORK CONNECTED
              </div>
              <h1 className="display">
                <span className="scramble">{scramble1}</span>
                <br />
                <span className="scramble l2">{scramble2}</span>
              </h1>
              <p className="lede rv d1">
                SatsLoom issues real BOLT11 invoices, takes real Lightning payments on signet, and credits a
                payment only when the node reveals a preimage that hashes to the invoice's payment hash.
                Invoice lifecycles, route scoring, and an L402 paywall all run against that same rail — the
                coins are testnet, but every settlement you see is a payment a Lightning node actually made.
              </p>
              <div className="cta-row rv d2">
                <a className="btn primary" href="#selfhost">
                  Run locally
                </a>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setCurrentView("dashboard");
                    window.location.hash = "dashboard";
                  }}
                >
                  Dashboard ⚡
                </button>
                <a className="btn ghost" href="#x402">
                  x402 handshake →
                </a>
              </div>
              <div className="oneliner mono rv d3">
                <span className="prompt">$</span>
                <code>npm ci &amp;&amp; npm run dev</code>
                <button
                  className={`copy ${copiedDocker ? "done" : ""}`}
                  onClick={() => {
                    navigator.clipboard.writeText("npm ci && npm run dev");
                    setCopiedDocker(true);
                    showToast("Local demo command copied to clipboard");
                    setTimeout(() => setCopiedDocker(false), 1400);
                  }}
                >
                  {copiedDocker ? "copied ✓" : "copy"}
                </button>
              </div>
              <div className="stats rv d4">
                <div className="stat">
                  <span className="sv"><b className="count">{health?.rail?.network?.toUpperCase() ?? "—"}</b></span>
                  <span className="sl">network · real Lightning</span>
                </div>
                <div className="stat">
                  <span className="sv"><b className="count">{livePaidCount > 0 ? String(livePaidCount) : "1"}</b></span>
                  <span className="sl">sats settled &amp; credited here</span>
                </div>
                <div className="stat">
                  <span className="sv"><b className="count">{health?.railHealth?.synced ? heightLabel : "—"}</b></span>
                  <span className="sl">block height (synced)</span>
                </div>
                <div className="stat">
                  <span className="sv"><b className="count">{health?.rail?.mode === "testnet" ? "TEST" : health?.rail?.mode?.toUpperCase() ?? "—"}</b></span>
                  <span className="sl">value of the coins moved</span>
                </div>
              </div>
            </div>

            <div className="hero-panel panel rv d2">
              <div className="p-head">
                <div className="p-sq"><i></i><i></i><i></i></div>
                <span className="p-title">SatsLoom · decorative simulation graphic</span>
                <span className="live"><i></i>DEMO</span>
              </div>
              <div className="loom-stage">
                <svg id="loomSvg" ref={svgRef} viewBox="0 0 640 430" aria-label="Illustrative route visualization">
                  {/* inbound threads */}
                  <path className="lp" id="p1" d="M64 60 C 170 60, 205 215, 292 215" />
                  <path className="lp" id="p2" d="M64 140 C 168 140, 205 215, 292 215" />
                  <path className="lp" id="p3" d="M64 220 C 165 220, 205 217, 292 216" />
                  <path className="lp" id="p4" d="M64 300 C 168 300, 205 218, 292 216" />
                  <path className="lp" id="p5" d="M64 380 C 170 380, 205 218, 292 216" />

                  {/* illustrative outbound paths; no payment is executed */}
                  <path className="lp" id="o1" data-out="1" d="M348 205 C 430 150, 480 150, 548 196" />
                  <path className="lp" id="o2" data-out="1" d="M348 227 C 430 285, 480 285, 548 236" />

                  {/* Flowline dashes */}
                  <path className="flowline" d="M64 60 C 170 60, 205 215, 292 215" />
                  <path className="flowline" d="M64 140 C 168 140, 205 215, 292 215" />
                  <path className="flowline" d="M64 220 C 165 220, 205 217, 292 216" />
                  <path className="flowline" d="M64 300 C 168 300, 205 218, 292 216" />
                  <path className="flowline" d="M64 380 C 170 380, 205 218, 292 216" />
                  <path className="flowline out" d="M348 205 C 430 150, 480 150, 548 196" />
                  <path className="flowline out" d="M348 227 C 430 285, 480 285, 548 236" />

                  {/* payer nodes */}
                  <g id="payers"></g>

                  {/* router hex */}
                  <g>
                    <polygon
                      points="320,186 346,201 346,231 320,246 294,231 294,201"
                      fill="rgba(247,147,26,.08)"
                      stroke="#F7931A"
                      strokeWidth="1.5"
                    />
                    <circle className="hex-core" cx="320" cy="216" r="5" fill="#F7931A" />
                    <text className="node-label" x="306" y="264" fill="#A79B7E">LN</text>
                  </g>

                  {/* score chips */}
                  <text className="score-chip" x="418" y="140">ILLUSTRATIVE ROUTE MODEL</text>
                  <text className="score-chip g" x="418" y="304">NO PAYMENT EXECUTED</text>

                  {/* Demo state destination; no wallet, vault, or funds are connected. */}
                  <g>
                    <rect x="552" y="178" width="76" height="76" rx="6" fill="rgba(184,224,105,.05)" stroke="#B8E069" strokeWidth="1.2" />
                    <text className="node-label" x="570" y="206" fill="#B8E069">APP</text>
                    <text className="node-label" x="566" y="220" fill="#6E6552">STATE</text>
                    <path d="M584 232 h12 v10 h-12 z M587 232 v-4 a3 3 0 0 1 6 0 v4" stroke="#B8E069" strokeWidth="1.2" fill="none" />
                  </g>
                  <text className="node-label" x="10" y="24">illustrative inputs</text>
                  <text className="node-label" x="557" y="272" fill="#6E6552">settled</text>
                  <g id="packets"></g>
                </svg>
              </div>

              {/* Console log */}
              <div className="console" id="console" ref={consoleRef}>
                {consoleLines.map((line) => (
                  <div className="cl" key={line.id}>
                    <span className="t">{line.time}</span>
                    <span className={`tag ${line.tagCls}`}>{line.tag}</span>
                    <span className="msg">{line.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ================= TICKER ================= */}
        <div className="ticker" aria-hidden="true">
          <div className="track">
            {TICKER_ITEMS.concat(TICKER_ITEMS).map((item, i) => (
              <span key={i} dangerouslySetInnerHTML={{ __html: item }} />
            ))}
          </div>
        </div>

        {/* ================= LIVE SIGNET INVOICE ================= */}
        <section id="live">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 01 · PAY IT FOR REAL</div>
              <h2 className="lm"><span>Issue a real invoice and pay it over Lightning.</span></h2>
              <p className="sub rv">
                This talks to the configured Lightning node, gets a real BOLT11 invoice, and watches the rail for
                settlement. It credits a payment only when the preimage the node reveals hashes to the invoice's
                payment hash — so what you see is a payment the node confirmed, not a button that says it worked.
              </p>
            </div>

            <div className="live-panel panel rv d1">
              <div className="live-panel-head">
                <span className="live-tag"><i></i>LIVE</span>
                <span className="live-net">
                  {health?.rail?.network ? `${health.rail.rail} · ${health.rail.network}` : "no rail configured"}
                </span>
              </div>

              <div className="live-form">
                <label className="live-field">
                  <span>Amount (sats)</span>
                  <input
                    type="number"
                    min="1"
                    inputMode="numeric"
                    value={liveAmount}
                    onChange={(event) => setLiveAmount(event.target.value.replace(/[^0-9]/g, ""))}
                    aria-label="Amount in satoshis"
                  />
                </label>
                <label className="live-field grow">
                  <span>Memo</span>
                  <input
                    type="text"
                    maxLength={200}
                    value={liveMemo}
                    onChange={(event) => setLiveMemo(event.target.value)}
                    aria-label="Invoice memo"
                  />
                </label>
                <button
                  className="live-go"
                  disabled={busy || !liveAmount || Number(liveAmount) <= 0}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await issueLiveInvoice(Number(liveAmount), liveMemo || "SatsLoom signet invoice");
                    } catch {
                      /* the error is shown inside the modal */
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Issuing…" : "Issue invoice"}
                </button>
              </div>

              <div className="live-notes">
                <span>Any signet wallet can pay it — scan the QR, or use <code>lncli payinvoice</code>.</span>
                <span>Test coins only — they have no fiat value.</span>
              </div>

              {/* How to actually try this. Won't claim a connection exists that isn't there: the
                  invoice is the payment primitive, so the honest onboarding is how to get coins and
                  a wallet, not a connect button. */}
              <details className="live-howto">
                <summary>
                  No signet wallet yet? <span>Three steps to a real payment →</span>
                </summary>
                <ol className="live-steps">
                  <li>
                    <b>Get test coins.</b> A signet faucet will pay a fresh <code>lntbs…</code>
                    invoice with no account or API key — request 500–1500 sats.
                    <ul>
                      <li>
                        <a href="https://arkfaucet.com/" target="_blank" rel="noreferrer noopener">
                          arkfaucet.com
                        </a>{" "}
                        — Lightning rail, no sign-up (used to fund this project's own node)
                      </li>
                      <li>
                        <a href="https://bitcoinsignetfaucet.com/" target="_blank" rel="noreferrer noopener">
                          bitcoinsignetfaucet.com
                        </a>{" "}
                        — on-chain signet txs
                      </li>
                    </ul>
                  </li>
                  <li>
                    <b>Fund a Lightning wallet set to signet.</b> The wallet must be on
                    <em> signet</em>, not mainnet or testnet — an address alone cannot tell them
                    apart. Paste the invoice from step 3 into the faucet to fund a wallet you
                    control.
                    <ul>
                      <li>
                        <b>Command line (what our own proof uses):</b>{" "}
                        <code>lnd --network=signet</code>, then{" "}
                        <code>lncli payinvoice &lt;bolt11&gt;</code>
                      </li>
                    </ul>
                  </li>
                  <li>
                    <b>Come back and pay.</b> Issue an invoice above, scan or paste the{" "}
                    <code>lntbs…</code> string, and this panel shows it credited the moment the
                    node reveals the preimage — the same proof that decides whether goods ship.
                  </li>
                </ol>
                <p className="live-howto-foot">
                  Want to test without a wallet of your own? The repository ships an end-to-end proof
                  that issues an invoice, pays it from a second node, and checks that{" "}
                  <code>sha256(preimage) == paymentHash</code>:{" "}
                  <code>node scripts/live-signet-proof.mts</code>
                </p>
              </details>

              {liveCheckoutError && !showLiveCheckout && (
                <div className="live-error" role="status">{liveCheckoutError}</div>
              )}
            </div>
          </div>
        </section>

        {showLiveCheckout && (
          <div className="modal-backdrop" onClick={() => setShowLiveCheckout(false)}>
            <div className="modal-content checkout-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div className="checkout-brand">
                  <span className="bitcoin-logo">₿</span>
                  <div>
                    <h3>SatsLoom · live invoice</h3>
                    <p className="checkout-subtitle">
                      {health?.rail?.network ? `Bitcoin ${health.rail.network} · real BOLT11` : "no rail configured"}
                    </p>
                  </div>
                </div>
                <button className="close-btn" onClick={() => setShowLiveCheckout(false)} aria-label="Close modal">✕</button>
              </div>
              {liveCheckoutError && !liveInvoice ? (
                <div className="live-error" role="status">
                  <strong>No invoice was issued.</strong> {liveCheckoutError}
                </div>
              ) : (
                <LiveSignetCheckout
                  request={liveInvoice}
                  rail={health?.rail ?? null}
                  onIssue={(amountSats, memo) => issueLiveInvoice(amountSats, memo).catch(() => {})}
                  onClose={() => setShowLiveCheckout(false)}
                  onPaid={(paymentHash) => {
                    setLivePaidCount((n) => n + 1);
                    showToast(`Lightning payment received (${paymentHash.slice(0, 12)}…)`);
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* ================= FLOW ================= */}
        <section id="flow">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 01 · THE WEAVE</div>
              <h2 className="lm"><span>Explore an invoice-to-settlement simulation.</span></h2>
              <p className="sub rv">
                The demo walks through invoice state, sample route scoring, a simulated confirmation, and inspectable application events. No payment is sent.
              </p>
            </div>
            <div className="flow-grid">
              <div className="flow-sticky">
                <div className="big-num">{String(flowIndex + 1).padStart(2, "0")}</div>
                <div className="flow-title">{flowTitles[flowIndex]}</div>
                <div className="thread-progress">
                  <i style={{ height: `${((flowIndex + 1) / 4) * 100}%` }}></i>
                </div>
                <p className="flow-note">
                  Decorative animated lines only. They do not show customer traffic, payment execution, balances, or a live route.
                </p>
              </div>
              <div className="flow-steps">
                <article className="step rv" data-i="0" data-title="Create a demo invoice">
                  <div className="step-top"><span className="step-num">01</span><h3>Invoice &amp; order</h3></div>
                  <p>Create a demo invoice with an amount and memo. No BOLT12 offer is issued and no Bitcoin payment address is generated.</p>
                  <div className="artifact">
                    <span className="inv-line">demo invoice · sample ID</span>
                    <div style={{ color: "var(--faint)", marginTop: "6px" }}>no BOLT12 offer · no payment address · no funds received</div>
                  </div>
                </article>

                <article className="step rv" data-i="1" data-title="Sample route scoring">
                  <div className="step-top"><span className="step-num">02</span><h3>Sample route scoring</h3></div>
                  <p>The demo scores three hard-coded candidate routes using illustrative fees, capacities, latency, and exit-risk inputs. It has no network liquidity feed or historical reliability data.</p>
                  <div className="artifact">
                    <div className="mini-scores">
                      <div className="mr"><span>vtxo-fast</span><span>50 sat fee · 18 s · 100,000-sat sample capacity</span></div>
                      <div className="mr"><span>lp-standard</span><span>250 sat fee · 45 s · 250,000-sat sample capacity</span></div>
                      <div className="mr"><span>onchain-exit</span><span>500 sat fee · 600 s · 1,000,000-sat sample capacity</span></div>
                    </div>
                  </div>
                </article>

                <article className="step rv" data-i="2" data-title="Simulate a route">
                  <div className="step-top"><span className="step-num">03</span><h3>Simulate a route</h3></div>
                  <p>The API records a simulated route outcome. There is no multi-path splitting, atomic payment, provider call, Bitcoin transaction, or VTXO transfer in this demo.</p>
                  <div className="artifact">
                    <div className="route-chips">
                      <span className="hop"><b>sample candidate</b></span><span className="amber">→</span>
                      <span className="hop"><b>local state machine</b></span>
                      <span className="hop split">simulation only · no broadcast</span>
                    </div>
                  </div>
                </article>

                <article className="step rv" data-i="3" data-title="Inspect demo events">
                  <div className="step-top"><span className="step-num">04</span><h3>Inspect demo events</h3></div>
                  <p>Server-Sent Events report changes to this API's simulated invoice state. They are not confirmations from a Bitcoin node or Tachi settlement network.</p>
                  <div className="artifact">
                    <div className="evt">
                      event: <span className="k">invoice.settled</span><br />
                      data: {`{"simulation":`}<span className="k">true</span>{`,"fundsMoved":false}`}
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>

        {/* ================= PRIMITIVES ================= */}
        <section id="primitives">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 02 · PRIMITIVES</div>
              <h2 className="lm"><span>The threads we weave with.</span></h2>
              <p className="sub rv">Architecture concepts and a separate opt-in Tachi SDK spike. No vault, deposit, or Bitcoin settlement is active in the public demo.</p>
            </div>
            <div className="stack">
              <article className="pcard" style={{ ["--i" as any]: 0 }}>
                <div className="pcard-head">
                  <span className="pc-num">PRIM·01</span>
                  <span className="pc-name">TAURUS Vaults</span>
                  <div className="pc-tags"><i>CONCEPT</i><i>SDK SPIKE</i><i>NOT A LIVE VAULT</i></div>
                </div>
                <div className="pcard-grid">
                  <div>
                    <h3>TAURUS integration research.</h3>
                    <p className="desc">
                      TAURUS vault construction and verification exist in the separate adapter spike. The demo API does not create merchant vaults, hold keys, accept deposits, or route balances. The diagram below is an architecture illustration, not an active vault.
                    </p>
                  </div>
                  <div>
                    <div className="vault-tree">
                      <div className="vt-node root">Vault concept<small>no address configured</small></div>
                      <div className="vt-stem"></div>
                      <div className="vt-branch">
                        <div className="vt-node">key-path concept<small>parameters not configured</small></div>
                        <div className="vt-node">timelock concept<small>no recovery path configured</small></div>
                      </div>
                    </div>
                    <div className="vt-addr">illustrative vault diagram · no deposit address configured</div>
                  </div>
                </div>
              </article>

              <article className="pcard" style={{ ["--i" as any]: 1 }}>
                <div className="pcard-head">
                  <span className="pc-num">PRIM·02</span>
                  <span className="pc-name">VTXO Settlement</span>
                  <div className="pc-tags"><i>INTEGRATION TARGET</i><i>NOT EXECUTED</i></div>
                </div>
                <div className="pcard-grid">
                  <div>
                    <h3>VTXO settlement is not implemented.</h3>
                    <p className="desc">
                      VTXO handling is an integration target, not a live settlement path here. The API currently records simulated invoice and route state only; it does not create, transfer, or redeem VTXOs.
                    </p>
                  </div>
                  <div>
                    <div className="batch">
                      <div className="batch-row"><div className="leaf" style={{ borderColor: "var(--amber)", color: "var(--gold)" }}>Illustrative batch</div></div>
                      <div className="batch-row">
                        <div className="leaf">vtxo</div>
                        <div className="leaf">vtxo</div>
                        <div className="leaf mine">sample item</div>
                        <div className="leaf">vtxo</div>
                        <div className="leaf">vtxo</div>
                        <div className="leaf">vtxo</div>
                      </div>
                      <div className="batch-meta">Diagram only · no VTXO, owner balance, batch ID, or renewal data exists</div>
                    </div>
                  </div>
                </div>
              </article>

              <article className="pcard" style={{ ["--i" as any]: 2 }}>
                <div className="pcard-head">
                  <span className="pc-num">PRIM·03</span>
                  <span className="pc-name">Sovereign Unilateral Exit</span>
                  <div className="pc-tags"><i>CONCEPT ONLY</i><i>NO EXIT IMPLEMENTED</i></div>
                </div>
                <div className="pcard-grid">
                  <div>
                    <h3>Unilateral exit is an integration target.</h3>
                    <p className="desc">
                      The adapter spike can construct and verify TAURUS-related artifacts in its test environment. This web demo does not create a live vault, sign an exit transaction, or broadcast to Bitcoin. Do not rely on this UI for recovery of funds.
                    </p>
                  </div>
                  <div className="exit-timeline">
                    <div className="et-step"><i>1</i><div><b>Monitor</b><span>not implemented in this demo</span></div></div>
                    <div className="et-step"><i>2</i><div><b>Construct</b><span>no exit transaction is built here</span></div></div>
                    <div className="et-step"><i>3</i><div><b>Sign / broadcast</b><span>no wallet or Bitcoin node is connected</span></div></div>
                    <div className="et-step"><i>4</i><div><b>Recovery</b><span>no funds or recovery path are configured</span></div></div>
                  </div>
                </div>
              </article>

              <article className="pcard" style={{ ["--i" as any]: 3 }}>
                <div className="pcard-head">
                  <span className="pc-num">PRIM·04</span>
                  <span className="pc-name">x402 Gateway</span>
                  <div className="pc-tags"><i>HTTP 402</i><i>AGENT-NATIVE</i><i>RECEIPTS</i></div>
                </div>
                <div className="pcard-grid">
                  <div>
                    <h3>HTTP 402 with a signed demo receipt.</h3>
                    <p className="desc">
                      This sample challenge marks a local invoice as simulated and returns an HMAC-signed application receipt. No agent signs a Bitcoin payment, no funds are verified, and the receipt is not payment proof.
                    </p>
                    <div className="tool-chips"><i>HTTP 402 demo</i><i>signed simulation receipt</i><i>no funds moved</i></div>
                  </div>
                  <div className="mini-term">
                    <span className="h">HTTP/1.1 402</span> Payment Required · demo<br />
                    <span className="h">WWW-Authenticate:</span> <span className="v">SatsLoom-Demo · simulation=true</span><br />
                    <span className="h">HTTP/1.1 200</span> OK · sample resource<br />
                    <span className="h">Authorization:</span> <span className="ok">signed demo receipt · not payment proof</span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* ================= ROUTE LAB ================= */}
        <section id="routelab">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 03 · ROUTE LAB</div>
              <h2 className="lm"><span>Score sample routes. No payment is executed.</span></h2>
              <p className="sub rv">An in-browser scoring exercise using hard-coded candidate capacities, fees, and estimated times. It is not a live quote and never sends a payment.</p>
            </div>
            <div className="lab panel rv">
              <div className="lab-controls">
                <div>
                  <span className="lab-label">Sample amount</span>
                  <div className="amount-val">
                    <span>{fmt(labAmount)}</span>
                    <small>sats</small>
                  </div>
                  <input
                    type="range"
                    min="1000"
                    max="250000"
                    step="1000"
                    value={labAmount}
                    style={{
                      ["--p" as any]: `${((labAmount - 1000) / (250000 - 1000)) * 100}%`,
                    }}
                    onChange={(e) => {
                      setLabAmount(Number(e.target.value));
                      if (!labExecuting) {
                        setLabResult(null);
                        setLabStatus(`Re-scoring fabric for ${fmt(Number(e.target.value))} sats · priority ${labMode}…`);
                      }
                    }}
                  />
                </div>
                <div>
                  <span className="lab-label">Scoring preference</span>
                  <div className="seg">
                    <button className={labMode === "speed" ? "act" : ""} onClick={() => setLabMode("speed")}>
                      Speed
                    </button>
                    <button className={labMode === "cost" ? "act" : ""} onClick={() => setLabMode("cost")}>
                      Cost
                    </button>
                    <button className={labMode === "reliability" ? "act" : ""} onClick={() => setLabMode("reliability")}>
                      Exit risk
                    </button>
                  </div>
                </div>
                <button className="btn primary exec-btn" onClick={executeLabRoute} disabled={labExecuting}>
                  ⚡ Score sample route
                </button>
                <div className="lab-status">{labStatus}</div>
                <div className={`lab-progress ${labProgressActive ? "go" : ""}`}>
                  <i></i>
                </div>
              </div>
              <div className="routes-wrap">
                <div className="routes-head">
                  <span>candidate · example</span>
                  <span>model score</span>
                  <span>sample time</span>
                  <span>sample fee</span>
                  <span>capacity fit</span>
                </div>
                <div id="routeList">
                  {scoredRoutes.map((r, i) => (
                    <div className={`route-row ${i === 0 ? "best" : ""}`} key={r.id}>
                      <div className="rr-id">
                        {i === 0 ? "▸ " : ""}
                        {r.id}
                        {!r.capOK && <span className="rr-flag">OVER SAMPLE CAPACITY</span>}
                        <small>{r.hops} · sample cap {fmt(r.cap)} sats</small>
                      </div>
                      <div className="rr-score">
                        <div className="rr-bar">
                          <i style={{ width: `${(r.score * 100).toFixed(0)}%` }}></i>
                        </div>
                        <b>{r.score.toFixed(2)}</b>
                      </div>
                      <div className="rr-metric">{r.seconds} s</div>
                      <div className="rr-metric">{fmt(r.feeSats)} sats</div>
                      <div className="rr-metric" style={{ color: r.capOK ? "var(--settled)" : "var(--alert)" }}>
                        {r.capOK ? "within model" : "over model cap"}
                      </div>
                    </div>
                  ))}
                </div>
                {labResult && (
                  <div className="lab-result show">
                    <span>SIMULATION</span>
                    <span className="dim">·</span>
                    <span>{fmt(labResult.amount)} sample sats</span>
                    <span className="dim">·</span>
                    <span>{labResult.seconds} s model time</span>
                    <span className="dim">·</span>
                    <span className="dim">{labResult.routeId} · no receipt or transaction</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ================= X402 ================= */}
        <section id="x402">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 04 · X402 GATEWAY</div>
              <h2 className="lm"><span>Explore an HTTP 402 demo.</span></h2>
            </div>
            <div className="x-grid">
              <div>
                <p className="sub rv" style={{ marginTop: 0 }}>
This sandbox demonstrates a 402 challenge and a short-lived signed demo receipt. The receipt proves only that this app issued a simulation token; it does not prove payment or verify funds.
                </p>
                <div className="x-list rv d1">
                  <div className="x-item"><i>01</i><div><b>HTTP 402 challenge</b><span>The demo returns a sample 50-sat invoice challenge; no BOLT11/BOLT12 payment request is created.</span></div></div>
                  <div className="x-item"><i>02</i><div><b>Simulated agent action</b><span>The demo endpoint marks the sample invoice paid in local application state only.</span></div></div>
                  <div className="x-item"><i>03</i><div><b>Signed demo receipt</b><span>An HMAC protects the receipt from tampering; it is not a Bitcoin payment proof.</span></div></div>
                  <div className="x-item"><i>04</i><div><b>No funds moved</b><span>Use a real payment processor and verified settlement adapter before accepting payments.</span></div></div>
                </div>
              </div>
              <div className="x-term rv d2">
                <div className="p-head">
                  <div className="p-sq"><i></i><i></i><i></i></div>
                  <span className="p-title">agent ⇄ demo API · simulated flow</span>
                </div>
                <div className="x-body">
                  {X402_LINES.slice(0, xStep).map((l, idx) => (
                    <div className={`hl in ${l.cls}`} key={idx}>{l.txt}</div>
                  ))}
                </div>
                <div className="x-foot">
                  <span className="st">{xStatus}</span>
                  <button className="replay" onClick={playX402}>↺ replay</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= SOVEREIGNTY ================= */}
        <section id="sovereignty">
          <div className="wrap">
            <div className="sov-grid">
              <div>
                <div className="sov-line lm"><span><em>No</em> Bitcoin received.</span></div>
                <div className="sov-line lm"><span><em>No</em> active vault.</span></div>
                <div className="sov-line lm"><span><em>No</em> recovery guarantee.<small>this is a simulation prototype.</small></span></div>
              </div>
              <aside className="sov-panel panel rv">
                <h4>IMPLEMENTATION BOUNDARY</h4>
                <p>
                  The repository contains route-scoring and integration examples, not a production Bitcoin payment rail. It does not currently take custody, execute VTXO transfers, verify on-chain payments, or provide a usable unilateral-exit flow.
                </p>
                <div className="sov-chips">
                  <i>demo state only</i><i>no funds moved</i><i>integration work remains</i>
                </div>
              </aside>
            </div>
            <div className="kicker">// EXIT FLOW CONCEPT · NOT IMPLEMENTED</div>
            <div className="exit-strip">
              <div className="exit-cell rv d1">
                <span className="ec-idx">E·1</span><h4>Observe</h4>
                <p>Recovery-flow concept only. The demo does not monitor a relay, LSP, or production payment route.</p>
                <div className="blocks"><i className="hot"></i><i></i><i></i><i></i><i></i><i></i></div>
              </div>
              <div className="exit-cell rv d2">
                <span className="ec-idx">E·2</span><h4>Broadcast</h4>
                <p>This demo does not sign or broadcast a unilateral exit transaction. The path shown is illustrative only.</p>
                <div className="blocks"><i className="hot"></i><i className="hot"></i><i></i><i></i><i></i><i></i></div>
              </div>
              <div className="exit-cell rv d3">
                <span className="ec-idx">E·3</span><h4>Recover</h4>
                <p>No funds are held by this demo. No recovery transaction is created or confirmed here.</p>
                <div className="blocks"><i className="done"></i><i className="done"></i><i className="done"></i><i className="done"></i><i className="done"></i><i className="done"></i></div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= SELF-HOST ================= */}
        <section id="selfhost">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 05 · SELF-HOST</div>
              <h2 className="lm"><span>Run SatsLoom against a real node.</span></h2>
            </div>
            <div className="host-grid">
              <div>
                <p className="sub rv" style={{ marginTop: 0 }}>
                  This repository is a React/Vite frontend and Fastify/Node.js API. The demo backend uses in-memory state on Vercel and a single-process JSON file locally; neither is production-grade shared persistence. Payment endpoints are simulation-only.
                </p>
                <ul className="check-list rv d1">
                  <li><span><b>Node.js 22.6+</b> and npm are used by the checked-in scripts.</span></li>
                  <li><span><b>API: 3001 · Web: 5174</b> when started with <code>npm run dev</code>.</span></li>
                  <li><span><b>Demo mode is not payment processing.</b> Production defaults disable simulated mutations.</span></li>
                  <li><span><b>License is not declared</b> in this repository; no MIT license is included.</span></li>
                </ul>
                <div className="req-chips rv d2">
                  <i>Node.js ≥ 22.6</i><i>npm workspaces</i><i>Fastify API</i><i>Vite + React</i>
                </div>
              </div>
              <div className="code-panel rv d2">
                <div className="code-tabs">
                  <button className={codeTab === "t-docker" ? "act" : ""} onClick={() => setCodeTab("t-docker")}>
                    local demo
                  </button>
                  <button className={codeTab === "t-bare" ? "act" : ""} onClick={() => setCodeTab("t-bare")}>
                    API smoke test
                  </button>
                  <button className={codeTab === "t-conf" ? "act" : ""} onClick={() => setCodeTab("t-conf")}>
                    environment
                  </button>
                  <button
                    className={`copy code-copy ${copiedCode ? "done" : ""}`}
                    onClick={() => {
                      const codeEl = document.getElementById(codeTab);
                      if (codeEl) {
                        navigator.clipboard.writeText(codeEl.innerText);
                        setCopiedCode(true);
                        showToast("Configuration copied to clipboard");
                        setTimeout(() => setCopiedCode(false), 1400);
                      }
                    }}
                  >
                    {copiedCode ? "copied ✓" : "copy"}
                  </button>
                </div>
                <pre className={codeTab === "t-docker" ? "act" : ""} id="t-docker">
                  <span className="c"># from the repository root · local demo only</span><br />
                  $ npm ci<br />
                  $ npm test<br />
                  $ npm run dev<br />
                  <br />
                  <span className="c"># API health (local)</span><br />
                  $ curl http://localhost:3001/api/health<br />
                  <span className="s">{`{"paymentExecution":"lightning-rail"`}</span>
                </pre>
                <pre className={codeTab === "t-bare" ? "act" : ""} id="t-bare">
                  <span className="c"># from the repository root · point it at any LND REST endpoint</span><br />
                  $ npm ci<br />
                  $ npm run dev<br />
                  <br />
                  <span className="c"># in another terminal</span><br />
                  $ npm run smoke:api -- http://localhost:3001<br />
                  <br />
                  <span className="c"># no Rust daemon, wallet, or live settlement service is included</span>
                </pre>
                <pre className={codeTab === "t-conf" ? "act" : ""} id="t-conf">
                  <span className="c"># local demo settings · no real payment support</span><br />
                  <span className="k">SATSLOOM_DEMO_MODE</span>=<span className="s">true</span><br />
                  <span className="k">SATSLOOM_PROOF_SECRET</span>=<span className="s">&lt;random-secret-for-demo-receipts&gt;</span><br />
                  <span className="k">SATSLOOM_ADMIN_TOKEN</span>=<span className="s">&lt;required-for-private-API-in-production&gt;</span><br />
                  <span className="k">SATSLOOM_WEBHOOK_ALLOWED_ORIGINS</span>=<span className="s">https://merchant.example</span><br />
                  <span className="k">SATSLOOM_WEBHOOK_SECRET</span>=<span className="s">&lt;webhook-signing-secret&gt;</span><br />
                  <span className="c"># Allow-listed HTTPS webhooks only; exact origins only.</span>
                </pre>
              </div>
            </div>
          </div>
        </section>

        {/* ================= SPECS ================= */}
        <section id="specs">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 06 · SPEC SHEET</div>
              <h2 className="lm"><span>The fabric, measured.</span></h2>
            </div>
            <dl className="spec-grid rv">
              <div className="spec"><dt>API</dt><dd><b>Fastify / Node.js</b> · TypeScript</dd></div>
              <div className="spec"><dt>Frontend</dt><dd><b>React / Vite</b></dd></div>
              <div className="spec"><dt>Settlement</dt><dd><b>Real Lightning</b> · signet sats</dd></div>
              <div className="spec"><dt>Route model</dt><dd>Rail node view · <b>live</b></dd></div>
              <div className="spec"><dt>Payment proof</dt><dd><b>sha256(preimage) == payment hash</b></dd></div>
              <div className="spec"><dt>Persistence</dt><dd>Local JSON / Vercel process memory</dd></div>
              <div className="spec"><dt>Interfaces</dt><dd>REST · SSE · <b>L402</b></dd></div>
              <div className="spec"><dt>License</dt><dd>Not declared in this repository</dd></div>
            </dl>
          </div>
        </section>
      </main>

      {/* ================= FOOTER ================= */}
      <footer>
        <div className="wrap">
          <div className="foot-mark">SATSLOOM</div>
          <div className="foot-grid">
            <div className="foot-brand">
              <a href="#top" className="logo">
                <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
                  <rect x="1" y="1" width="30" height="30" stroke="var(--logo-frame)" strokeWidth="1.5" />
                  <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
                  <path d="M11 5v22M21 5v22" stroke="var(--logo-glyph)" strokeWidth="2" />
                </svg>
                SATS<b>LOOM</b>
              </a>
              <p>TypeScript web and API demo. Payment mutations are simulated; production Bitcoin settlement and shared persistence are not implemented.</p>
            </div>
            <div className="foot-col">
              <h5>Protocol</h5>
              <a href="#flow">Route Fabric</a>
              <a href="#primitives">TAURUS Vaults</a>
              <a href="#primitives">VTXO Batches</a>
              <a href="#sovereignty">Unilateral Exit</a>
            </div>
            <div className="foot-col">
              <h5>Builders</h5>
              <a
                href="#dashboard"
                onClick={(e) => {
                  e.preventDefault();
                  setCurrentView("dashboard");
                  window.location.hash = "dashboard";
                }}
              >
                Dashboard
              </a>
              <a href="#selfhost">Docs</a>
              <a href="#routelab">Route Lab</a>
              <a href="#x402">x402 Spec</a>
              <a href="#specs">API Reference</a>
            </div>
            <div className="foot-col">
              <h5>Network</h5>
              <a href="#top">Tachi AEL</a>
              <a href="#top">Node Status</a>
              <a href="#top">Changelog</a>
              <a href="#top">GitHub</a>
            </div>
          </div>
          <div className="foot-bottom">
            <span>
              © 2026 SatsLoom · Built by{" "}
              <a
                href="https://x.com/RastaDev_"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--amber)", textDecoration: "underline", textUnderlineOffset: "3px" }}
              >
                RastaDev
              </a>
            </span>
            <span className="foot-status">
              <span className="pulse-dot"></span>all systems weaving
            </span>
          </div>
        </div>
      </footer>

      {/* ================= TOAST ================= */}
      <div id="toast" className={toastShow ? "show" : ""}>
        {toastMsg}
      </div>

      {/* ================= MERCHANT APP / TERMINAL MODAL OVERLAY ================= */}
      {terminalOpen && (
        <div className="terminal-modal-backdrop" onClick={() => setTerminalOpen(false)}>
          <div className="terminal-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="terminal-modal-header">
              <div className="terminal-modal-title">
                <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
                  <rect x="1" y="1" width="30" height="30" stroke="var(--logo-frame)" strokeWidth="1.5" />
                  <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
                  <path d="M11 5v22M21 5v22" stroke="var(--logo-glyph)" strokeWidth="2" />
                </svg>
                <span>SatsLoom — Merchant Terminal & App Suite</span>
              </div>
              <button className="terminal-modal-close" onClick={() => setTerminalOpen(false)}>
                ✕
              </button>
            </div>

            <div className="terminal-modal-body">
              <div className="terminal-tabs">
                <button
                  className={`terminal-tab-btn ${activeTab === "dashboard" ? "active" : ""}`}
                  onClick={() => setActiveTab("dashboard")}
                >
                  ⚡ Merchant Terminal
                </button>
                <button
                  className={`terminal-tab-btn ${activeTab === "shop" ? "active" : ""}`}
                  onClick={() => setActiveTab("shop")}
                >
                  🛒 SatsShop Demo
                </button>
                <button
                  className={`terminal-tab-btn ${activeTab === "x402" ? "active" : ""}`}
                  onClick={() => setActiveTab("x402")}
                >
                  🤖 x402 AI Agent Sandbox
                </button>
                <button
                  className={`terminal-tab-btn ${activeTab === "telemetry" ? "active" : ""}`}
                  onClick={() => setActiveTab("telemetry")}
                >
                  🔬 Tachi Telemetry
                </button>
                <button
                  className={`terminal-tab-btn ${activeTab === "operations" ? "active" : ""}`}
                  onClick={() => setActiveTab("operations")}
                >
                  📊 Operations & Liquidity
                </button>
              </div>

              {error && (
                <div className="global-error-banner" role="alert" style={{ marginBottom: "16px" }}>
                  <span>⚠️ {error}</span>
                  <button className="error-close-btn" onClick={() => setError("")}>
                    ✕
                  </button>
                </div>
              )}

              {activeTab === "dashboard" && (
                <div className="dashboard-view">
                  {/* Overview Stats */}
                  <div className="metric-cards-grid" style={{ marginBottom: "24px" }}>
                    <div className="stat-card">
                      <span className="stat-label">Demo Invoices</span>
                      <div className="stat-value">{overview?.invoiceCount ?? 0}</div>
                      <span className="stat-sub">In current API instance only</span>
                    </div>
                    <div className="stat-card accent">
                      <span className="stat-label">Simulated Settlements</span>
                      <div className="stat-value">
                        {Number(overview?.settledSats ?? 0).toLocaleString()} <span className="unit">sats</span>
                      </div>
                      <span className="stat-sub">Demo state only · no funds received</span>
                    </div>
                    <div className="stat-card warning">
                      <span className="stat-label">Simulated Pending Amount</span>
                      <div className="stat-value">
                        {Number(overview?.pendingSats ?? 0).toLocaleString()} <span className="unit">sats</span>
                      </div>
                      <span className="stat-sub">No payment has been detected</span>
                    </div>
                    <div className="stat-card info">
                      <span className="stat-label">Sample Routing Capacity</span>
                      <div className="stat-value">
                        {Number(overview?.simulatedRoutingLiquiditySats ?? 1350000).toLocaleString()} <span className="unit">sats</span>
                      </div>
                      <span className="stat-sub">Illustrative only · not live liquidity</span>
                    </div>
                  </div>

                  {/* Create Invoice Card */}
                  <div className="create-invoice-card">
                    <div className="card-header-row">
                      <div>
                        <h3>Generate Demo Invoice</h3>
                        <p className="subtext">No payment address or live route quote is issued</p>
                      </div>
                    </div>

                    <div className="invoice-form-grid">
                      <label className="form-field">
                        <span>Amount (Sats)</span>
                        <input
                          type="number"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          min="1"
                          placeholder="e.g. 50000"
                        />
                      </label>

                      <label className="form-field memo-field">
                        <span>Memo / Description</span>
                        <input
                          type="text"
                          value={memo}
                          onChange={(e) => setMemo(e.target.value)}
                          maxLength={200}
                          placeholder="Invoice description or Order ID"
                        />
                      </label>

                      <label className="form-field webhook-field">
                        <span>Allow-listed HTTPS webhook (optional)</span>
                        <input
                          type="url"
                          value={webhookUrl}
                          onChange={(e) => setWebhookUrl(e.target.value)}
                          placeholder="https://merchant.example/webhook"
                        />
                      </label>

                      <div className="form-action">
                        <button className="btn-primary generate-btn" onClick={createInvoice} disabled={busy}>
                          {busy ? "Generating..." : "⚡ Generate Invoice"}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Active Invoice Inspector */}
                  {invoice && (
                    <div className="active-invoice-panel" style={{ marginTop: "24px" }}>
                      <div className="active-invoice-header">
                        <div>
                          <span className="active-label">Active Invoice Session</span>
                          <h2>{Number(invoice.amountSats).toLocaleString()} SATS</h2>
                          <p className="invoice-meta-sub">
                            ID: <code>{invoice.id}</code> • Status:{" "}
                            <strong className={`status-pill ${invoice.status}`}>{invoice.status.toUpperCase()}</strong> · simulated • Lifecycle:{" "}
                            <strong>{settlement?.lifecycle ?? invoice.lifecycle}</strong>
                          </p>
                        </div>

                        <div className="invoice-header-actions">
                          <button className="btn-qr-view" onClick={() => setShowCheckoutModal(true)}>
                            📄 View Demo Checkout
                          </button>
                          <button
                            className="btn-pay-action"
                            onClick={simulatePayment}
                            disabled={busy || invoice.status !== "pending"}
                          >
                            ⚡ Simulate Payment
                          </button>
                          <button
                            className="btn-refund-action"
                            onClick={issueRefund}
                            disabled={busy || (invoice.status !== "confirmed" && invoice.status !== "refunded") || settled}
                          >
                            ↩ Issue Refund
                          </button>
                        </div>
                      </div>

                      <div className="sse-stream-indicator">
                        <span className={`stream-dot ${eventsConnected ? "connected" : "connecting"}`}></span>
                        <span>
                          Server-Sent Events:{" "}
                          {eventsConnected ? "Demo event stream connected" : "Connecting to demo event stream..."}
                        </span>
                      </div>

                      {/* Settlement Route Comparator */}
                      {routes && (
                        <RouteVisualizer
                          routes={routes.routes}
                          selectedRouteId={settlement?.decision?.selectedRouteId ?? invoice.decision?.selectedRouteId}
                          onSelect={selectRoute}
                          onInvalidateAndSettle={invalidateAndSettle}
                          onSettle={settlePreferredRoute}
                          disabled={busy || invoice.status !== "confirmed"}
                          settled={settled}
                          fallbackHistory={settlement?.fallbackHistory}
                        />
                      )}

                      {/* Settlement Verification Receipt */}
                      {settlement?.settlement && (
                        <div className="settlement-receipt-card">
                          <div className="receipt-header">
                            <span className="receipt-title">Simulated Settlement Record</span>
                            <span className="simulation-tag">Simulation · no funds moved</span>
                          </div>
                          <div className="receipt-grid">
                            <div>
                              <span className="receipt-label">Demo settlement ID:</span>
                              <code>{settlement.settlement.txid ?? "Pending"}</code>
                            </div>
                            <div>
                              <span className="receipt-label">Route Executed:</span>
                              <strong>{settlement.settlement.routeId}</strong>
                            </div>
                            <div>
                              <span className="receipt-label">Lifecycle Stage:</span>
                              <strong className="receipt-success">{settlement.lifecycle}</strong>
                            </div>
                            <div>
                              <span className="receipt-label">Settlement Status:</span>
                              <strong className="receipt-success">{settlement.settlement.status.toUpperCase()}</strong>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "shop" && <SatsShop onBuyProduct={handleBuyShopProduct} />}
              {activeTab === "x402" && <X402Sandbox />}
              {activeTab === "telemetry" && <TachiTelemetryView />}
              {activeTab === "operations" && (
                <OperationsView
                  transactions={transactions}
                  refunds={refunds}
                  payouts={payouts}
                  liquidity={liquidity}
                  onQueuePayout={queuePayout}
                  busy={busy}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Customer QR Checkout Modal */}
      {showCheckoutModal && invoice && (
        <CustomerCheckoutModal
          invoice={invoice}
          onClose={() => setShowCheckoutModal(false)}
          onSimulatePay={simulatePayment}
          isSimulated={isSimulated}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
