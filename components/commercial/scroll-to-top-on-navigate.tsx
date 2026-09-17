"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Land at the top of the page when you go somewhere new.
 *
 * Karan 2026-09-17: "make sure wherever we go it lands on the top of the page,
 * like when I click [into an opportunity] for anything."
 *
 * WHY NEXT'S OWN SCROLL HANDLING DOES NOT DO THIS HERE. The shell in
 * components/commercial-chrome.tsx is `<main className="flex-1
 * overflow-y-auto">` inside a `min-h-screen` row — so `main` is the scroller
 * and the DOCUMENT never scrolls at all. Next's navigation handler sets
 * `document.documentElement.scrollTop = 0`, which on this layout is a no-op
 * against an element that is already at 0 and cannot move. It then falls back
 * to `scrollIntoView()` on the first rendered node, and bails out entirely when
 * that node is `position: sticky` or has a zero rect — which several of these
 * pages start with. The result is that scrolling halfway down a long
 * opportunities list and opening a job drops you halfway down the job.
 *
 * The shell already knows this about itself: `use-scroll-lock.ts` calls
 * `document.querySelector("main")` "the real scroller", and commercial-chrome
 * carries a comment that setting `body.style.overflow` does nothing here.
 *
 * PATHNAME ONLY, deliberately — not searchParams. A filter, a tab, a sort and a
 * report period are all searchParam changes on a page you are already reading,
 * and yanking that page to the top every time you touch a control is its own
 * bug; several of those controls pass `scroll={false}` precisely to avoid it.
 * Going somewhere NEW is a pathname change.
 *
 * A hash wins. `#change-status`, `#new-deal` and the rest exist to put you at a
 * specific block, and some are arrived at by redirect; scrolling to the top
 * would undo the thing the link was for.
 */
export function ScrollToTopOnNavigate() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    // Skip the very first run. On a cold load the browser is restoring its own
    // position, and on a refresh mid-page that restore is correct.
    if (first.current) {
      first.current = false;
      return;
    }
    if (window.location.hash) return;

    const main = document.querySelector("main");
    // `scrollTo` rather than assigning scrollTop: on a page whose content has
    // not painted yet the element may not be scrollable, and scrollTo is a
    // no-op there instead of throwing. Both the scroller and the document are
    // reset, so this keeps working if the shell ever stops being the scroller.
    main?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);

  return null;
}
