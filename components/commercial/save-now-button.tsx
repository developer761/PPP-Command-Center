"use client";

import { useRef } from "react";

import { SAVE_NOW_EVENT } from "@/lib/commercial/save-now-event";

/**
 * A Save button on a form that already autosaves.
 *
 * Karan 2026-09-17: "have a work order save button."
 *
 * The work order form is an `AutosaveForm`: it saves 2.5s after you stop
 * typing, it has no submit control, and it calls `preventDefault()` on submit —
 * so pressing Enter does nothing visible either. The only feedback is a small
 * "Saving… / Saved" pill, and that pill renders NOTHING while idle before the
 * first save. Somebody who fills the form in and looks for the button finds no
 * button, no Enter, and no confirmation. Autosave being technically correct is
 * not the same as a person being able to tell their work is safe.
 *
 * So this does not replace autosave, it makes it visible and gives it a
 * control: the click flushes the pending debounce immediately via the event the
 * form already listens for, and the pill it triggers is the confirmation. Both
 * paths end in the same save, so there is no second way for the data to be
 * written and no new failure mode.
 */
export function SaveNowButton({
  label = "Save",
  className,
}: {
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        // Dispatch on the enclosing form — the listener is bound to the form
        // element, not the document, so a bubbling event from anywhere inside
        // reaches it and nothing outside this form can be triggered by mistake.
        const form = ref.current?.closest("form");
        form?.dispatchEvent(new CustomEvent(SAVE_NOW_EVENT, { bubbles: false }));
        // Take focus off the button so the pill (aria-live) is what a screen
        // reader announces next, rather than the button re-reading itself.
        ref.current?.blur();
      }}
      className={
        className ??
        "inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 active:translate-y-px transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cc-brand-600"
      }
    >
      {label}
    </button>
  );
}
