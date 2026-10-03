/**
 * SatsLoom web entry point.
 *
 * A ~40-line hash router rather than a routing dependency: the app has five screens, and a hash
 * route keeps the pay page deep-linkable from a QR code or an embedded button without any
 * server-side rewrite rules.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Dashboard, PayPage, PluginPage, RoutesPage, SettingsPage } from "./pages";
import { ModePill } from "./ui";
import { api, type Envelope } from "./api";

function useHashRoute(): { route: string; path: string[] } {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const path = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { route: path[0] ?? "", path };
}

function navigate(to: string) {
  window.location.hash = to.startsWith("#") ? to : `#${to}`;
}

const TABS: { route: string; label: string }[] = [
  { route: "", label: "Dashboard" },
  { route: "routes", label: "Liquidity" },
  { route: "settings", label: "Policy & daemon" },
  { route: "plugin", label: "Plugin" },
];

export function App() {
  const { route, path } = useHashRoute();
  const [status, setStatus] = useState<Envelope<{ mode: string }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<{ mode: string }>("/api/tachi/status")
        .then((response) => !cancelled && setStatus(response))
        .catch(() => !cancelled && setStatus(null));
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // The pay page is a standalone surface: no navigation, because the customer is not the merchant.
  if (route === "pay") {
    return (
      <div className="shell" style={{ maxWidth: 560 }}>
        <header className="topbar" style={{ justifyContent: "center" }}>
          <div className="brand">
            <h1>
              Sats<span className="loom">Loom</span>
            </h1>
            <span className="tag">merchant settlement router</span>
          </div>
        </header>
        <PayPage id={path[1] ?? ""} />
      </div>
    );
  }

  const mode = status?.mode ?? status?.data?.mode ?? "degraded";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>
            Sats<span className="loom">Loom</span>
          </h1>
          <span className="tag">merchant settlement router · Tachi</span>
        </div>
        <nav className="tabs">
          {TABS.map((tab) => (
            <a key={tab.route} href={`#/${tab.route}`} className={route === tab.route ? "active" : ""}>
              {tab.label}
            </a>
          ))}
        </nav>
        <ModePill mode={mode} />
      </header>

      {route === "" && <Dashboard navigate={navigate} />}
      {route === "routes" && <RoutesPage />}
      {route === "settings" && <SettingsPage />}
      {route === "plugin" && <PluginPage />}
      {!["", "routes", "settings", "plugin"].includes(route) && (
        <div className="banner amber">
          <strong>404</strong>
          <span>
            No such screen. <a href="#/">Back to the dashboard</a>.
          </span>
        </div>
      )}

      <footer className="mt" style={{ marginTop: 40, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
        <div className="spread">
          <span className="tiny dim">
            SatsLoom · built for the Tachi OP_Freedom Hackathon — Bounty #11 (Merchant Payments) + Bounty #10 (Liquidity Management)
          </span>
          <a className="tiny dim" href="/api/tachi/capabilities" target="_blank" rel="noreferrer">
            capability probe ↗
          </a>
        </div>
      </footer>
    </div>
  );
}

/**
 * Boot the app. Guarded on the host element existing so this module can be imported by tests
 * (and by any future embed surface) without side effects — a bare `createRoot(...)!` here would
 * run at import time and crash every non-browser consumer.
 */
const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);
