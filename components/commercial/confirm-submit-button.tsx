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
  children: React.ReactNode;
};

export default function ConfirmSubmitButton({
  message,
  className,
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
        setPending(true);
      }}
    >
      {pending ? "Removing…" : children}
    </button>
  );
}
