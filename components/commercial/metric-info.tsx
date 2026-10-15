"use client";

/**
 * The ⓘ beside a dashboard figure: what it counts and over which dates.
 *
 * Katie 2026-10-15 for Alex — "a footnote which describes the criteria
 * showing each of the metrics", as a per-tile ⓘ for now (option a); a
 * "How these numbers are calculated" section may follow after Alex has used it.
 * The words come from `lib/commercial/dashboard/metric-notes.ts`, never from
 * the call site, so every surface explains a figure the same way.
 *
 * Built for the phone first, because that is where Alex reads this page:
 *   · TAP opens and closes it (hover alone does nothing on glass). Hover also
 *     opens it on a desktop, as a convenience.
 *   · It is a SIBLING of the tile, never inside it: most tiles are links, and a
 *     button nested in an <a> is invalid HTML whose tap navigates away instead
 *     of explaining. The caller wraps tile + this in a `relative` box.
 *   · position: fixed, clamped to the viewport — so a tile in the left column
 *     on a 375px screen cannot push the note off the edge, and no ancestor's
 *     `overflow-hidden` can clip it (see scripts/audit-clipped-popovers.cjs).
 *   · Escape, an outside tap, scrolling or resizing closes it.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

const WIDTH = 288; // 18rem
const GUTTER = 12;

export function MetricInfo({
  label,
  note,
  scope,
  className = "",
}: {
  /** The tile's label, for the accessible name: "About Owed to us". */
  label: string;
  note: string;
  scope: "range" | "today";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const width = Math.min(WIDTH, vw - GUTTER * 2);
    const left = Math.min(Math.max(GUTTER, r.right - width), vw - width - GUTTER);
    setPos({ top: r.bottom + 6, left });
  }, []);

  const show = useCallback(() => {
    place();
    setOpen(true);
  }, [place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || pop.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          // The tile under it is usually a link; this tap is for the note.
          e.preventDefault();
          e.stopPropagation();
          if (open) setOpen(false);
          else show();
        }}
        // Hover opens it for a MOUSE only. A touch screen synthesises an enter
        // before the click, which would open it and let the click close it
        // again — one tap, nothing seen.
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") show();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setOpen(false);
        }}
        // 32px visual, 44px hit area via the negative margin + padding.
        className={`inline-flex items-center justify-center w-8 h-8 -m-1.5 p-1.5 rounded-full text-ppp-charcoal-400 hover:text-ppp-charcoal-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cc-brand-500 touch-manipulation ${className}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9.5" />
          <path d="M12 11v6" />
          <circle cx="12" cy="7.6" r="0.6" fill="currentColor" />
        </svg>
      </button>
      {open && pos && (
        <div
          ref={pop}
          id={id}
          role="tooltip"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.min(WIDTH, window.innerWidth - GUTTER * 2) }}
          className="z-50 rounded-lg border border-ppp-charcoal-200 bg-surface shadow-lg px-3 py-2.5 text-left"
        >
          <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1">
            {scope === "range" ? "Follows the date range" : "As of today"}
          </div>
          <p className="text-[12px] leading-snug text-ppp-charcoal-700 normal-case font-normal tracking-normal">{note}</p>
        </div>
      )}
    </>
  );
}
