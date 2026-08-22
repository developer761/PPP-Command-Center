"use client";

/**
 * Autosave proposal name (Karan 2026-07-16).
 *
 * First revision used a controlled input + a hacky form-submit hook —
 * Karan flagged that saves weren't persisting. Rewritten uncontrolled:
 * defaultValue seeds the DOM value once, we read the current value via
 * ref on every save. Removes any React state/prop reconciliation
 * racing with user typing. On success, server action redirect
 * re-renders the tree with the new server value; useEffect syncs the
 * DOM value only when the input isn't focused (won't clobber active
 * typing).
 *
 * Triggers save:
 *   - 600ms after the user stops typing (input event debounce)
 *   - Immediately on blur
 *   - Immediately on Enter
 *   - Escape reverts to the last-saved value
 *
 * Submit path: the `action` prop (renameProposalAction) is called
 * DIRECTLY with the parent form's FormData — never requestSubmit().
 * React 19 auto-resets a `<form action>` once the action resolves, which
 * wiped the half-typed name on every 600ms debounce tick (same class of
 * bug as the proposal editor's phone field, Karan meeting 2026-08). The
 * action still patches header_json.project_name + revalidatePath on the
 * editor/account/proposals-list pages.
 */
import { useEffect, useRef, useState } from "react";
import { AUTOSAVE_FLAG, AUTOSAVE_DEBOUNCE_MS } from "@/lib/commercial/autosave-flag";

type Status = "idle" | "dirty" | "saving" | "saved";

export function AutosaveProposalName({
  initialValue,
  action,
  placeholder = "Name this revision",
  inputClassName = "",
  disabled = false,
}: {
  initialValue: string;
  /** The rename server action. Called directly with the enclosing form's
   *  FormData so React 19 never form-resets the input mid-type. */
  action: (formData: FormData) => Promise<void> | void;
  placeholder?: string;
  inputClassName?: string;
  /** Karan 2026-07-20: sent/won/lost proposals are frozen — the
   *  server-side draft-only guard on updateProposal rejects renames.
   *  Pass true to render read-only and skip autosave. */
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedValueRef = useRef(initialValue.trim());
  const [status, setStatus] = useState<Status>("idle");

  // When the server round-trips a fresh value (post-save redirect, or another
  // tab renamed), reflect it in the input.
  //
  // "Not focused" is not a safe enough test on its own. Type, pause, let a save
  // fire, keep typing, then click away: the blur submits the NEW text while the
  // earlier save's payload is still in flight, and when it lands the field is
  // no longer focused — so it overwrote what was just typed with the older
  // string. Only adopt the server's value when the box still holds exactly what
  // was last saved, i.e. the user has typed nothing since.
  useEffect(() => {
    const el = inputRef.current;
    const prevSaved = savedValueRef.current;
    savedValueRef.current = initialValue.trim();
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.value.trim() !== prevSaved) return; // unsaved edits present — leave them
    el.value = initialValue;
  }, [initialValue]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  /**
   * `background` = the debounce timer fired, not a person. The server skips
   * revalidatePath for those, which is the whole point of the seam — see
   * lib/commercial/autosave-flag.
   *
   * This component was written from the same template as its two siblings and
   * missed the flag, which is the THIRD time that has happened (the module's
   * own comment records the Work Order and Closeout tools). So a name save
   * re-rendered the editor the user was typing into every 600ms.
   */
  function submit(background = false) {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const el = inputRef.current;
    if (!el) return;
    const val = el.value.trim();
    if (val === savedValueRef.current) return;
    const form = el.form;
    if (!form) return;
    savedValueRef.current = val;
    setStatus("saving");
    // Call the action DIRECTLY — NOT requestSubmit(). React 19 resets a
    // `<form action>` after the action resolves, and this input is
    // uncontrolled (defaultValue), so a reset mid-type threw away
    // everything typed since the last save. The FormData carries the
    // sibling hidden ids plus this field, exactly as a submit would.
    const fd = new FormData(form);
    if (background) fd.set(AUTOSAVE_FLAG, "1");
    void Promise.resolve(action(fd)).catch((err: unknown) => {
      // Re-throw the redirect control signal instead of swallowing it.
      //
      // This was a bare `catch (){}`, and the comment below — "the server's
      // ?error= banner carries the detail" — described something that could
      // never happen: renameProposalAction reports failure by redirecting to
      // ?error=, which throws NEXT_REDIRECT, which this catch ate. Rename a
      // proposal that another tab has already approved and the save fails
      // silently, the pill drops back to "Editing…" with no message, and
      // `savedValueRef.current = ""` below corrupts the dedupe state so every
      // later keystroke re-fires the same doomed save.
      //
      // Both sibling autosave components were fixed for exactly this; this
      // third copy was written from the same template and missed. Karan
      // 2026-08-13: "it boots us out and won't let us go back into it. This
      // cannot happen whatsoever."
      if (
        err &&
        typeof (err as { digest?: unknown }).digest === "string" &&
        (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
      ) {
        throw err;
      }
      // Surface a failed save by reverting the optimistic "saved" state;
      // the server's ?error= banner carries the detail.
      setStatus("dirty");
      savedValueRef.current = "";
    });
    // Optimistically flip to "Saved" after a short window — the
    // server action redirects will re-render the tree; if the save
    // errored the ?error= banner takes over.
    setTimeout(() => setStatus((s) => (s === "saving" ? "saved" : s)), 500);
    setTimeout(
      () => setStatus((s) => (s === "saved" ? "idle" : s)),
      2200
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        name="project_name"
        defaultValue={initialValue}
        readOnly={disabled}
        onInput={
          disabled
            ? undefined
            : () => {
                setStatus("dirty");
                if (timerRef.current) clearTimeout(timerRef.current);
                // 600ms fired on the pause between two words. The shared
                // constant is the pause between two thoughts.
                timerRef.current = setTimeout(() => submit(true), AUTOSAVE_DEBOUNCE_MS);
              }
        }
        // Blur and Enter pass background=false on purpose: leaving the field
        // is the moment the new name should appear on the other pages.
        onBlur={disabled ? undefined : () => submit(false)}
        onKeyDown={
          disabled
            ? undefined
            : (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  e.currentTarget.value = savedValueRef.current;
                  setStatus("idle");
                  if (timerRef.current) {
                    clearTimeout(timerRef.current);
                    timerRef.current = null;
                  }
                  e.currentTarget.blur();
                }
              }
        }
        placeholder={placeholder}
        className={inputClassName}
        aria-label={disabled ? "Proposal name (frozen — read-only)" : "Proposal name (autosaves)"}
      />
      {!disabled && (
        <span role="status" aria-live="polite">
          <StatusPill status={status} onManualSave={submit} />
        </span>
      )}
    </>
  );
}

function StatusPill({
  status,
  onManualSave,
}: {
  status: Status;
  onManualSave: () => void;
}) {
  if (status === "dirty") {
    return (
      <button
        type="button"
        onClick={onManualSave}
        className="text-[10.5px] font-semibold text-ppp-charcoal-500 hover:text-cc-brand-700 shrink-0 px-2 py-1 rounded"
        title="Click to save now (or wait — autosaves after you stop typing)"
      >
        Editing…
      </button>
    );
  }
  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-ppp-charcoal-500 shrink-0 px-2 py-1">
        <svg
          className="animate-spin"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700 shrink-0 px-2 py-1">
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Saved
      </span>
    );
  }
  return (
    <span className="text-[10px] text-ppp-charcoal-400 italic shrink-0 hidden sm:inline">
      autosaves
    </span>
  );
}
