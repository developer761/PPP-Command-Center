"use client";

import { useEffect, useState } from "react";

/**
 * Comfortable / wide toggle — the "monitor view".
 *
 * Karan 2026-09-17: "Bigger monitor view next to the light mode dark mode."
 *
 * Built exactly like ThemeToggle, and for the same reason: the server renders
 * the initial width from the `cc-width` cookie onto [data-cc-root], so a wide
 * layout arrives already wide instead of snapping a page full of tables one
 * frame after paint. This button flips that attribute directly — instant, no
 * reload — and writes the cookie for the next navigation.
 *
 * The widening itself is one rule in globals.css, which lifts the page-shell
 * caps (4xl/5xl/6xl) and deliberately leaves prose and dialogs alone.
 */
export function WidthToggle() {
  const [wide, setWide] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-cc-root]");
    setWide(root?.dataset.width === "wide");
    setMounted(true);
  }, []);

  function toggle() {
    const next = wide ? "comfortable" : "wide";
    const root = document.querySelector<HTMLElement>("[data-cc-root]");
    if (root) root.dataset.width = next;
    document.cookie = `cc-width=${next}; path=/; max-age=31536000; samesite=lax`;
    setWide(!wide);
  }

  // Stable placeholder until mounted, so SSR and the first client paint agree.
  const on = mounted && wide;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={on ? "Switch to comfortable width" : "Switch to full monitor width"}
      title={on ? "Comfortable width" : "Monitor width"}
      // Hidden below `lg`: on a laptop or a phone the caps are never the
      // constraint, so the control would do nothing visible and cost a tap
      // target on the row that already holds search, theme, bell and account.
      className="hidden lg:inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:text-cc-brand-700 hover:border-cc-brand-300 hover:bg-cc-brand-50 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
    >
      {on ? (
        // Arrows pointing IN — "give me the narrower page back".
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 3v6H3 M15 3v6h6 M9 21v-6H3 M15 21v-6h6" />
        </svg>
      ) : (
        // Arrows pointing OUT — "use the whole monitor".
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 9V3h6 M21 9V3h-6 M3 15v6h6 M21 15v6h-6" />
        </svg>
      )}
    </button>
  );
}
