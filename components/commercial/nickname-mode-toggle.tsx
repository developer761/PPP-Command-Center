"use client";

/**
 * The "add it to the end / use it instead" switch that sits under every
 * Project-nickname input.
 *
 * Brendan 2026-08-26: "the project nickname should go at the end of the
 * opportunity title, and we should be able to toggle that."
 *
 * One component rather than three copies of a checkbox, because the nickname
 * input exists on three separate forms — the pipeline's new-deal sheet, the
 * account page's new-deal form, and the deal edit sheet — and each posts to its
 * own action. Three hand-written copies of a control whose value carries
 * meaning is precisely how the platform ends up with a toggle that works on two
 * screens and silently does nothing on the third.
 *
 * A checkbox posts nothing when unticked, which would be indistinguishable from
 * "this form doesn't know about the field" on an older action. So the value is
 * carried explicitly by a hidden input the checkbox drives, and the mode is
 * always present in the payload.
 */

import { useState } from "react";

export function NicknameModeToggle({
  /** Stored mode. Undefined on a create form; 'replace' on rows saved before
   *  migration 170, which is the behaviour those rows already have. */
  value,
  idPrefix = "nickname-mode",
}: {
  value?: string | null;
  idPrefix?: string;
}) {
  const [appends, setAppends] = useState((value ?? "append") === "append");
  return (
    <div className="mt-1.5">
      <input type="hidden" name="title_override_mode" value={appends ? "append" : "replace"} />
      <label
        htmlFor={`${idPrefix}-append`}
        className="inline-flex items-start gap-2 cursor-pointer select-none"
      >
        <input
          id={`${idPrefix}-append`}
          type="checkbox"
          checked={appends}
          onChange={(e) => setAppends(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-600"
        />
        <span className="text-[12px] leading-snug text-ppp-charcoal-600">
          Add it to the end of the full name
          <span className="block text-[11px] text-ppp-charcoal-400">
            {appends
              ? "The job keeps its GC and address, with the nickname on the end."
              : "The nickname is used on its own — the GC and address won't show in lists."}
          </span>
        </span>
      </label>
    </div>
  );
}
