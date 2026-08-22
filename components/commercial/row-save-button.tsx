"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * Save button that tells you whether there is anything to save.
 *
 * Stephanie: *"'save row' implied I can click and save and I can't, change
 * verbiage to 'saved row'."*
 *
 * The button always worked. But on an untouched row there is nothing to save,
 * so pressing it appeared to do nothing at all — and a label reading "Save row"
 * promised otherwise. Her fix ("saved row") reads oddly on a control you press,
 * and would then be wrong the moment she edits something.
 *
 * So it shows the row's STATE instead: "Saved" and disabled until an input in
 * this row changes, "Save row" once it has. Same information she was asking
 * for, without a button whose label is false half the time.
 *
 * Dirtiness is read from real `input` events inside the row's own <form> — not
 * from React state — because every field in this row is uncontrolled
 * (defaultValue) and several are written by sibling widgets (the product chip
 * rewrites hidden inputs). Listening on the form catches all of it, including
 * changes this component knows nothing about.
 */
export function RowSaveButton() {
  const { pending } = useFormStatus();
  const [dirty, setDirty] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const mark = () => setDirty(true);
    // `input` covers typing; `change` covers checkboxes, selects and the
    // programmatic writes the product chip makes (it dispatches change).
    form.addEventListener("input", mark);
    form.addEventListener("change", mark);
    return () => {
      form.removeEventListener("input", mark);
      form.removeEventListener("change", mark);
    };
  }, []);

  // A completed save makes the row clean again — the server has it now.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) setDirty(false);
    wasPending.current = pending;
  }, [pending]);

  const label = pending ? "Saving…" : dirty ? "Save row" : "Saved";
  return (
    <button
      ref={ref}
      type="submit"
      disabled={pending || !dirty}
      // Not aria-disabled: there is genuinely nothing to submit, and letting a
      // screen-reader user press it would post an unchanged row and burn an
      // optimistic-lock round trip for nothing.
      className={
        dirty || pending
          ? "inline-flex items-center px-4 min-h-[44px] rounded-lg bg-ppp-charcoal-800 text-surface text-[13px] font-semibold hover:bg-ppp-navy-900 touch-manipulation disabled:opacity-60"
          : "inline-flex items-center px-4 min-h-[44px] rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-500 text-[13px] font-semibold touch-manipulation"
      }
    >
      {label}
    </button>
  );
}
