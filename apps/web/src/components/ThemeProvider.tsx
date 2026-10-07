/**
 * Theme (light/dark) state, persisted to localStorage.
 *
 * The toggle is a plain button rather than a library widget: the entire palette is CSS custom
 * properties, so switching themes is one attribute on <html>. Nothing here reads the computed
 * palette, which keeps React out of the styling path entirely.
 *
 * The initial value comes from the document's existing `data-theme` attribute, which an inline
 * script in index.html sets before first paint. Reading that attribute (instead of checking
 * matchMedia again) is what prevents a flash of the wrong theme on load, and it makes SSR and
 * a no-JS first render agree.
 */
import React, { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "satsloom-theme";

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  // Reflect the state onto <html> so the CSS block above can apply. Also keep localStorage in
  // sync so an explicit choice beats the OS preference on the next visit.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private-mode or storage-disabled browsers: the in-memory value still drives the UI.
    }
  }, [theme]);

  // Follow the OS preference while the user has not made an explicit choice, so switching the
  // system to light changes the site without a manual toggle.
  useEffect(() => {
    let explicit = false;
    try {
      explicit = window.localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      explicit = false;
    }
    if (explicit) return;
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setTheme(event.matches ? "light" : "dark");
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return { theme, setTheme, toggle };
}

type Props = {
  theme: Theme;
  onToggle: () => void;
  className?: string;
};

/** The control itself. Icon + accessible label; no emoji so it stays legible at 22px. */
export function ThemeToggle({ theme, onToggle, className = "" }: Props) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      onClick={onToggle}
      data-theme-state={theme}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={!isDark}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
        {isDark ? (
          // Sun: shown while dark, because clicking it goes to light.
          <>
            <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7" />
            </g>
          </>
        ) : (
          // Moon: shown while light, because clicking it goes to dark.
          <path
            d="M20.4 14.2A8.6 8.6 0 1 1 9.8 3.6a6.9 6.9 0 0 0 10.6 10.6Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  );
}
