"use client";

import { useEffect } from "react";

/**
 * Freeze the page behind an open overlay.
 *
 * The usual `document.body.style.overflow = "hidden"` does NOTHING in the
 * Commercial shell: `<main>` is the scroll container, not `<body>`. So every
 * modal on the platform let the page go on scrolling underneath it — a fixed
 * sheet over a moving background, which is what Karan described as the sheet
 * "sticking to the top of the page".
 *
 * Locks whichever element is actually scrolling and restores its previous
 * value, so nested or fast-toggling overlays can't leave the page frozen.
 *
 * Deliberately does not touch `position` or add scrollbar-gutter padding: the
 * shell's scroller is an inner element, so hiding its overflow doesn't shift
 * the layout the way locking <body> would.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const scroller =
      (document.querySelector("main") as HTMLElement | null) ?? document.body;
    const prev = scroller.style.overflow;
    scroller.style.overflow = "hidden";
    return () => {
      scroller.style.overflow = prev;
    };
  }, [active]);
}
