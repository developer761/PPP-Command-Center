"use client";

/**
 * Undo-toast that appears when a URL query pair
 *   ?undo_id=<uuid>&undo_kind=deal|note|invoice
 * is present after a soft-delete redirect. Renders a 5-second toast
 * bottom-right with an "Undo" button. Clicking Undo POSTs to the
 * matching `/api/commercial/{kind-route}/[id]/restore` endpoint, then
 * hard-refreshes the page.
 *
 * Karan 2026-07-11 (signature-moments batch): accidental delete clicks
 * had no safety net before. Alex has been burned by mis-taps. Undo
 * toast is the industry-standard rescue for the destructive-click UX.
 *
 * Design decisions:
 * - Server actions redirect with `?undo_id=X&undo_kind=Y&undo_label=Z`;
 *   this component reads them client-side via useSearchParams so the
 *   toast lives entirely outside the RSC tree.
 * - Auto-dismiss after 5s (matches Gmail's undo window).
 * - After Undo click OR after 5s auto-dismiss, we strip the undo_*
 *   query params via history.replaceState so a refresh doesn't
 *   re-trigger the toast.
 * - The toast is portaled via `fixed bottom-6 right-6` positioning —
 *   sits above main content, doesn't take page-flow space.
 */

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

type UndoKind = "deal" | "note" | "invoice";

const RESTORE_ROUTE_BY_KIND: Record<UndoKind, (id: string) => string> = {
  deal: (id) => `/api/commercial/opportunities/${id}/restore`,
  note: (id) => `/api/commercial/notes/${id}/restore`,
  invoice: (id) => `/api/commercial/invoices/${id}/restore`,
};

const KIND_LABEL: Record<UndoKind, string> = {
  deal: "deal",
  note: "note",
  invoice: "invoice",
};

export function UndoToast() {
  const sp = useSearchParams();
  const router = useRouter();
  const undoId = sp?.get("undo_id");
  const undoKindRaw = sp?.get("undo_kind");
  const undoLabel = sp?.get("undo_label") ?? "";
  const kind = (undoKindRaw as UndoKind | null) &&
    ["deal", "note", "invoice"].includes(undoKindRaw!)
    ? (undoKindRaw as UndoKind)
    : null;

  const [visible, setVisible] = useState<boolean>(false);
  const [status, setStatus] = useState<"idle" | "restoring" | "error" | "done">("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    if (undoId && kind) {
      setVisible(true);
      setStatus("idle");
      setErrorMsg("");
      const t = setTimeout(() => {
        setVisible(false);
        // Strip the undo_* query params so refresh doesn't re-fire.
        stripUndoParams();
      }, 5000);
      return () => clearTimeout(t);
    } else {
      setVisible(false);
    }
  }, [undoId, kind]);

  const stripUndoParams = () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("undo_id");
    url.searchParams.delete("undo_kind");
    url.searchParams.delete("undo_label");
    window.history.replaceState({}, "", url.toString());
  };

  const onUndo = async () => {
    if (!undoId || !kind || status === "restoring") return;
    setStatus("restoring");
    try {
      const res = await fetch(RESTORE_ROUTE_BY_KIND[kind](undoId), {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(body.error ?? "Failed to restore.");
        setStatus("error");
        return;
      }
      setStatus("done");
      // Hide immediately; strip params; refresh to pick up restored row.
      setVisible(false);
      stripUndoParams();
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to restore.");
      setStatus("error");
    }
  };

  if (!visible || !undoId || !kind) return null;

  const displayLabel = undoLabel
    ? `Deleted "${decodeURIComponent(undoLabel)}"`
    : `Deleted ${KIND_LABEL[kind]}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-50 max-w-sm w-full sm:w-auto bg-ppp-charcoal-900 text-white rounded-xl shadow-xl border border-ppp-charcoal-700 px-4 py-3 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4"
    >
      <span className="text-[13px] font-medium truncate flex-1">
        {status === "restoring"
          ? "Restoring…"
          : status === "error"
          ? `Restore failed: ${errorMsg}`
          : displayLabel}
      </span>
      {status === "idle" && (
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-cc-brand-600 hover:bg-cc-brand-700 text-[12px] font-bold uppercase tracking-wider min-h-[36px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-400"
        >
          Undo
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setVisible(false);
          stripUndoParams();
        }}
        className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded text-ppp-charcoal-400 hover:text-white hover:bg-ppp-charcoal-800 focus:outline-none focus:ring-2 focus:ring-cc-brand-400"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 6L6 18 M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
