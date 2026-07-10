"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-side row-action strip for a document on the Files sub-tab.
 *
 * Layout: [Star toggle] [Status transition inline buttons] [New version]
 * [Delete]. The New-version action opens a right-side slide-out sheet
 * (GHL style) so the user can pick a file + add notes without losing
 * their place on the list.
 *
 * Server actions do the mutations — this component just fires form
 * submits or calls the version API. All UI state is local; parent
 * server component re-renders on router.refresh().
 */
type Props = {
  documentId: string;
  status: "draft" | "pending_review" | "approved" | "rejected" | "superseded";
  favorited: boolean;
  /** Next statuses the DAG allows from `status`. Server computes this so
   *  the client can't invent transitions — falls through to server-side
   *  validation on submit anyway. */
  allowedNext: Array<"draft" | "pending_review" | "approved" | "rejected">;
  /** The category chip currently active on the parent tab (or null). The
   *  server actions read this from a hidden input so their post-action
   *  redirect can carry the filter forward. */
  currentCategory: string | null;
  /** Server actions bound to formData. */
  toggleFavoriteAction: (formData: FormData) => void;
  transitionStatusAction: (formData: FormData) => void;
  deleteAction: (formData: FormData) => void;
};

export function CommercialFileRowActions({
  documentId,
  status,
  favorited,
  allowedNext,
  currentCategory,
  toggleFavoriteAction,
  transitionStatusAction,
  deleteAction,
}: Props) {
  const [versionOpen, setVersionOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isTerminal = status === "approved" || status === "superseded";

  return (
    <div className="flex items-center gap-1 shrink-0 flex-wrap">
      {/* Favorite star toggle — server action. Rendered as a plain form so it
          works without JS (progressive enhancement). */}
      <form action={toggleFavoriteAction}>
        <input type="hidden" name="document_id" value={documentId} />
        <input type="hidden" name="favorited" value={favorited ? "1" : "0"} />
        {currentCategory && <input type="hidden" name="current_category" value={currentCategory} />}
        <button
          type="submit"
          className={`inline-flex items-center justify-center h-8 w-8 rounded hover:bg-ppp-charcoal-100 min-h-[36px] min-w-[36px] touch-manipulation ${
            favorited ? "text-amber-500" : "text-ppp-charcoal-300 hover:text-amber-400"
          }`}
          title={favorited ? "Unfavorite" : "Mark as favorite"}
          aria-label={favorited ? "Unfavorite" : "Favorite"}
        >
          {favorited ? "★" : "☆"}
        </button>
      </form>

      {/* Status transitions — inline buttons for each allowed next status.
          Terminal statuses render no buttons (approved is final; superseded
          is auto-set by version bump). */}
      {allowedNext.map((next) => (
        <form key={next} action={transitionStatusAction}>
          <input type="hidden" name="document_id" value={documentId} />
          <input type="hidden" name="to_status" value={next} />
          {currentCategory && <input type="hidden" name="current_category" value={currentCategory} />}
          <button
            type="submit"
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold min-h-[44px] touch-manipulation ${transitionBtnCls(
              next
            )}`}
            title={transitionLabel(next, status)}
          >
            {transitionLabel(next, status)}
          </button>
        </form>
      ))}

      {/* New version — opens the right slide-out (only for non-terminal
          docs — you can't version-bump an already-superseded row or a
          fully-approved one; if the approved version needs a change, the
          convention is to just upload a new doc under the same category). */}
      {!isTerminal && (
        <button
          type="button"
          onClick={() => setVersionOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-100 min-h-[44px] touch-manipulation"
          title="Upload a new version — supersedes this one"
        >
          New version
        </button>
      )}

      {/* Delete — two-click confirm. First click reveals a red "Confirm"
          button; a second click submits the form. Keeps destructive
          actions from being one-tap accidents. */}
      {!confirmDelete ? (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px] touch-manipulation"
          title="Delete this file"
        >
          Delete
        </button>
      ) : (
        <form
          action={deleteAction}
          onSubmit={() => setConfirmDelete(false)}
          className="inline-flex items-center gap-1"
        >
          <input type="hidden" name="document_id" value={documentId} />
          {currentCategory && <input type="hidden" name="current_category" value={currentCategory} />}
          <button
            type="submit"
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-rose-600 text-white hover:bg-rose-700 min-h-[44px] touch-manipulation"
          >
            Confirm delete
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className="inline-flex items-center px-2 py-1 rounded text-[11px] font-semibold text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Cancel
          </button>
        </form>
      )}

      {versionOpen && (
        <VersionBumpSheet documentId={documentId} onClose={() => setVersionOpen(false)} />
      )}
    </div>
  );
}

function transitionLabel(next: string, from: string): string {
  if (next === "pending_review") return "Send for review";
  if (next === "approved") return "Approve";
  if (next === "rejected") return "Reject";
  if (next === "draft") return from === "rejected" ? "Back to draft" : "Move to draft";
  return next;
}

function transitionBtnCls(next: string): string {
  switch (next) {
    case "approved":
      return "text-emerald-800 hover:bg-emerald-50";
    case "rejected":
      return "text-rose-700 hover:bg-rose-50";
    case "pending_review":
      return "text-amber-800 hover:bg-amber-50";
    case "draft":
      return "text-ppp-charcoal-700 hover:bg-ppp-charcoal-100";
    default:
      return "text-ppp-charcoal-700 hover:bg-ppp-charcoal-100";
  }
}

/**
 * Right-slide-out sheet for uploading a new version. File input + notes.
 * Category inherits from the previous version (server enforces).
 */
function VersionBumpSheet({
  documentId,
  onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Close on Escape — matches modal + popover conventions elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Pick a file first.");
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const fd = new FormData();
    fd.append("file", file);
    if (notes.trim()) fd.append("notes", notes.trim());
    try {
      const res = await fetch(`/api/commercial/documents/${documentId}/version`, {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Upload failed." }));
        throw new Error(body.detail || body.error || `Upload failed (${res.status}).`);
      }
      onClose();
      router.refresh();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message || "Upload failed.");
        // Karan 2026-07-10 audit fix: scroll the sheet's scroll
        // container to the top so the error banner is above the fold.
        // Without this, a long notes textarea + a below-fold error made
        // the failure invisible on mobile.
        requestAnimationFrame(() => {
          const form = document.getElementById("version-bump-form");
          form?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
      setBusy(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={busy ? undefined : onClose}
        aria-hidden
      />

      {/* Right slide-out */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-sheet-title"
        className="fixed inset-y-0 right-0 w-full sm:w-[440px] bg-white shadow-2xl z-50 flex flex-col animate-in slide-in-from-right"
      >
        <header className="px-5 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 id="version-sheet-title" className="text-sm font-bold text-ppp-charcoal">
              Upload new version
            </h2>
            <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
              This version becomes the current head. The previous version is kept in history.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-ppp-charcoal-500 hover:text-ppp-charcoal p-2 -mr-2 min-h-[40px] min-w-[40px] touch-manipulation"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <form
          id="version-bump-form"
          onSubmit={onSubmit}
          className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
        >
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-ppp-charcoal-700 mb-1">
              New file
            </span>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.doc,.docx,.xls,.xlsx,.txt"
              className="block w-full text-sm text-ppp-charcoal file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:font-semibold file:bg-ppp-charcoal-100 file:text-ppp-charcoal hover:file:bg-ppp-charcoal-200"
              required
            />
            {file && (
              <span className="block text-[10.5px] text-ppp-charcoal-500 mt-1 truncate">
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
              </span>
            )}
          </label>

          <label className="block">
            <span className="block text-[11.5px] font-semibold text-ppp-charcoal-700 mb-1">
              What changed in this version? (optional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Revised per RFI-14 responses."
              className="block w-full rounded-md border border-ppp-charcoal-200 bg-white px-2.5 py-1.5 text-sm text-ppp-charcoal placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 focus:border-cc-brand-500 min-h-[80px] resize-y"
            />
          </label>

          {error && (
            <div className="bg-rose-50 border border-rose-200 rounded-md px-3 py-2 text-[12px] text-rose-700">
              {error}
            </div>
          )}
        </form>

        <footer className="px-5 py-3 border-t border-ppp-charcoal-100 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center px-3 py-2 rounded-md border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[40px] touch-manipulation"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="version-bump-form"
            disabled={busy || !file}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/25 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Uploading…" : "Upload new version"}
          </button>
        </footer>
      </aside>
    </>
  );
}
