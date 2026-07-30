"use client";

/**
 * Right-hand slide-out drawer (GHL style) for a project tool opened from the
 * account (Karan 2026-07-30). Rendered by an intercepting route in the account's
 * @drawer parallel slot, so:
 *   - clicking a tool from the account soft-navigates → this drawer slides in
 *     over the account (URL updates to the tool's real path, deep-linkable);
 *   - a hard refresh / shared link / the tool index renders the FULL tool page
 *     instead (the @drawer slot falls back to default.tsx = null).
 *
 * Closing (backdrop click, Esc, close button, or browser Back) calls
 * router.back(), which pops the intercepted entry and returns to the account.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ToolDrawer({ title, children }: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Slide-in on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Close on Esc + lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    // Play the slide-out, then pop the intercepted history entry.
    setShown(false);
    window.setTimeout(() => router.back(), 180);
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      {/* Backdrop */}
      <div
        onClick={close}
        className={`absolute inset-0 bg-ppp-charcoal-900/40 backdrop-blur-[1px] transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
        aria-hidden
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className={`absolute right-0 top-0 h-full w-full sm:max-w-2xl bg-surface shadow-2xl flex flex-col transition-transform duration-200 ease-out ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 h-14 border-b border-ppp-charcoal-100 shrink-0">
          <h2 className="font-condensed text-lg font-black text-ppp-charcoal tracking-tight truncate">{title}</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="h-10 w-10 -mr-1 inline-flex items-center justify-center rounded-lg text-ppp-charcoal-400 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50 touch-manipulation"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18 M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}
