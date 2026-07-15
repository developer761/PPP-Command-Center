"use client";

/**
 * Small client wrapper for a form submit button that fires a native
 * confirm() before submitting. Used on the Proposal Builder's
 * "Remove row" action so Alex doesn't lose a line item to a
 * misclick. The parent stays a server component (so the form's
 * `action` remains a server action).
 */

import { useState } from "react";

type Props = {
  message: string;
  className?: string;
  /** Text shown while the form is submitting. Defaults to "Working…"
   *  so callers that don't care get a sensible fallback (not "Removing…"
   *  which was the original delete-only hard-code). */
  pendingLabel?: string;
  children: React.ReactNode;
};

export default function ConfirmSubmitButton({
  message,
  className,
  pendingLabel = "Working…",
  children,
}: Props) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(message)) {
          e.preventDefault();
          return;
        }
        // Karan 2026-07-15 bugfix: `setPending(true)` inside the click
        // handler synchronously disables the submit button before the
        // browser has finished dispatching the form's submit event —
        // which cancels the submission entirely (button-disabled-mid-
        // submit is a browser-level cancel signal). Defer the state
        // flip to the next macrotask so the form gets to submit
        // FIRST, then the disabled + label swap happens for the
        // visible pending state.
        window.setTimeout(() => setPending(true), 0);
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
