"use client";

import { useRef, useState } from "react";

/**
 * Copy the week's hours in the shape Gusto is typed in.
 *
 * The tab's own subtitle is "Hours to Gusto, the real cost back" — and only
 * the second half was built. Mary still had to read hours off the screen and
 * key them into Gusto one at a time, which is where a transposed figure gets
 * in, and a wrong figure there is wrong in the bank, not just on a report.
 *
 * ── WHY THIS IS NOT JUST A CLIPBOARD CALL ──────────────────────────────────
 *
 * The first version was `await navigator.clipboard.writeText(...)`, then a
 * "Copied ✓" for two seconds. Clicking it in a real browser did NOTHING
 * VISIBLE — no tick, no error, nothing. `writeText` rejects when the document
 * is not focused, and in some states never settles at all, so the await sat
 * there forever and the catch never ran either. A button that silently does
 * nothing is worse than no button: Mary clicks it, pastes into Gusto, and gets
 * whatever was on her clipboard before.
 *
 * So the text is ALWAYS shown, in a selectable box, on click. The clipboard
 * write is an optimisation on top of that, raced against a timeout, and the
 * panel says which happened. There is no path through this component where
 * she ends up with nothing.
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
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"unknown" | "yes" | "no">("unknown");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const text = rows.map((r) => `${r.name}\t${Number(r.hours).toFixed(2)}`).join("\n");

  async function openAndTryCopy() {
    setOpen(true);
    setCopied("unknown");
    // Select it regardless, so ⌘C works the moment the panel appears.
    requestAnimationFrame(() => {
      boxRef.current?.focus();
      boxRef.current?.select();
    });
    try {
      // Raced. `writeText` can hang indefinitely when the page is not focused,
      // and an await that never settles leaves the UI stuck mid-action.
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200)),
      ]);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={openAndTryCopy}
        className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] flex items-center w-fit"
      >
        {open && copied === "yes" ? "Copied ✓" : "Copy hours for Gusto"}
      </button>

      {open && (
        <div className="rounded-lg border border-cc-brand-200 bg-cc-brand-50/40 p-2.5">
          <p className="text-[11px] text-ppp-charcoal-600 leading-snug mb-1.5">
            {copied === "yes"
              ? "On your clipboard — paste it into Gusto. It is also below if you need it again."
              : "Selected and ready — press ⌘C (or Ctrl+C) to copy, then paste into Gusto."}
          </p>
          <textarea
            ref={boxRef}
            readOnly
            value={text}
            rows={Math.min(12, rows.length + 1)}
            aria-label="Hours for Gusto"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-[12px] font-mono tabular-nums bg-surface"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-1 text-[11.5px] font-semibold text-ppp-charcoal-500 hover:underline min-h-[44px] flex items-center"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
