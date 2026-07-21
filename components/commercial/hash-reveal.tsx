"use client";

import { useEffect } from "react";

/**
 * Reveal + scroll to a URL-hash target that may be hidden inside a
 * collapsed <details>.
 *
 * 2026-07-21 re-audit (Finding B): the account Opportunities tab renders
 * decided deals inside a `<details>` that's collapsed whenever open deals
 * exist. Cross-page links / the command palette that anchor to
 * `#deal-row-<id>` therefore landed on a `display:none` element — the
 * browser can't scroll to it and the deal appears to vanish. Native
 * fragment navigation doesn't expand <details> outside the newest Chrome.
 *
 * This mounts once on the page, and on load + hashchange: walks up from
 * the hash target, force-opens every collapsed <details> ancestor, then
 * scrolls the target into view. No-op when there's no hash or no match.
 *
 * Server-agnostic, renders nothing.
 */
export function HashReveal() {
  useEffect(() => {
    function reveal() {
      const hash = window.location.hash;
      if (!hash || hash.length < 2) return;
      let el: Element | null = null;
      try {
        el = document.querySelector(hash);
      } catch {
        return; // malformed selector — ignore
      }
      if (!el) return;
      // Open every collapsed <details> ancestor so the target lays out.
      let node: Element | null = el;
      while (node) {
        if (node instanceof HTMLDetailsElement && !node.open) {
          node.open = true;
        }
        node = node.parentElement;
      }
      (el as HTMLElement).scrollIntoView({ block: "center", behavior: "auto" });
    }
    // Defer one frame so tab content is in the DOM before we query it.
    const raf = requestAnimationFrame(reveal);
    window.addEventListener("hashchange", reveal);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("hashchange", reveal);
    };
  }, []);
  return null;
}
