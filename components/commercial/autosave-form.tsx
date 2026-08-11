"use client";

/**
 * Generic client-side autosave form wrapper (2026-08) — the same pattern the
 * proposal editor uses, generalized for the production tools. Wrap a form's
 * fields; every input/change → debounced (default 800ms) save via the passed
 * server action, with a quiet "Saving… / Saved" pill top-right. A manual Save
 * button is no longer needed (but any nested submit still works).
 *
 * Pass `disabled` for read-only/frozen records so autosave stops firing and the
 * fields render read-only. `formClassName` styles the inner <form>.
 */

import { useEffect, useRef, useState } from "react";

type Status = "idle" | "saving" | "saved" | "error";

export function AutosaveForm({
  children,
  action,
  debounceMs = 800,
  disabled = false,
  formClassName = "space-y-3",
}: {
  children: React.ReactNode;
  action: (formData: FormData) => Promise<void> | void;
  debounceMs?: number;
  disabled?: boolean;
  formClassName?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const [status, setStatus] = useState<Status>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  function scheduleSave() {
    if (disabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fireSave, debounceMs);
  }
  function fireSave() {
    // The debounce timer has now fired — clear the ref so `beforeunload`
    // doesn't keep seeing a stale truthy id and prompt "Leave site?" forever
    // (the timer is one-shot; setTimeout never nulls this for us).
    timerRef.current = null;
    if (disabled || !formRef.current) return;
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    setStatus("saving");
    // Call the server action DIRECTLY with the form's data — NOT
    // requestSubmit(). React 19 auto-RESETS a `<form action>` once the action
    // resolves, which wipes half-typed uncontrolled inputs on every debounce
    // tick — the "it glitches and won't let me enter the number" bug Karan hit
    // on the proposal editor (meeting 2026-08). Same fix, same reason: a direct
    // call still saves + revalidates, without the reset.
    void wrappedAction(new FormData(formRef.current));
  }

  useEffect(() => {
    const form = formRef.current;
    if (!form || disabled) return;
    const handler = () => scheduleSave();
    form.addEventListener("input", handler);
    form.addEventListener("change", handler);
    return () => {
      form.removeEventListener("input", handler);
      form.removeEventListener("change", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

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

  async function wrappedAction(formData: FormData) {
    try {
      await action(formData);
      setStatus("saved");
      setLastSavedAt(new Date());
      window.setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 3000);
    } catch (err) {
      // A server action that calls redirect() throws a NEXT_REDIRECT control
      // signal — re-throw it so navigation still happens instead of being
      // swallowed into a phantom "Save failed". (Today's wired action returns
      // rather than redirects, but future autosave actions may not.)
      if (
        err &&
        typeof (err as { digest?: unknown }).digest === "string" &&
        (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
      ) {
        throw err;
      }
      setStatus("error");
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        window.setTimeout(fireSave, 0);
      }
    }
  }

  return (
    <div className="relative">
      {!disabled && <StatusPill status={status} lastSavedAt={lastSavedAt} />}
      {/* No `action={...}` — autosave calls the server action directly (see
          fireSave) so React 19 never form-resets the inputs mid-type. onSubmit
          is blocked so pressing Enter in a field can't trigger a reset either;
          the debounced save covers it either way. */}
      <form
        ref={formRef}
        onSubmit={(e) => e.preventDefault()}
        className={formClassName}
      >
        {disabled ? (
          <fieldset disabled className={`${formClassName} opacity-70 pointer-events-none`}>{children}</fieldset>
        ) : (
          children
        )}
      </form>
    </div>
  );
}

function StatusPill({ status, lastSavedAt }: { status: Status; lastSavedAt: Date | null }) {
  if (status === "idle" && !lastSavedAt) return null;
  const [display, color] = (() => {
    switch (status) {
      case "saving": return ["Saving…", "text-cc-brand-800 bg-cc-brand-50 border-cc-brand-200"];
      case "saved": return ["Saved", "text-emerald-800 bg-emerald-50 border-emerald-200"];
      case "error": return ["Save failed — retry?", "text-rose-800 bg-rose-50 border-rose-200"];
      default: return [lastSavedAt ? `Saved ${formatRelative(lastSavedAt)}` : "", "text-ppp-charcoal-600 bg-surface border-ppp-charcoal-200"];
    }
  })();
  if (!display) return null;
  return (
    <div aria-live="polite" className={`sticky top-16 sm:static z-10 ml-auto mb-2 w-fit max-w-[calc(100%-1rem)] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border shadow-sm ${color}`}>
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
