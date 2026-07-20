"use client";

/**
 * Client-side autosave wrapper for the proposal editor's main form.
 *
 * Karan 2026-07-20: "everytime i fill something into the proposal or
 * anything it should autosave itself i shouldnt hbave to click the save
 * button". Wraps the header + intro + estimator + exclusions form so
 * every field change → debounced (800ms) save via the existing
 * `saveProposalAction` server action.
 *
 * Behavior:
 *   - Listens for `input` and `change` events on any nested form
 *     control (text, textarea, checkbox, select).
 *   - Debounces 800ms — pauses the timer while the user is still
 *     typing, fires once they stop.
 *   - Fires the parent form's `requestSubmit()` so the existing action
 *     handles the FormData exactly like the button did.
 *   - Small status pill top-right: "Saving…" → "Saved" → hidden after 3s.
 *   - Manual "Save now" button still present as a fallback (slow
 *     connections, paranoia).
 *   - No optimistic locking — the server action already returns errors
 *     via ?error= redirect if the save conflicts.
 */

import { useEffect, useRef, useState } from "react";

type Status = "idle" | "saving" | "saved" | "error";

export function AutosaveProposalForm({
  children,
  action,
  debounceMs = 800,
}: {
  children: React.ReactNode;
  action: (formData: FormData) => Promise<void>;
  debounceMs?: number;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const [status, setStatus] = useState<Status>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  function scheduleSave() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fireSave, debounceMs);
  }

  function fireSave() {
    if (!formRef.current) return;
    if (inFlightRef.current) {
      // A save is already running — queue one more after it lands.
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    setStatus("saving");
    // Use requestSubmit so the server action fires with the exact
    // FormData shape the manual button used. React handles the submit
    // event → server action pipeline for us.
    formRef.current.requestSubmit();
  }

  // Debounced listener on any input/change bubbling out of the form.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const handler = () => scheduleSave();
    form.addEventListener("input", handler);
    form.addEventListener("change", handler);
    return () => {
      form.removeEventListener("input", handler);
      form.removeEventListener("change", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn if the user tries to navigate away mid-save.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (inFlightRef.current || timerRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // React's server-action pipeline doesn't expose a "saved" callback
  // directly, so we wrap the passed action to flip our in-flight
  // state + drain any pending saves that were queued during the flight.
  async function wrappedAction(formData: FormData) {
    try {
      await action(formData);
      setStatus("saved");
      setLastSavedAt(new Date());
      // Auto-fade the "Saved" pill to idle after 3s.
      window.setTimeout(() => {
        setStatus((s) => (s === "saved" ? "idle" : s));
      }, 3000);
    } catch {
      setStatus("error");
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        // Fire the queued save on next tick to let React re-render.
        window.setTimeout(fireSave, 0);
      }
    }
  }

  return (
    <div className="relative">
      <StatusPill status={status} lastSavedAt={lastSavedAt} />
      <form
        ref={formRef}
        action={wrappedAction}
        className="space-y-4"
      >
        {children}
      </form>
    </div>
  );
}

function StatusPill({
  status,
  lastSavedAt,
}: {
  status: Status;
  lastSavedAt: Date | null;
}) {
  if (status === "idle" && !lastSavedAt) return null;
  const [display, color] = (() => {
    switch (status) {
      case "saving":
        return ["Saving…", "text-cc-brand-800 bg-cc-brand-50 border-cc-brand-200"];
      case "saved":
        return ["Saved", "text-emerald-800 bg-emerald-50 border-emerald-200"];
      case "error":
        return ["Save failed — retry?", "text-rose-800 bg-rose-50 border-rose-200"];
      default:
        return [
          lastSavedAt ? `Saved ${formatRelative(lastSavedAt)}` : "",
          "text-ppp-charcoal-600 bg-white border-ppp-charcoal-200",
        ];
    }
  })();
  if (!display) return null;
  return (
    <div
      aria-live="polite"
      className={`sticky top-2 z-30 ml-auto mb-2 w-fit inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border shadow-sm ${color}`}
    >
      {status === "saving" && (
        <svg width="10" height="10" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="42" strokeLinecap="round" />
        </svg>
      )}
      {display}
    </div>
  );
}

function formatRelative(d: Date): string {
  const s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
