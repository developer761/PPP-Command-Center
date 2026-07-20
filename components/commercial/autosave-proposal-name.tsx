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
 * Submit path: form.requestSubmit() fires the parent form's server
 * action (renameProposalAction), which patches header_json.project_name
 * + revalidatePath on editor/account/proposals-list pages.
 */
import { useEffect, useRef, useState } from "react";

type Status = "idle" | "dirty" | "saving" | "saved";

export function AutosaveProposalName({
  initialValue,
  placeholder = "Name this revision",
  inputClassName = "",
  disabled = false,
}: {
  initialValue: string;
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

  // When the server round-trips a fresh value (post-save redirect, or
  // another tab renamed), reflect it in the input — but only if the
  // input isn't currently focused. Never clobber active user typing.
  useEffect(() => {
    savedValueRef.current = initialValue.trim();
    const el = inputRef.current;
    if (!el) return;
    if (document.activeElement !== el) {
      el.value = initialValue;
    }
  }, [initialValue]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function submit() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const el = inputRef.current;
    if (!el) return;
    const val = el.value.trim();
    if (val === savedValueRef.current) return;
    savedValueRef.current = val;
    setStatus("saving");
    // requestSubmit fires the parent form's server action (React's
    // form action handler is registered via `<form action={fn}>` at
    // the DOM level, so this correctly routes to renameProposalAction).
    el.form?.requestSubmit();
    // Optimistically flip to "Saved" after a short window — the
    // server action redirects will re-render the tree; if the save
    // errored the ?error= banner takes over.
    setTimeout(() => setStatus("saved"), 500);
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
                timerRef.current = setTimeout(submit, 600);
              }
        }
        onBlur={disabled ? undefined : submit}
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
      {!disabled && <StatusPill status={status} onManualSave={submit} />}
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
