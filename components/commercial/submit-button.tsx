"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that admits it is working.
 *
 * Karan, 2026-08-13, on "Just mark as sent": *"there's like a delay and the UX
 * isn't good."* It was a plain `<button type="submit">` inside a
 * `<form action={serverAction}>` — which shows NOTHING for the whole round
 * trip. No spinner, no disable, no change. On anything slower than instant the
 * button reads as dead, so people click it again, and a double-submit on
 * "mark as paid" or "send" is not a cosmetic problem.
 *
 * A sweep found 101 forms across Commercial CC in that state. This is the one
 * fix for all of them.
 *
 * It must be its own client component: `useFormStatus` reports on the nearest
 * form ABOVE it in the tree, so reading it inside the same component that
 * renders the `<form>` always returns `pending: false`. That subtlety is
 * exactly why hand-rolling it per site goes wrong.
 *
 * Server pages can render this directly — it is a client leaf inside their
 * form, which is the normal App Router shape.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = "",
  disabled = false,
  formAction,
  name,
  value,
  title,
  "aria-label": ariaLabel,
  form,
}: {
  children: React.ReactNode;
  /** What to say while it runs. Defaults to the label plus an ellipsis, which
   *  reads better than a generic "Saving…" on a button that says "Approve". */
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
  /** For multi-action forms — a second button posting to a different action. */
  formAction?: (formData: FormData) => void | Promise<void>;
  name?: string;
  value?: string;
  title?: string;
  "aria-label"?: string;
  /** For a button rendered OUTSIDE its form, linked by the form id. */
  form?: string;
}) {
  const { pending } = useFormStatus();
  const label =
    pending && pendingLabel !== undefined
      ? pendingLabel
      : pending && typeof children === "string"
      ? `${children}…`
      : children;

  return (
    <button
      type="submit"
      // Disabling while pending is the point: it is both the visible signal and
      // the guard against a second submit.
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      formAction={formAction}
      name={name}
      value={value}
      title={title}
      aria-label={ariaLabel}
      form={form}
      className={`${className} disabled:opacity-60 disabled:cursor-not-allowed transition-opacity`}
    >
      {label}
    </button>
  );
}
