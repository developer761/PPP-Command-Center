"use client";

import { useState } from "react";

/**
 * Copy the week's hours in the shape Gusto is typed in.
 *
 * The tab's own subtitle is "Hours to Gusto, the real cost back" — and only
 * the second half was built. Mary still had to read hours off the screen and
 * key them into Gusto one at a time, which is where a transposed figure gets
 * in, and a wrong figure there is wrong in the bank, not just on a report.
 *
 * It copies name and hours, tab separated, one person per line: pasteable into
 * a spreadsheet, and readable as a list if she is typing them in by hand.
 *
 * Hours only — NOT the job split. What Gusto needs is what each person is
 * paid for; the split is this platform's business and sending it out would
 * invite somebody to key it back in.
 */
export function CopyHoursButton({
  rows,
}: {
  rows: { name: string; hours: number }[];
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  const text = rows
    .map((r) => `${r.name}\t${Number(r.hours).toFixed(2)}`)
    .join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      // Clipboard access is refused outright in some browsers and over plain
      // http. Saying so beats a button that looks like it worked.
      setState("failed");
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={copy}
        className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center"
      >
        {state === "done" ? "Copied ✓" : "Copy hours for Gusto"}
      </button>
      {state === "failed" && (
        <div>
          <p className="text-[11px] text-rose-700 leading-snug">
            This browser would not let the page use the clipboard. Select the lines below
            and copy them.
          </p>
          <textarea
            readOnly
            value={text}
            rows={Math.min(12, rows.length + 1)}
            aria-label="Hours for Gusto"
            className="mt-1 w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-[12px] font-mono tabular-nums"
          />
        </div>
      )}
    </div>
  );
}
