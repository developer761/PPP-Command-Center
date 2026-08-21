"use client";

import { useEffect, useState } from "react";

/**
 * Light/dark toggle (Phase I). The server renders the initial theme from the
 * `cc-theme` cookie onto the [data-cc-root] wrapper, so there's no flash. This
 * button flips that wrapper's data-theme directly (instant, no reload) and
 * persists the choice to the cookie for the next navigation.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-cc-root]");
    const current = root?.dataset.theme === "dark" ? "dark" : "light";
    setTheme(current);
    setMounted(true);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    const root = document.querySelector<HTMLElement>("[data-cc-root]");
    if (root) root.dataset.theme = next;
    document.cookie = `cc-theme=${next}; path=/; max-age=31536000; samesite=lax`;
    setTheme(next);
  }

  // Render a stable placeholder until mounted so SSR + first client paint match.
  const isDark = mounted && theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:text-cc-brand-700 hover:border-cc-brand-300 hover:bg-cc-brand-50 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
    >
      {isDark ? (
        // Sun
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // Moon
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
