"use client";

/**
 * Submit button that flips to a pending/loading state during a server
 * action round-trip. Karan 2026-07-10: "the delete button takes like
 * 5 seconds and isn't interactive whatsoever" — server actions can
 * stall while Postgres runs a cascade or a revalidate flushes, and
 * without a pending state the click feels dead. useFormStatus is the
 * only Next-native way to read pending state without lifting state
 * up. Reusable — pass the classes + label + pending copy.
 *
 * IMPORTANT: this component MUST live INSIDE its target <form>. The
 * `useFormStatus` hook only sees the enclosing form. If your button
 * needs to live outside the form (sticky footer via `form={id}`),
 * use PendingFormButton (peer file) instead — that one subscribes
 * to the target form's submit event by id.
 */

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

export function PendingSubmitButton({
  className,
  children,
  pendingLabel,
  ariaLabel,
}: {
  className: string;
  children: ReactNode;
  pendingLabel: string;
  ariaLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={ariaLabel}
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
