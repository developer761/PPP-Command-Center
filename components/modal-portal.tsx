"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Render a fixed-position overlay outside the page's DOM subtree.
 *
 * `position: fixed` is only relative to the viewport while NO ancestor
 * establishes a containing block. `transform` does — and so do `filter`,
 * `backdrop-filter`, `perspective`, `contain` and `will-change` naming any of
 * them. Every page shell here is wrapped in `.animate-fade-up`, so every modal
 * inside one was positioned against the PAGE: open one while scrolled down and
 * it rendered off-screen.
 *
 * Round 3 fixed the settled state by ending the keyframes on `transform: none`.
 * That's correct and stays, but it is not sufficient — the ancestor still
 * carries a transform for the 320ms the animation runs, and it carries one
 * indefinitely if the animation never advances (a throttled background tab
 * holds `currentTime` at 0, which is exactly what I measured in Chrome). A
 * remount restarts it too. So "no ancestor has a transform right now" is not
 * something a modal can depend on, and Kate reported this three rounds running.
 *
 * Portalling removes the dependency entirely: the overlay has no page ancestors,
 * so nothing above it can create a containing block, on either platform.
 *
 * THEME: `data-theme` sits on a wrapper `div` (see app/commercial/layout.tsx),
 * not on `<html>`. Portalling straight to `document.body` would drop the
 * overlay out of that scope and render a dark-mode dialog in light colours, so
 * the nearest ancestor's theme is mirrored onto the portal container.
 */
export default function ModalPortal({ children }: { children: React.ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.setAttribute("data-ppp-modal-portal", "");
    // Inherit the theme scope the trigger was rendered in.
    const themed = anchorRef.current?.closest("[data-theme]");
    const theme = themed?.getAttribute("data-theme");
    if (theme) el.setAttribute("data-theme", theme);
    document.body.appendChild(el);
    // The portal target cannot exist during SSR or the first render — there is
    // no document to append to — so creating it after mount and re-rendering
    // once is the only correct order.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContainer(el);
    return () => {
      el.remove();
    };
  }, []);

  return (
    <>
      {/* Zero-size marker: gives the effect a position in the ORIGINAL tree so
          it can find the theme scope the modal logically belongs to. */}
      <span ref={anchorRef} className="hidden" aria-hidden />
      {container ? createPortal(children, container) : null}
    </>
  );
}
