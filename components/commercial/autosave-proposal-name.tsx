"use client";

/**
 * Autosave proposal name (Karan 2026-07-16).
 *
 * Karan kept typing a name in the top-of-editor rename input then
 * navigating away without clicking the "Save name" button — the field
 * looked like a title, not a form. Now the input auto-submits ~600ms
 * after the user stops typing (and immediately on blur/Enter), so the
 * name always persists without a click.
 *
 * Wire-up: renders inside a <form action={renameProposalAction}> parent
 * along with the hidden UUID inputs. When it needs to save, it calls
 * requestSubmit() on the parent form — server action handles the DB
 * write + revalidate. The visible status pill ("Saving…" / "Saved") is
 * the only surface, no confirm dialog or toast.
 *
 * Server round-trip triggers Next.js router refresh via revalidatePath
 * on the server action, so the "Saved" pill implicitly reflects that
 * downstream pages (kanban, account tab) will have the new name.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";

type Status = "idle" | "dirty" | "saving" | "saved" | "error";

export function AutosaveProposalName({
  initialValue,
  placeholder = "Name this revision",
  inputClassName = "",
}: {
  initialValue: string;
  placeholder?: string;
  inputClassName?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [status, setStatus] = useState<Status>("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last value that was actually persisted so we don't fire
  // a save when the user tabs away without changing anything, and don't
  // fire again if the debounced timer + the blur event race.
  const savedValueRef = useRef(initialValue);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function submitIfDirty() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const trimmed = value.trim();
    // Guard: no save if unchanged from last persisted value.
    if (trimmed === savedValueRef.current.trim()) return;
    const form = inputRef.current?.form;
    if (!form) return;
    // Use requestSubmit so we go through the server action pipeline
    // (validation, redirect, revalidatePath) — not a native
    // form.submit() which would do a full page navigation.
    form.requestSubmit();
  }

  function scheduleSave() {
    setStatus("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    // 600ms felt right in testing — long enough that a fast typist
    // finishes a word before the save fires, short enough that if the
    // user pauses to think the save happens before they navigate away.
    timerRef.current = setTimeout(() => {
      submitIfDirty();
    }, 600);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    // Server action triggered via requestSubmit() → the parent form's
    // action fires. Local UX bookkeeping: flag saving, then rely on the
    // page's ?saved=1 redirect + router refresh to reset us to saved.
    // We can't easily wait for the round-trip here without progress
    // events, so we optimistically flip to "Saved" after the flush.
    setStatus("saving");
    savedValueRef.current = value.trim();
    // Give the server action a brief window; the page will re-render
    // with saved=1 shortly after, resetting through our defaultValue.
    setTimeout(() => setStatus("saved"), 400);
    setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 2000);
    // Note: we intentionally don't preventDefault — let the form action
    // fire normally.
    void e;
  }

  return (
    <>
      {/* Attach an onSubmit that only exists for the local status
          bookkeeping. The action attribute is set on the parent
          <form> via server action from the page. */}
      <input
        ref={inputRef}
        type="text"
        name="project_name"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          scheduleSave();
        }}
        onBlur={submitIfDirty}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitIfDirty();
            inputRef.current?.blur();
          }
          if (e.key === "Escape") {
            setValue(savedValueRef.current);
            setStatus("idle");
            if (timerRef.current) clearTimeout(timerRef.current);
            inputRef.current?.blur();
          }
        }}
        placeholder={placeholder}
        className={inputClassName}
        aria-label="Proposal name (autosaves)"
      />
      {/* Small status pill — only rendered when actively transitioning
          so a saved / idle state doesn't add visual noise. */}
      <StatusPill status={status} onManualSave={submitIfDirty} />
      {/* Hidden submit handler wire — a hidden button lets us hook the
          form's onSubmit for local bookkeeping. */}
      <FormSubmitHook onSubmit={handleSubmit} />
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
  // Idle — very muted hint so first-time users know it autosaves.
  return (
    <span className="text-[10px] text-ppp-charcoal-400 italic shrink-0 hidden sm:inline">
      autosaves
    </span>
  );
}

/** Attaches a submit handler to the enclosing form for local status
 *  bookkeeping. Rendering this component after the input lets us use
 *  the parent form context without needing to lift state up. */
function FormSubmitHook({
  onSubmit,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const hookRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = hookRef.current;
    const form = el?.closest("form");
    if (!form) return;
    form.addEventListener("submit", onSubmit as unknown as EventListener);
    return () => {
      form.removeEventListener("submit", onSubmit as unknown as EventListener);
    };
  }, [onSubmit]);
  return <span ref={hookRef} className="hidden" aria-hidden />;
}
