"use client";

/**
 * Loading-state submit button that lives OUTSIDE its target form
 * (via `form={id}` attribute). `useFormStatus` only reports pending
 * state from the ENCLOSING form, so a button in a sticky footer
 * pointing at `form="edit-deal-form-<id>"` never flips.
 *
 * This component subscribes to the target form's submit event by id
 * and manages a local `pending` state that clears when the browser
 * finishes navigation (which server-action redirects trigger).
 *
 * Use PendingSubmitButton (peer file) for INSIDE-the-form buttons
 * (the useFormStatus flavor). This one is for sticky-footer or
 * portaled buttons where the button and form are DOM-detached.
 *
 * Karan 2026-07-10: audit round 4 flagged that Save-deal, Create-deal,
 * NewDealSlideOut, and every other sticky-footer submit stalls 500ms-3s
 * with no visual feedback. This closes that gap for the ones where
 * useFormStatus can't reach.
 */

import { useEffect, useState, type ReactNode } from "react";

export function PendingFormButton({
  formId,
  className,
  children,
  pendingLabel,
  ariaLabel,
}: {
  /** The `id` of the target form. Must be a `<form id={formId}>` that
   *  exists in the same document when this button renders. */
  formId: string;
  className: string;
  children: ReactNode;
  pendingLabel: string;
  ariaLabel?: string;
}) {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    // Track when the browser is committing this form's submission so
    // we can flip the visual state. A server-action redirect ends the
    // page instance entirely, so `pending` can safely stay true —
    // the next page render replaces this component.
    const onSubmit = () => setPending(true);
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [formId]);

  return (
    <button
      type="submit"
      form={formId}
      aria-label={ariaLabel}
      disabled={pending}
      className={`${className} ${pending ? "opacity-70 cursor-wait" : ""}`}
    >
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <svg
            className="animate-spin"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeOpacity="0.35"
              strokeWidth="3"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          {pendingLabel}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
