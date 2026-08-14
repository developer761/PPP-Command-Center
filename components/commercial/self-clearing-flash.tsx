"use client";

import { useEffect, useState } from "react";

/**
 * A flash banner that takes its own param out of the URL once it has been seen.
 *
 * The proposal editor's line-item actions are revalidate-only by design: the old
 * success `redirect()` targeted the same path + query the user was already on,
 * which is a no-op navigation that left the recomputed total unpainted and
 * tripped the autosave "Leave site?" guard mid-edit.
 *
 * But that redirect was also the only thing clearing `?error=`. So: save a line
 * item badly, get the red banner, fix it, save again — the save SUCCEEDS and the
 * red banner is still sitting there, because the URL never changed and the
 * server re-renders it from `sp.error` every time. The banner has no dismiss, so
 * there is no way to tell a stale failure from a fresh one short of a manual
 * reload.
 *
 * Stripping the param on mount fixes it at the source: the banner stays visible
 * for this render (React state is untouched — removing a param does not unmount
 * anything), and the NEXT server render, whenever a revalidate happens, no
 * longer has an error to show. Same `history.replaceState` approach as
 * undo-toast.tsx, which strips its own params for the same reason.
 *
 * Also renders a dismiss control, because a message that cannot be closed on a
 * page you keep working in is its own small annoyance.
 */
export function SelfClearingFlash({
  params,
  className,
  role = "alert",
  children,
}: {
  /** Query params to remove from the URL once mounted, e.g. ["error"]. */
  params: string[];
  className?: string;
  role?: "alert" | "status";
  children: React.ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    let changed = false;
    for (const p of params) {
      if (url.searchParams.has(p)) {
        url.searchParams.delete(p);
        changed = true;
      }
    }
    if (changed) window.history.replaceState({}, "", url.toString());
    // params is a literal array at every call site; joining keeps the effect
    // from re-firing on each render without disabling the lint rule.
  }, [params.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (dismissed) return null;

  return (
    <div role={role} className={className}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">{children}</div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 -mr-1 -mt-1 inline-flex items-center justify-center h-8 w-8 rounded-md opacity-60 hover:opacity-100 touch-manipulation"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
