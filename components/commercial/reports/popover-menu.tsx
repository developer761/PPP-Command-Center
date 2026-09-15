"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * A small anchored menu for the Reports index — the ⋯ on a report card and on
 * a personal folder.
 *
 * Closes on outside tap, Escape, and whenever the URL's query changes (every
 * folder action redirects back with a notice, so a finished action closes the
 * menu without the form having to unmount itself mid-submit — unmounting a
 * form inside its own submit is how a click silently does nothing).
 */
export function PopoverMenu({
  ariaLabel,
  children,
  buttonClassName = "",
  panelClassName = "",
  trigger,
}: {
  ariaLabel: string;
  children: React.ReactNode;
  buttonClassName?: string;
  panelClassName?: string;
  trigger?: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const search = useSearchParams()?.toString() ?? "";
  // Open is tied to the query it was opened on, so a redirect back from an
  // action (new query) closes it with no effect needed.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === search;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(open) : v;
    setOpenOn(next ? search : null);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpenOn(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenOn(null);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg touch-manipulation transition-colors ${
          open ? "bg-ppp-charcoal-100 text-ppp-charcoal" : "text-ppp-charcoal-400 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50"
        } ${buttonClassName}`}
      >
        {trigger ?? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        )}
      </button>
      {open && (
        <div
          id={id}
          className={`absolute right-0 top-full mt-1 z-30 w-72 max-w-[calc(100vw-2.5rem)] rounded-xl border border-ppp-charcoal-100 bg-surface shadow-lg p-1.5 text-left ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
