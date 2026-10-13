"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/**
 * A submit button that says it's working while its server action runs.
 *
 * The Online Payments buttons each wait on Salesforce (and Stripe) for a few
 * seconds; without this the click looks dead and people press again. Locks
 * itself while pending, so a second press can't send a second request.
 * Must sit INSIDE its <form> — useFormStatus only sees the enclosing form.
 */
export function PendingButton({
  className,
  children,
  pendingLabel,
}: {
  className: string;
  children: ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={`${className} ${pending ? "opacity-70 cursor-wait" : ""}`}>
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          {pendingLabel}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
