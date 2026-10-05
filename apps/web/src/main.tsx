import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CustomerCheckoutModal } from "./components/QRCodeModal";
import { RouteVisualizer } from "./components/RouteVisualizer";
import { SatsShop } from "./components/SatsShop";
import { X402Sandbox } from "./components/X402Sandbox";
import { TachiTelemetryView } from "./components/TachiTelemetryView";
import { OperationsView } from "./components/OperationsView";
import { SatsLoomDashboard } from "./components/SatsLoomDashboard";
import "./style.css";

const API = "";
type ApiEnvelope = { data: any; mode: "live" | "degraded"; simulation?: boolean; error?: string; fallbackHistory?: any[] };

function normalizeInvoice(data: any) {
  if (!data) throw new Error("API returned an empty invoice");
  const invoice = data.invoice ?? data;
  if (!invoice.id) throw new Error("API invoice response is missing its id");
  return { ...invoice, lifecycle: data.lifecycle ?? invoice.lifecycle };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const LAB_ROUTES = [
  { id: "LQD-0x8f2e", hops: "ACINUS → TORUS → you", cap: 120000, base: 0.86, fee: 0.0021, ms: 210 },
  { id: "LQD-0x31aa", hops: "BOLTWORKS → you", cap: 64000, base: 0.79, fee: 0.0009, ms: 340 },
  { id: "LQD-0xb7c1", hops: "MERIDIAN → HALCYON → you", cap: 220000, base: 0.82, fee: 0.0034, ms: 180 },
  { id: "LQD-0x0d47", hops: "SATFORGE → you", cap: 38000, base: 0.74, fee: 0.0012, ms: 520 },
  { id: "LQD-0x9e15", hops: "NIGHTJAR → KEYSTONE → you", cap: 150000, base: 0.88, fee: 0.0028, ms: 260 },
];

const TICKER_ITEMS = [
  "VTXO <b>42,180 sats</b> settled in <i>291 ms</i>",
  "route <b>LQD-0x9e15</b> · score 0.97",
  "TAURUS vault depth <b>1.24 BTC</b> · exit leaf armed",
  "x402 <i>200 OK</i> · agent 0x77 · 4,200 sats",
  "multi-path split <b>62 / 38</b> · atomic",
  "invoice <b>ord_9f3a</b> · bolt12 issued",
  "batch <b>#812</b> renewed · 33h runway",
  "unilateral exit testnet drill · <i>passed</i>",
];

const X402_LINES = [
  { cls: "agent", txt: "→  GET /v1/pricing/feed        (agent 0x77)" },
  { cls: "merch", txt: "←  HTTP/1.1 402 Payment Required" },
  { cls: "dim", txt: "      X-PAYMENT-ACCEPT: sats.vtxo; net=bitcoin; max=5000" },
  { cls: "agent", txt: "→  POST /v1/pricing/feed" },
  { cls: "dim", txt: "      X-PAYMENT: AQBz4k…Q9vA==   (4,200 sats · signed)" },
  { cls: "weave", txt: "   ⚡ loomd weave: route LQD-0x9e15 · split 100% · 287ms" },
  { cls: "merch", txt: "←  HTTP/1.1 200 OK" },
  { cls: "head", txt: "      X-PAYMENT-RESPONSE: receipt=vtxo:9ac2f1… ✓" },
  { cls: "dim", txt: "      ── session complete · funds in merchant TAURUS vault ──" },
];

export function App() {
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
    if (window.location.hash === "#dashboard") {
      setCurrentView("dashboard");
    }
    const handleHash = () => {
      if (window.location.hash === "#dashboard") {
        setCurrentView("dashboard");
      } else if (!window.location.hash) {
        setCurrentView("landing");
      }
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  // Live stats
  const [routedSats, setRoutedSats] = useState(21041988);

  // Scramble headings
  const [scramble1, setScramble1] = useState("Native Bitcoin,");
  const [scramble2, setScramble2] = useState("woven into settlement.");

  // SVG Loom & Live Console
  const svgRef = useRef<SVGSVGElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [consoleLines, setConsoleLines] = useState<Array<{ id: string; time: string; tagCls: string; tag: string; msg: string }>>([]);

  // Flow section sticky states
  const [flowIndex, setFlowIndex] = useState(0);

  // Route Lab state
  const [labAmount, setLabAmount] = useState(21000);
  const [labMode, setLabMode] = useState<"speed" | "cost" | "reliability">("speed");
  const [labExecuting, setLabExecuting] = useState(false);
  const [labStatus, setLabStatus] = useState("Awaiting order… scores update live as you tune the thread.");
  const [labProgressActive, setLabProgressActive] = useState(false);
  const [labResult, setLabResult] = useState<{ amount: number; ms: number; routeId: string } | null>(null);

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
  const [settlement, setSettlement] = useState<any>();
  const [overview, setOverview] = useState<any>();
  const [liquidity, setLiquidity] = useState<any>();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [eventsConnected, setEventsConnected] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
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

    runScramble("Native Bitcoin,", setScramble1, 300);
    runScramble("woven into settlement.", setScramble2, 750);
  }, []);

  // Live routed ticker
  useEffect(() => {
    const iv = setInterval(() => {
      setRoutedSats((prev) => prev + (600 + ((Math.random() * 7200) | 0)));
    }, 2100);
    return () => clearInterval(iv);
  }, []);

  // Live console lines generator
  useEffect(() => {
    const rid = () => "LQD-0x" + Math.random().toString(16).slice(2, 6);
    const sat = () => fmt(900 + Math.random() * 80000);
    const ms = () => 180 + ((Math.random() * 420) | 0);
    const ts = () => {
      const d = new Date();
      return `[${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}]`;
    };
    const pool = [
      () => ({ tagCls: "ok", tag: "SETTLE", msg: `vtxo ${sat()} sats · ${ms()}ms · route ${rid()}` }),
      () => ({ tagCls: "amb", tag: "SCORE", msg: `${rid()} → 0.${90 + ((Math.random() * 9) | 0)} · fee ${(Math.random() * 0.3).toFixed(2)}%` }),
      () => ({ tagCls: "amb", tag: "ROUTE", msg: `multi-path split ${55 + ((Math.random() * 30) | 0)}/${10 + ((Math.random() * 30) | 0)} · atomic` }),
      () => ({ tagCls: "x", tag: "X402", msg: `402→200 · agent 0x${Math.random().toString(16).slice(2, 4)} · ${fmt(800 + Math.random() * 4000)} sats` }),
      () => ({ tagCls: "v", tag: "VAULT", msg: `taurus depth ${(0.8 + Math.random() * 1.4).toFixed(2)} BTC · exit leaf armed` }),
      () => ({ tagCls: "ok", tag: "VTXO", msg: `batch #${800 + ((Math.random() * 40) | 0)} renewed · runway 33h` }),
      () => ({ tagCls: "amb", tag: "INVOICE", msg: `bolt12 issued · ord_${Math.random().toString(16).slice(2, 6)} · ${sat()} sats` }),
    ];

    // Seed lines
    const initial = Array.from({ length: 5 }, (_, i) => {
      const item = pool[i % pool.length]();
      return { id: `init-${i}`, time: ts(), ...item };
    });
    setConsoleLines(initial);

    const interval = setInterval(() => {
      const item = pool[(Math.random() * pool.length) | 0]();
      setConsoleLines((prev) => [{ id: String(Date.now()), time: ts(), ...item }, ...prev.slice(0, 7)]);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // SVG Loom: flowing packets and vault fill animation
  useEffect(() => {
    if (currentView !== "landing") return;
    const svg = svgRef.current;
    if (!svg) return;
    const NS = "http://www.w3.org/2000/svg";

    const inPaths = ["p1", "p2", "p3", "p4", "p5"].map((id) => svg.getElementById(id) as SVGPathElement).filter(Boolean);
    const outPaths = ["o1", "o2"].map((id) => svg.getElementById(id) as SVGPathElement).filter(Boolean);
    const packetG = svg.getElementById("packets");
    const vaultFill = svg.getElementById("vaultFill");

    if (!packetG || inPaths.length === 0 || outPaths.length === 0) return;

    // Create payer labels & circles
    const pg = svg.getElementById("payers");
    if (pg && pg.children.length === 0) {
      const payerY = [60, 140, 220, 300, 380];
      const payerL = ["AGENT 0x3F", "STOREFRONT", "AGENT 0xA1", "SUBSCRIBER", "AGENT 0x77"];
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

    // Vault fill
    let fillH = 0;
    const vInterval = setInterval(() => {
      fillH += 6;
      if (fillH > 68) fillH = 6;
      if (vaultFill) {
        vaultFill.setAttribute("y", String(250 - fillH));
        vaultFill.setAttribute("height", String(fillH));
      }
    }, 900);

    return () => {
      cancelAnimationFrame(animId);
      clearInterval(vInterval);
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
          setXStatus("SETTLED ✓ 287ms");
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

  // Route Lab scoring
  const scoredRoutes = LAB_ROUTES.map((r) => {
    const capOK = labAmount <= r.cap;
    const speedN = clampN(1 - (r.ms - 150) / (600 - 150), 0, 1);
    const costN = clampN(1 - (r.fee - 0.0008) / (0.0036 - 0.0008), 0, 1);
    let s = 0;
    if (labMode === "speed") s = 0.44 * speedN + 0.2 * costN + 0.36 * r.base;
    else if (labMode === "cost") s = 0.44 * costN + 0.2 * speedN + 0.36 * r.base;
    else s = 0.52 * r.base + 0.24 * speedN + 0.24 * costN;
    if (!capOK) s *= 0.35;
    return { ...r, score: s, capOK, feeSats: Math.max(1, Math.round(labAmount * r.fee)) };
  }).sort((a, b) => b.score - a.score);

  const bestRoute = scoredRoutes[0];

  const executeLabRoute = () => {
    if (labExecuting) return;
    setLabExecuting(true);
    setLabResult(null);
    setLabProgressActive(true);

    const stages = bestRoute.capOK
      ? ["Scoring fabric… lock best thread…", `Executing on ${bestRoute.id}… allocating VTXO…`, "Settling into TAURUS vault…"]
      : ["Amount exceeds single thread — weaving multi-path split…", `Executing split across ${bestRoute.id} + fallback…`, "Atomic multi-part delivery… settling…"];

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
      const settleMs = bestRoute.ms + ((Math.random() * 60) | 0) - 20;
      setLabStatus(`SETTLED ✓ ${fmt(labAmount)} sats via ${bestRoute.id}${bestRoute.capOK ? "" : " (multi-path)"} · ${settleMs} ms`);
      setLabResult({ amount: labAmount, ms: settleMs, routeId: bestRoute.id });
      setRoutedSats((prev) => prev + labAmount);
      showToast(`⚡ ${fmt(labAmount)} sats settled in ${settleMs} ms`);
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
    api("/api/tachi/status")
      .then((response) => setStatus(response.data))
      .catch((cause) => setStatus({ error: cause instanceof Error ? cause.message : String(cause) }));
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
      await api("/api/payouts", {
        method: "POST",
        body: JSON.stringify({ amountSats: payoutAmount, destination }),
      });
      await refreshOperations();
    });
  };

  const handleBuyShopProduct = async (product: any) => {
    await action(async () => {
      const response = await api("/api/checkout/session", {
        method: "POST",
        body: JSON.stringify({
          amountSats: product.priceSats,
          orderId: `shop-${product.id}-${Date.now().toString().slice(-4)}`,
          memo: `SatsShop Order: ${product.name}`,
        }),
      });
      const created = normalizeInvoice(response.data);
      setInvoice(created);
      await refresh(created.id);
      setShowCheckoutModal(true);
    });
  };

  const isPaid = invoice?.status === "confirmed" || settlement?.lifecycle === "SETTLED" || invoice?.lifecycle === "SETTLED";
  const settled = settlement?.lifecycle === "SETTLED";

  const flowTitles = [
    "Invoice & order",
    "Multi-path route scoring",
    "Execute the best thread",
    "Settle as a VTXO, emit events",
  ];

  if (currentView === "dashboard") {
    return (
      <div className="dash-root">
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
                    <rect x="1" y="1" width="30" height="30" stroke="#2B2415" strokeWidth="1.5" />
                    <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
                    <path d="M11 5v22M21 5v22" stroke="#EFE7D3" strokeWidth="2" />
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
                          <p className="subtext">Issue instant native-sat invoices with automatic VTXO route quotation</p>
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
                          <span>Webhook URL (Optional)</span>
                          <input
                            type="url"
                            value={webhookUrl}
                            onChange={(e) => setWebhookUrl(e.target.value)}
                            placeholder="https://mysite.com/webhook"
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
                              <strong className={`status-pill ${invoice.status}`}>{invoice.status.toUpperCase()}</strong> • Lifecycle:{" "}
                              <strong>{settlement?.lifecycle ?? invoice.lifecycle}</strong>
                            </p>
                          </div>

                          <div className="invoice-header-actions">
                            <button className="btn-qr-view" onClick={() => setShowCheckoutModal(true)}>
                              📱 View Customer QR Code
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
                            {eventsConnected ? "Live Real-Time Stream Connected" : "Connecting to EventStream..."}
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
                              <span className="receipt-title">Settlement Verification Receipt</span>
                              <span className="simulation-tag">Tachi Regtest Simulation</span>
                            </div>
                            <div className="receipt-grid">
                              <div>
                                <span className="receipt-label">Settlement TxID:</span>
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
            isPaid={isPaid}
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
              <rect x="1" y="1" width="30" height="30" stroke="#2B2415" strokeWidth="1.5" />
              <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
              <path d="M11 5v22M21 5v22" stroke="#EFE7D3" strokeWidth="2" />
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
            {status?.daemon?.reachable ? "TACHI TESTNET · SYNCED" : "TESTNET · SYNCED"}
          </div>
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
              <rect x="1" y="1" width="30" height="30" stroke="#2B2415" strokeWidth="1.5" />
              <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
              <path d="M11 5v22M21 5v22" stroke="#EFE7D3" strokeWidth="2" />
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
                <span className="dot"></span>BUILT ON TACHI · AGENTIC EXECUTION LAYER
              </div>
              <h1 className="display">
                <span className="scramble">{scramble1}</span>
                <br />
                <span className="scramble l2">{scramble2}</span>
              </h1>
              <p className="lede rv d1">
                SatsLoom is a self-hosted, self-custodial settlement router and <em>x402</em> payment gateway. It weaves Lightning liquidity, VTXO batches and Taproot custody into one clean surface — for storefronts and autonomous agents alike. No wrapped tokens. No bridges. No custodians.
              </p>
              <div className="cta-row rv d2">
                <a className="btn primary" href="#selfhost">
                  Deploy SatsLoom
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
                <code>docker run -p 8402:8402 ghcr.io/satsloom/loomd</code>
                <button
                  className={`copy ${copiedDocker ? "done" : ""}`}
                  onClick={() => {
                    navigator.clipboard.writeText("docker run -p 8402:8402 ghcr.io/satsloom/loomd");
                    setCopiedDocker(true);
                    showToast("Docker command copied to clipboard");
                    setTimeout(() => setCopiedDocker(false), 1400);
                  }}
                >
                  {copiedDocker ? "copied ✓" : "copy"}
                </button>
              </div>
              <div className="stats rv d4">
                <div className="stat">
                  <span className="sv"><b className="count">340</b> ms</span>
                  <span className="sl">median settle</span>
                </div>
                <div className="stat">
                  <span className="sv"><b className="count">{fmt(routedSats)}</b></span>
                  <span className="sl">sats routed · live</span>
                </div>
                <div className="stat">
                  <span className="sv"><b className="count">99.98</b>%</span>
                  <span className="sl">router uptime</span>
                </div>
                <div className="stat">
                  <span className="sv"><b className="count">1,284</b></span>
                  <span className="sl">liquidity threads</span>
                </div>
              </div>
            </div>

            <div className="hero-panel panel rv d2">
              <div className="p-head">
                <div className="p-sq"><i></i><i></i><i></i></div>
                <span className="p-title">loomd — route fabric · testnet</span>
                <span className="live"><i></i>LIVE</span>
              </div>
              <div className="loom-stage">
                <svg id="loomSvg" ref={svgRef} viewBox="0 0 640 430" aria-label="Live route loom visualization">
                  {/* inbound threads */}
                  <path className="lp" id="p1" d="M64 60 C 170 60, 205 215, 292 215" />
                  <path className="lp" id="p2" d="M64 140 C 168 140, 205 215, 292 215" />
                  <path className="lp" id="p3" d="M64 220 C 165 220, 205 217, 292 216" />
                  <path className="lp" id="p4" d="M64 300 C 168 300, 205 218, 292 216" />
                  <path className="lp" id="p5" d="M64 380 C 170 380, 205 218, 292 216" />

                  {/* outbound multi-path split */}
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
                    <text className="node-label" x="306" y="264" fill="#A79B7E">loomd</text>
                  </g>

                  {/* score chips */}
                  <text className="score-chip" x="418" y="140">α 62% · score 0.97</text>
                  <text className="score-chip g" x="418" y="304">β 38% · score 0.93</text>

                  {/* vault */}
                  <g>
                    <rect x="552" y="178" width="76" height="76" rx="6" fill="rgba(184,224,105,.05)" stroke="#B8E069" strokeWidth="1.2" />
                    <rect id="vaultFill" x="556" y="250" width="68" height="0" fill="rgba(184,224,105,.22)" />
                    <text className="node-label" x="566" y="206" fill="#B8E069">TAURUS</text>
                    <text className="node-label" x="572" y="220" fill="#6E6552">P2TR</text>
                    <path d="M584 232 h12 v10 h-12 z M587 232 v-4 a3 3 0 0 1 6 0 v4" stroke="#B8E069" strokeWidth="1.2" fill="none" />
                  </g>
                  <text className="node-label" x="10" y="24">payers / agents</text>
                  <text className="node-label" x="560" y="272" fill="#6E6552">merchant vault</text>
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

        {/* ================= FLOW ================= */}
        <section id="flow">
          <div className="wrap">
            <div className="sec-head">
              <div className="kicker">// 01 · THE WEAVE</div>
              <h2 className="lm"><span>Four moves from invoice to settled sats.</span></h2>
              <p className="sub rv">
                SatsLoom treats every payment like a thread on a loom — scored, tensioned, and woven into the fastest clean settlement path.
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
                  loomd watches the fabric and re-scores routes continuously, so the move you execute is always the move that was measured a moment ago.
                </p>
              </div>
              <div className="flow-steps">
                <article className="step rv" data-i="0" data-title="Invoice & order">
                  <div className="step-top"><span className="step-num">01</span><h3>Invoice &amp; order</h3></div>
                  <p>Your storefront or agent creates a signed order. SatsLoom mints a bolt12 offer, pins the amount, and opens a payment session with full event telemetry from the first byte.</p>
                  <div className="artifact">
                    <span className="inv-line">lno1qgsy9mm0d3s3x2fwp5k8xqzrh4t6u…vx0k2</span>
                    <div style={{ color: "var(--faint)", marginTop: "6px" }}>bolt12 · 42,180 sats · order ord_9f3a</div>
                  </div>
                </article>

                <article className="step rv" data-i="1" data-title="Multi-path route scoring">
                  <div className="step-top"><span className="step-num">02</span><h3>Multi-path route scoring</h3></div>
                  <p>Candidate routes through the liquidity fabric are scored in parallel against latency, fee pressure, capacity headroom and historical reliability. Weak threads are dropped before a single sat moves.</p>
                  <div className="artifact">
                    <div className="mini-scores">
                      <div className="mr win"><span>LQD-0x9e15</span><span className="bar"><i style={{ width: "97%" }}></i></span><span className="green">0.97</span></div>
                      <div className="mr"><span>LQD-0xb7c1</span><span className="bar"><i style={{ width: "88%" }}></i></span><span>0.88</span></div>
                      <div className="mr"><span>LQD-0x8f2e</span><span className="bar"><i style={{ width: "74%" }}></i></span><span>0.74</span></div>
                    </div>
                  </div>
                </article>

                <article className="step rv" data-i="2" data-title="Execute the best thread">
                  <div className="step-top"><span className="step-num">03</span><h3>Execute the best thread</h3></div>
                  <p>The winning path executes — splitting across multiple threads when a single channel can't carry the full amount. Atomic multi-part delivery: all parts settle, or none do.</p>
                  <div className="artifact">
                    <div className="route-chips">
                      <span className="hop"><b>NIGHTJAR</b></span><span className="amber">→</span>
                      <span className="hop"><b>KEYSTONE</b></span><span className="amber">→</span>
                      <span className="hop"><b>YOUR VAULT</b></span>
                      <span className="hop split">split 62/38 · atomic</span>
                    </div>
                  </div>
                </article>

                <article className="step rv" data-i="3" data-title="Settle & emit events">
                  <div className="step-top"><span className="step-num">04</span><h3>Settle as a VTXO, emit events</h3></div>
                  <p>Payment lands as a VTXO inside a Taproot batch in your TAURUS vault — sub-second, off-chain, redeemable on-chain. Real-time events stream to your hooks the instant it does.</p>
                  <div className="artifact">
                    <div className="evt">
                      event: <span className="k">payment.settled</span><br />
                      data: {`{"order":"ord_9f3a","sats":`}<span className="k">42180</span>{`,"ms":291,"vtxo":"9ac2f1…"}`}
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
              <p className="sub rv">Four native Bitcoin primitives, zero intermediaries. Each one is a load-bearing thread in the fabric.</p>
            </div>
            <div className="stack">
              <article className="pcard" style={{ ["--i" as any]: 0 }}>
                <div className="pcard-head">
                  <span className="pc-num">PRIM·01</span>
                  <span className="pc-name">TAURUS Vaults</span>
                  <div className="pc-tags"><i>P2TR</i><i>NON-CUSTODIAL</i><i>KEYPATH SPEND</i></div>
                </div>
                <div className="pcard-grid">
                  <div>
                    <h3>Deposits anchored in native Taproot.</h3>
                    <p className="desc">
                      Every merchant balance lives in a <b>P2TR vault controlled by your keys</b>. SatsLoom reads the fabric and routes — it never holds. Two leaves, one root: spend instantly via keypath, or walk away through the timelock leaf whenever you choose. Nothing wrapped, nothing bridged, nothing trusted.
                    </p>
                  </div>
                  <div>
                    <div className="vault-tree">
                      <div className="vt-node root">root · bc1p…7q2f<small>taproot output</small></div>
                      <div className="vt-stem"></div>
                      <div className="vt-branch">
                        <div className="vt-node">keypath leaf<small>instant · your key</small></div>
                        <div className="vt-node">timelock leaf<small>CSV 48h · unilateral</small></div>
                      </div>
                    </div>
                    <div className="vt-addr">deposit address: <b>bc1p9xk…loom7q2f</b></div>
                  </div>
                </div>
              </article>

              <article className="pcard" style={{ ["--i" as any]: 1 }}>
                <div className="pcard-head">
                  <span className="pc-num">PRIM·02</span>
                  <span className="pc-name">VTXO Settlement</span>
                  <div className="pc-tags"><i>OFF-CHAIN</i><i>SUB-SECOND</i><i>BATCHED</i></div>
                </div>
                <div className="pcard-grid">
                  <div>
                    <h3>Sub-second settlement, batched like cloth.</h3>
                    <p className="desc">
                      Payments settle as <b>VTXOs inside Taproot batch trees</b> — off-chain and instant, yet redeemable on-chain at any time. Your loom renews leaves automatically before expiry, so your sats never sleep and never need a counterparty's blessing to exist.
                    </p>
                  </div>
                  <div>
                    <div className="batch">
                      <div className="batch-row"><div className="leaf" style={{ borderColor: "var(--amber)", color: "var(--gold)" }}>batch #812</div></div>
                      <div className="batch-row">
                        <div className="leaf">vtxo</div>
                        <div className="leaf">vtxo</div>
                        <div className="leaf mine">42,180 s · yours</div>
                        <div className="leaf">vtxo</div>
                        <div className="leaf">vtxo</div>
                        <div className="leaf">vtxo</div>
                      </div>
                      <div className="batch-meta">renew in <i>33h 12m</i> · auto-renew <i>ON</i> · merkle depth 3</div>
                    </div>
                  </div>
                </div>
              </article>

              <article className="pcard" style={{ ["--i" as any]: 2 }}>
                <div className="pcard-head">
                  <span className="pc-num">PRIM·03</span>
                  <span className="pc-name">Sovereign Unilateral Exit</span>
                  <div className="pc-tags"><i>NO CUSTODIAN</i><i>ON-CHAIN RECOURSE</i></div>
                </div>
                <div className="pcard-grid">
                  <div>
                    <h3>Walk away with everything. Any time.</h3>
                    <p className="desc">
                      If loomd, a relay, or a liquidity provider ever misbehaves, you <b>sign the exit leaf, broadcast one transaction</b>, and your full balance lands back in your on-chain wallet. No support tickets. No withdrawal queues. No permission required — the script guarantees it.
                    </p>
                  </div>
                  <div className="exit-timeline">
                    <div className="et-step"><i>1</i><div><b>Detect</b><span>relay silence or dispute observed by your node</span></div></div>
                    <div className="et-step"><i>2</i><div><b>Sign exit leaf</b><span>taproot path spend, signed locally with your key</span></div></div>
                    <div className="et-step"><i>3</i><div><b>Broadcast</b><span>single transaction to Bitcoin testnet / L1</span></div></div>
                    <div className="et-step"><i>4</i><div><b>Recover</b><span>full balance confirms — unilaterally, ~6 blocks</span></div></div>
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
                    <h3>The web's 402, finally settling.</h3>
                    <p className="desc">
                      Autonomous agents don't fill checkout forms. SatsLoom speaks <b>native HTTP 402</b>: a resource demands sats, the agent signs a VTXO payment in a header, and the response returns with a verifiable receipt. Machine-speed commerce, human-grade custody.
                    </p>
                    <div className="tool-chips"><i>mcp · satsloom.pay</i><i>sse · payment.settled</i><i>webhook fan-out</i></div>
                  </div>
                  <div className="mini-term">
                    <span className="h">HTTP/1.1 402</span> Payment Required<br />
                    <span className="h">X-PAYMENT-ACCEPT:</span> <span className="v">sats.vtxo; net=bitcoin; max=5000</span><br />
                    <span className="h">HTTP/1.1 200</span> OK <span className="dim">· 287 ms</span><br />
                    <span className="h">X-PAYMENT-RESPONSE:</span> <span className="ok">receipt=vtxo:9ac2f1… ✓</span>
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
              <h2 className="lm"><span>Score the fabric. Execute the best thread.</span></h2>
              <p className="sub rv">A live slice of loomd's route scorer. Tune the payment, pick a priority, and watch the fabric re-rank itself.</p>
            </div>
            <div className="lab panel rv">
              <div className="lab-controls">
                <div>
                  <span className="lab-label">Payment amount</span>
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
                  <span className="lab-label">Routing priority</span>
                  <div className="seg">
                    <button className={labMode === "speed" ? "act" : ""} onClick={() => setLabMode("speed")}>
                      Speed
                    </button>
                    <button className={labMode === "cost" ? "act" : ""} onClick={() => setLabMode("cost")}>
                      Cost
                    </button>
                    <button className={labMode === "reliability" ? "act" : ""} onClick={() => setLabMode("reliability")}>
                      Reliable
                    </button>
                  </div>
                </div>
                <button className="btn primary exec-btn" onClick={executeLabRoute} disabled={labExecuting}>
                  ⚡ Execute best route
                </button>
                <div className="lab-status">{labStatus}</div>
                <div className={`lab-progress ${labProgressActive ? "go" : ""}`}>
                  <i></i>
                </div>
              </div>
              <div className="routes-wrap">
                <div className="routes-head">
                  <span>route · hops</span>
                  <span>score</span>
                  <span>latency</span>
                  <span>fee est.</span>
                  <span>status</span>
                </div>
                <div id="routeList">
                  {scoredRoutes.map((r, i) => (
                    <div className={`route-row ${i === 0 ? "best" : ""}`} key={r.id}>
                      <div className="rr-id">
                        {i === 0 ? "▸ " : ""}
                        {r.id}
                        {!r.capOK && <span className="rr-flag">SPLIT REQ</span>}
                        <small>{r.hops} · cap {fmt(r.cap)}</small>
                      </div>
                      <div className="rr-score">
                        <div className="rr-bar">
                          <i style={{ width: `${(r.score * 100).toFixed(0)}%` }}></i>
                        </div>
                        <b>{r.score.toFixed(2)}</b>
                      </div>
                      <div className="rr-metric">{r.ms} ms</div>
                      <div className="rr-metric">~{fmt(r.feeSats)} s</div>
                      <div className="rr-metric" style={{ color: r.capOK ? "var(--settled)" : "var(--alert)" }}>
                        {r.capOK ? "ready" : "degraded"}
                      </div>
                    </div>
                  ))}
                </div>
                {labResult && (
                  <div className="lab-result show">
                    <span>✓ SETTLED</span>
                    <span className="dim">·</span>
                    <span>{fmt(labResult.amount)} sats</span>
                    <span className="dim">·</span>
                    <span>{labResult.ms} ms</span>
                    <span className="dim">·</span>
                    <span className="dim">receipt vtxo:{Math.random().toString(16).slice(2, 8)}…</span>
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
              <h2 className="lm"><span>HTTP 402, done properly.</span></h2>
            </div>
            <div className="x-grid">
              <div>
                <p className="sub rv" style={{ marginTop: 0 }}>
                  Payments become a transport concern. Agents discover price in the response, settle in a single signed header, and carry a cryptographic receipt back to whoever sent them.
                </p>
                <div className="x-list rv d1">
                  <div className="x-item"><i>01</i><div><b>No accounts, no API keys</b><span>Price is quoted in the 402 itself. Any agent, any stack, pays per request.</span></div></div>
                  <div className="x-item"><i>02</i><div><b>Signed, not trusted</b><span>The X-PAYMENT header carries a signed VTXO transfer — verifiable by anyone.</span></div></div>
                  <div className="x-item"><i>03</i><div><b>Receipts in-band</b><span>X-PAYMENT-RESPONSE returns the settlement proof with the payload. No polling.</span></div></div>
                  <div className="x-item"><i>04</i><div><b>Streams to your stack</b><span>Every x402 settle fans out as payment.settled over SSE and webhooks.</span></div></div>
                </div>
              </div>
              <div className="x-term rv d2">
                <div className="p-head">
                  <div className="p-sq"><i></i><i></i><i></i></div>
                  <span className="p-title">agent ⇄ merchant · per-request settlement</span>
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
                <div className="sov-line lm"><span><em>No</em> wrapped tokens.</span></div>
                <div className="sov-line lm"><span><em>No</em> cross-chain bridges.</span></div>
                <div className="sov-line lm"><span><em>No</em> custodians.<small>just you, your keys, and a loom.</small></span></div>
              </div>
              <aside className="sov-panel panel rv">
                <h4>WHY IT MATTERS</h4>
                <p>
                  Every IOU in a payment path is a failure waiting for a weekend. SatsLoom settles exclusively in assets Bitcoin itself can verify — taproot vaults, VTXO batches, on-chain exits. The trust surface is the script, and the script is yours to read.
                </p>
                <div className="sov-chips">
                  <i>100% BTC collateral</i><i>0 IOUs</i><i>0 trust assumptions</i>
                </div>
              </aside>
            </div>
            <div className="kicker">// UNILATERAL EXIT MECHANISM</div>
            <div className="exit-strip">
              <div className="exit-cell rv d1">
                <span className="ec-idx">E·1</span><h4>Observe</h4>
                <p>loomd, a relay, or an LSP stalls. Your node notices the silence before your customers do.</p>
                <div className="blocks"><i className="hot"></i><i></i><i></i><i></i><i></i><i></i></div>
              </div>
              <div className="exit-cell rv d2">
                <span className="ec-idx">E·2</span><h4>Broadcast</h4>
                <p>Sign the exit leaf with your key. One transaction goes to Bitcoin testnet / L1 — no negotiation, no counterparty.</p>
                <div className="blocks"><i className="hot"></i><i className="hot"></i><i></i><i></i><i></i><i></i></div>
              </div>
              <div className="exit-cell rv d3">
                <span className="ec-idx">E·3</span><h4>Recover</h4>
                <p>Full balance confirms back into a wallet you control. The loom can burn; the cloth is yours.</p>
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
              <h2 className="lm"><span>One binary. Your keys. Your loom.</span></h2>
            </div>
            <div className="host-grid">
              <div>
                <p className="sub rv" style={{ marginTop: 0 }}>
                  SatsLoom ships as a single static binary or a hardened container. Point it at a Tachi AEL node, load your vault key, and start weaving.
                </p>
                <ul className="check-list rv d1">
                  <li><span><b>Keys never leave your host</b> — loomd routes, it doesn't hold withdrawal secrets.</span></li>
                  <li><span><b>Any Tachi AEL node</b> works as the execution substrate — testnet, signet, or local.</span></li>
                  <li><span><b>REST + SSE event stream</b> with webhook fan-out for every payment state.</span></li>
                  <li><span><b>MIT licensed.</b> Audit it, fork it, run it air-gapped if you like.</span></li>
                </ul>
                <div className="req-chips rv d2">
                  <i>bitcoind ≥ 27</i><i>tachi-ael endpoint</i><i>1 vCPU · 1 GB RAM</i><i>~48 MB image</i>
                </div>
              </div>
              <div className="code-panel rv d2">
                <div className="code-tabs">
                  <button className={codeTab === "t-docker" ? "act" : ""} onClick={() => setCodeTab("t-docker")}>
                    docker-compose.yml
                  </button>
                  <button className={codeTab === "t-bare" ? "act" : ""} onClick={() => setCodeTab("t-bare")}>
                    bare metal
                  </button>
                  <button className={codeTab === "t-conf" ? "act" : ""} onClick={() => setCodeTab("t-conf")}>
                    config.yaml
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
                  <span className="c"># bring up loomd against your Tachi AEL node</span><br />
                  <span className="k">services</span>:<br />
                  {"  "}<span className="k">satsloom</span>:<br />
                  {"    "}<span className="k">image</span>: <span className="s">ghcr.io/satsloom/loomd:latest</span><br />
                  {"    "}<span className="k">ports</span>: [<span className="s">"8402:8402"</span>]<br />
                  {"    "}<span className="k">environment</span>:<br />
                  {"      "}<span className="k">SATSLOOM_NETWORK</span>: <span className="s">bitcoin</span><br />
                  {"      "}<span className="k">SATSLOOM_TACHI_ENDPOINT</span>: <span className="s">https://ael.mynode:9443</span><br />
                  {"      "}<span className="k">SATSLOOM_VAULT_POLICY</span>: <span className="s">taurus.p2tr</span><br />
                  {"    "}<span className="k">volumes</span>:<br />
                  {"      "}- <span className="s">./loomdata:/var/lib/satsloom</span><br />
                  {"    "}<span className="k">restart</span>: <span className="s">unless-stopped</span>
                </pre>
                <pre className={codeTab === "t-bare" ? "act" : ""} id="t-bare">
                  <span className="c"># build from source — rust toolchain required</span><br />
                  $ git clone https://github.com/satsloom/loomd<br />
                  $ cd loomd && cargo build --release<br />
                  $ ./target/release/loomd \<br />
                  {"    "}--network bitcoin \<br />
                  {"    "}--ael-endpoint https://ael.mynode:9443 \<br />
                  {"    "}--vault-policy taurus.p2tr \<br />
                  {"    "}--listen 0.0.0.0:8402<br />
                  <br />
                  <span className="c"># verify, then weave</span><br />
                  $ curl localhost:8402/v1/health<br />
                  <span className="s">{`{"status":"weaving","routes":1284,"vault":"armed"}`}</span>
                </pre>
                <pre className={codeTab === "t-conf" ? "act" : ""} id="t-conf">
                  <span className="k">router</span>:<br />
                  {"  "}<span className="k">strategy</span>: <span className="s">weighted-weave</span><br />
                  {"  "}<span className="k">max_paths</span>: <span className="s">3</span><br />
                  {"  "}<span className="k">score_window</span>: <span className="s">30s</span><br />
                  <span className="k">vault</span>:<br />
                  {"  "}<span className="k">kind</span>: <span className="s">taurus</span><br />
                  {"  "}<span className="k">exit_leaf_timelock</span>: <span className="s">48h</span><br />
                  {"  "}<span className="k">auto_renew_vtxos</span>: <span className="s">true</span><br />
                  <span className="k">events</span>:<br />
                  {"  "}<span className="k">sse</span>: <span className="s">enabled</span><br />
                  {"  "}<span className="k">webhook</span>: <span className="s">https://merchant.example/hooks/satsloom</span><br />
                  <span className="k">x402</span>:<br />
                  {"  "}<span className="k">enabled</span>: <span className="s">true</span><br />
                  {"  "}<span className="k">max_sats_per_request</span>: <span className="s">5000</span>
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
              <div className="spec"><dt>Settlement unit</dt><dd><b>VTXO</b> batches · sub-second</dd></div>
              <div className="spec"><dt>Chain anchor</dt><dd>Bitcoin Taproot <b>P2TR</b></dd></div>
              <div className="spec"><dt>Custody</dt><dd><b>Self</b> · keypath + unilateral exit</dd></div>
              <div className="spec"><dt>Execution layer</dt><dd><b>Tachi AEL</b> · agentic</dd></div>
              <div className="spec"><dt>Median settle</dt><dd><b>340 ms</b> invoice→receipt</dd></div>
              <div className="spec"><dt>Fee p50</dt><dd><b>0.021%</b> of routed amount</dd></div>
              <div className="spec"><dt>Interfaces</dt><dd>REST · SSE · <b>x402</b> headers</dd></div>
              <div className="spec"><dt>License</dt><dd><b>MIT</b> · single binary</dd></div>
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
                  <rect x="1" y="1" width="30" height="30" stroke="#2B2415" strokeWidth="1.5" />
                  <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
                  <path d="M11 5v22M21 5v22" stroke="#EFE7D3" strokeWidth="2" />
                </svg>
                SATS<b>LOOM</b>
              </a>
              <p>Self-hosted, self-custodial Bitcoin settlement router and x402 gateway — woven on Tachi's Agentic Execution Layer.</p>
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
                  <rect x="1" y="1" width="30" height="30" stroke="#2B2415" strokeWidth="1.5" />
                  <path d="M6 10h20M6 16h20M6 22h20" stroke="#F7931A" strokeWidth="2" />
                  <path d="M11 5v22M21 5v22" stroke="#EFE7D3" strokeWidth="2" />
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
                      <span className="stat-label">Invoices Created</span>
                      <div className="stat-value">{overview?.invoiceCount ?? 0}</div>
                      <span className="stat-sub">Across all checkout sessions</span>
                    </div>
                    <div className="stat-card accent">
                      <span className="stat-label">Settled Revenue</span>
                      <div className="stat-value">
                        {Number(overview?.settledSats ?? 0).toLocaleString()} <span className="unit">sats</span>
                      </div>
                      <span className="stat-sub">Off-chain VTXO & LP settlement</span>
                    </div>
                    <div className="stat-card warning">
                      <span className="stat-label">Pending Invoices</span>
                      <div className="stat-value">
                        {Number(overview?.pendingSats ?? 0).toLocaleString()} <span className="unit">sats</span>
                      </div>
                      <span className="stat-sub">Awaiting customer payment</span>
                    </div>
                    <div className="stat-card info">
                      <span className="stat-label">Routing Pool Liquidity</span>
                      <div className="stat-value">
                        {Number(overview?.routingLiquiditySats ?? 1350000).toLocaleString()} <span className="unit">sats</span>
                      </div>
                      <span className="stat-sub">Available float capacity</span>
                    </div>
                  </div>

                  {/* Create Invoice Card */}
                  <div className="create-invoice-card">
                    <div className="card-header-row">
                      <div>
                        <h3>Generate Merchant Invoice</h3>
                        <p className="subtext">Issue instant native-sat invoices with automatic VTXO route quotation</p>
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
                        <span>Webhook URL (Optional)</span>
                        <input
                          type="url"
                          value={webhookUrl}
                          onChange={(e) => setWebhookUrl(e.target.value)}
                          placeholder="https://mysite.com/webhook"
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
                            <strong className={`status-pill ${invoice.status}`}>{invoice.status.toUpperCase()}</strong> • Lifecycle:{" "}
                            <strong>{settlement?.lifecycle ?? invoice.lifecycle}</strong>
                          </p>
                        </div>

                        <div className="invoice-header-actions">
                          <button className="btn-qr-view" onClick={() => setShowCheckoutModal(true)}>
                            📱 View Customer QR Code
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
                          {eventsConnected ? "Live Real-Time Stream Connected" : "Connecting to EventStream..."}
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
                            <span className="receipt-title">Settlement Verification Receipt</span>
                            <span className="simulation-tag">Tachi Regtest Simulation</span>
                          </div>
                          <div className="receipt-grid">
                            <div>
                              <span className="receipt-label">Settlement TxID:</span>
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
          isPaid={isPaid}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
