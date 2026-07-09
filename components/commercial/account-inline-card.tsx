"use client";

import { useRef, useState, useTransition } from "react";

/**
 * Karan 2026-07-08: autosave wrapper for the inline-edit Cards on the
 * account overview. Kills the Save button pattern in favor of blur-
 * to-persist. Shape:
 *
 *   <AccountInlineCardForm action={updateAccountSectionAction}>
 *     <input type="hidden" name="account_id" ... />
 *     <input type="hidden" name="section" ... />
 *     <EditableField ... />
 *   </AccountInlineCardForm>
 *
 * Behavior:
 *  - Tracks initial serialized form state on mount
 *  - When any input inside the form blurs AND the form has changed,
 *    calls form.requestSubmit() to fire the server action
 *  - Shows a subtle "Saving…" → "Saved ✓" chip at the top-right of
 *    the enclosing card body
 *  - Concurrent submits are gated by useTransition so a rapid tab-
 *    through only fires one save per input
 */
export default function AccountInlineCardForm({
  action,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  children: React.ReactNode;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const initialSerialized = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const serialize = (): string => {
    const f = formRef.current;
    if (!f) return "";
    const fd = new FormData(f);
    const parts: string[] = [];
    for (const [k, v] of fd.entries()) {
      // Skip hidden control fields (account_id, section) — they don't
      // change and would add noise to the equality check.
      if (k === "account_id" || k === "section") continue;
      if (typeof v === "string") parts.push(`${k}=${v}`);
    }
    return parts.sort().join("&");
  };

  const captureInitial = () => {
    if (initialSerialized.current === null) {
      initialSerialized.current = serialize();
    }
  };

  const handleBlur = () => {
    // A blur can fire when focus moves between inputs inside the
    // same form. Defer via requestAnimationFrame so we can check
    // if focus actually left the form.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (formRef.current && formRef.current.contains(active)) return;
      const current = serialize();
      if (current === initialSerialized.current) return;
      initialSerialized.current = current;
      startTransition(() => {
        formRef.current?.requestSubmit();
      });
      setSavedAt(Date.now());
    });
  };

  const status = isPending ? "saving" : savedAt ? "saved" : "idle";

  return (
    <form
      ref={formRef}
      action={action}
      onFocus={captureInitial}
      onBlurCapture={handleBlur}
      className="relative"
    >
      {status !== "idle" && (
        <span
          aria-live="polite"
          className={`absolute right-0 -top-1 text-[10px] font-semibold ${
            status === "saving" ? "text-ppp-charcoal-400" : "text-emerald-700"
          }`}
        >
          {status === "saving" ? "Saving…" : "Saved ✓"}
        </span>
      )}
      {children}
    </form>
  );
}
