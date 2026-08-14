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
 *   - Calls the server action DIRECTLY with `new FormData(form)` — never
 *     `requestSubmit()`. React 19 resets a `<form action>` once the action
 *     resolves, which wiped half-typed uncontrolled inputs mid-autosave.
 *   - Small status pill top-right: "Saving…" → "Saved" → hidden after 3s.
 *   - Manual "Save now" button still present as a fallback (slow
 *     connections, paranoia).
 *   - No optimistic locking — the server action already returns errors
 *     via ?error= redirect if the save conflicts.
 */

import { useEffect, useRef, useState } from "react";
import { AUTOSAVE_FLAG, AUTOSAVE_DEBOUNCE_MS } from "@/lib/commercial/autosave-flag";

type Status = "idle" | "saving" | "saved" | "error";

export function AutosaveProposalForm({
  children,
  action,
  // Stephanie 2026-08-13 — see AUTOSAVE_DEBOUNCE_MS for why 800ms was wrong.
  // Shared with AutosaveForm so the two wrappers can't drift apart again.
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  disabled = false,
}: {
  children: React.ReactNode;
  action: (formData: FormData) => Promise<void>;
  debounceMs?: number;
  /** Karan 2026-07-20: pass `true` for non-draft proposals (sent/won/lost)
   *  so autosave stops firing. Prevents repeated "Save failed" pings on
   *  frozen proposals where the server-side draft-only guard rejects
   *  every write. Fields render as read-only via `fieldset[disabled]`. */
  disabled?: boolean;
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
    //
    // Its sibling autosave-form.tsx has carried this line, with this comment,
    // the whole time. Two components, one rule, written once and not the
    // other — the same drift the NEXT_REDIRECT note below calls out. Karan
    // 2026-08-13: "it asked me to leave the site."
    timerRef.current = null;
    if (disabled) return;
    if (!formRef.current) return;
    if (inFlightRef.current) {
      // A save is already running — queue one more after it lands.
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    setStatus("saving");
    // Marks this as a BACKGROUND save so the action skips revalidatePath.
    // Stephanie 2026-08-13: *"it automatically saves every 3 seconds making it
    // hard to enter data without it being overwritten or erased."* Every pause
    // in typing was re-rendering this page and two others out from under her.
    // An explicit save (Send for approval) still revalidates everything.
    const fd = new FormData(formRef.current);
    fd.set(AUTOSAVE_FLAG, "1");
    // Call the server action DIRECTLY with the form's data — NOT requestSubmit().
    // React 19 auto-RESETS a `<form action>` once the action resolves, which was
    // wiping half-typed uncontrolled inputs (phone + any field) on every 800ms
    // autosave — the "it glitches and won't let me enter the number" bug (Karan
    // meeting 2026-08). A direct call still saves + revalidates, without the reset.
    void wrappedAction(fd);
  }

  // Debounced listener on any input/change bubbling out of the form.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    if (disabled) return;
    const handler = () => scheduleSave();
    form.addEventListener("input", handler);
    form.addEventListener("change", handler);
    return () => {
      form.removeEventListener("input", handler);
      form.removeEventListener("change", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

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
    } catch (err) {
      // AUDIT 2026-08-13 (Karan: "the submittals page is autosaving and it
      // boots us out and won't let us go back into it. This happened with
      // proposals too. This cannot happen whatsoever.")
      //
      // This was a bare `catch {}`, which swallowed EVERYTHING — including the
      // NEXT_REDIRECT control signal. A server action that redirects (this one
      // does, with ?error= when a save conflicts) had its navigation eaten and
      // the pill flipped to "error" instead, so the page sat in a state it
      // could not leave and every later autosave hit the same conflict.
      //
      // Its sibling in autosave-form.tsx already re-throws for exactly this
      // reason. Two components, one rule, written once and not the other.
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
        // Fire the queued save on next tick to let React re-render.
        window.setTimeout(fireSave, 0);
      }
    }
  }

  return (
    <div className="relative">
      {!disabled && <StatusPill status={status} lastSavedAt={lastSavedAt} />}
      {/* No `action={...}` — autosave calls the server action directly (see
          fireSave) so React 19 never form-resets the inputs mid-type. onSubmit is
          blocked so pressing Enter in a field can't trigger a reset either. */}
      <form
        ref={formRef}
        onSubmit={(e) => e.preventDefault()}
        className="space-y-4"
      >
        {/* No `pointer-events-none` on the frozen fieldset.
            `fieldset[disabled]` already disables every form control inside —
            inputs, selects, textareas and buttons — natively. The extra
            pointer-events kill went further and disabled things that are not
            form controls at all: on a sent or won proposal it made the
            marked-up plan-set download links dead to mouse and touch (Tab +
            Enter still worked, which is how this hid), and blocked attaching a
            bid document, which files to the DEAL and has nothing to do with
            whether the proposal is frozen. Reading and downloading are not
            editing. */}
        {disabled ? (
          <fieldset disabled className="space-y-4 opacity-70">
            {children}
          </fieldset>
        ) : (
          children
        )}
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
          "text-ppp-charcoal-600 bg-surface border-ppp-charcoal-200",
        ];
    }
  })();
  if (!display) return null;
  return (
    <div
      aria-live="polite"
      /* Sticky only on mobile (where the toolbar is NOT sticky). On sm+ the
         toolbar is sticky and the pill was landing inside it, floating over the
         Send/Won/Lost buttons — so make it static there and flow normally. */
      className={`sticky top-16 sm:static z-10 ml-auto mb-2 w-fit max-w-[calc(100%-1rem)] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border shadow-sm ${color}`}
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
