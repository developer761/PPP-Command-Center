"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Small ⓘ icon button — hover for desktop tooltip, tap to toggle on mobile.
 *  Auto-dismisses on blur so a stale popover doesn't linger after the user
 *  moves on. Use anywhere a number, label, or chip would benefit from a
 *  plain-English "what this means" explanation.
 *
 *  Originally lived inside materials-view.tsx; moved here so the home
 *  dashboard, Customer History, and other surfaces can reuse the same
 *  consistent UI pattern — matters for owner UX (Alex).
 *
 *  Rendered into document.body via a portal + position:fixed so the popover
 *  is never clipped by an ancestor card's `overflow-hidden` (audit 2026-06-04:
 *  Karan reported KPI tooltips were being cut off / hidden on the dashboard).
 *  Coordinates computed from the icon's getBoundingClientRect — auto-flips
 *  to the left if it would overflow the viewport, and clamps to a 1rem inset
 *  on either edge so a tooltip near the right edge never disappears.
 */
export default function InfoDot({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; maxWidth: number } | null>(null);
  const iconRef = useRef<HTMLButtonElement | null>(null);

  // Recompute coordinates when the tooltip opens. useLayoutEffect so the
  // measure + position happens before paint (no flicker of the tooltip
  // initially appearing at (0,0) then jumping into place).
  useLayoutEffect(() => {
    if (!open || !iconRef.current) return;
    const reposition = () => {
      const icon = iconRef.current;
      if (!icon) return;
      const r = icon.getBoundingClientRect();
      const TOOLTIP_W = 240;       // matches the w-60 class below
      const EDGE_INSET = 12;        // never get closer than 12px to viewport edge
      const VERTICAL_GAP = 6;       // gap between icon and tooltip
      const vw = window.innerWidth;
      // Prefer left-edge anchor (tooltip extends rightward from icon).
      // If that overflows the right viewport edge, flip to right-anchor
      // (tooltip extends leftward, ending at the icon's right edge).
      let left = r.left;
      if (left + TOOLTIP_W > vw - EDGE_INSET) {
        left = Math.max(EDGE_INSET, r.right - TOOLTIP_W);
      }
      // Clamp final position so the tooltip never bleeds off either edge
      // even on extremely narrow viewports (mobile in portrait).
      const maxWidth = Math.min(TOOLTIP_W, vw - 2 * EDGE_INSET);
      left = Math.max(EDGE_INSET, Math.min(left, vw - maxWidth - EDGE_INSET));
      setCoords({ top: r.bottom + VERTICAL_GAP, left, maxWidth });
    };
    reposition();
    window.addEventListener("scroll", reposition, true); // capture = catch scroll on any ancestor
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  // Close on Escape so keyboard users have a quick exit.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        ref={iconRef}
        type="button"
        onClick={(e) => {
          // stopPropagation + preventDefault: this button is sometimes
          // nested inside a clickable parent (e.g. KpiTile wrapped in
          // <a href>). Without preventDefault, some browsers still
          // fire the parent <a>'s navigation as the default action
          // when clicking a descendant button. Defensive belt + braces.
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        title={text}
        aria-label={`What this means: ${text}`}
        aria-expanded={open}
        className="inline-flex items-center justify-center h-4 w-4 rounded-full border border-ppp-charcoal-200 text-[9px] font-bold text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 hover:text-ppp-charcoal transition-colors"
      >
        ?
      </button>
      {open && coords && typeof document !== "undefined" &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: "fixed",
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              maxWidth: `${coords.maxWidth}px`,
            }}
            className="z-[60] normal-case tracking-normal font-normal text-[12px] leading-snug text-ppp-charcoal bg-white border border-ppp-charcoal-100 rounded-lg shadow-xl shadow-ppp-charcoal/20 p-3 pointer-events-none"
          >
            {text}
          </span>,
          document.body
        )}
    </>
  );
}
