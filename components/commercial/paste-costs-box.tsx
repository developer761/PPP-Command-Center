"use client";

import { useState } from "react";
import { parsePastedAmounts } from "@/lib/commercial/field-ops/paste-amounts";

/**
 * Paste a column of Gusto figures into the cost boxes.
 *
 * Katie wanted an upload. This is deliberately not one: an upload has to match
 * Gusto's names to a roster holding two Lucatortos and two Roberts behind
 * display names like "Tomco Labor - Joe", and guessing there puts one man's
 * pay on another man's jobs while looking entirely plausible.
 *
 * Pasting keeps the person in the loop. The figures go into the boxes NEXT TO
 * THE NAMES she is already reading, nothing is saved until she presses Save,
 * and the count is stated before she does — so a column that is one row short,
 * or one row long, is visible rather than discovered in a margin next month.
 *
 * It fills the boxes in ORDER, which is the one thing she has to know, so the
 * order is printed on the label rather than assumed.
 */
export function PasteCostsBox({
  employees,
}: {
  /** In the order the boxes appear. Targeted by `id`, not by name: the roster
   *  holds two Lucatortos and two Roberts, and a display name is not unique
   *  enough to write money against. */
  employees: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const employeeNames = employees.map((e) => e.name);

  const { cents, unreadable } = parsePastedAmounts(text);
  const tooMany = cents.length > employeeNames.length;
  const short = cents.length > 0 && cents.length < employeeNames.length;

  function apply() {
    // Write straight into the existing inputs. No new state, no second copy of
    // the figures to fall out of step with what the form will actually post.
    let i = 0;
    for (const emp of employees) {
      if (i >= cents.length) break;
      // By form field name. Selecting on the visible label looked tidier and
      // was wrong twice over: display names repeat on this roster, and the
      // panel briefly rendered a phone layout and a desktop layout at once, so
      // the first match was whichever one happened to be hidden.
      const el = document.querySelector<HTMLInputElement>(
        `input[name="cost_${CSS.escape(emp.id)}"]`,
      );
      if (el) {
        el.value = (cents[i] / 100).toFixed(2);
        // Fire input so anything watching the field sees the change — a value
        // set by script does not raise one on its own.
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      i += 1;
    }
    setOpen(false);
    setText("");
  }

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center"
      >
        Paste a column from Gusto
      </button>
    );

  return (
    <div className="rounded-lg border border-cc-brand-200 bg-cc-brand-50/40 p-3">
      <label className="block">
        <span className="block text-[11.5px] font-semibold text-ppp-charcoal-700 mb-1">
          Paste the company-cost column, top to bottom, in this order:
        </span>
        <span className="block text-[11px] text-ppp-charcoal-500 mb-2 leading-snug">
          {employeeNames.join(" · ")}
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(10, Math.max(4, employeeNames.length))}
          placeholder={"1,150.00\n1,104.00\n902.00"}
          aria-label="Paste Gusto costs"
          className="w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-[12.5px] font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600"
        />
      </label>

      {text.trim() !== "" && (
        <div className="mt-2 space-y-1">
          <p
            className={`text-[11.5px] ${
              tooMany || short ? "text-amber-800 font-semibold" : "text-ppp-charcoal-600"
            }`}
          >
            {cents.length} figure{cents.length === 1 ? "" : "s"} read for{" "}
            {employeeNames.length} {employeeNames.length === 1 ? "person" : "people"}
            {tooMany
              ? " — more than there are people. The extra ones are ignored; check the order."
              : short
                ? " — the last one(s) will be left blank."
                : ""}
          </p>
          {unreadable.length > 0 && (
            <p className="text-[11.5px] text-rose-700">
              Could not read: {unreadable.slice(0, 4).map((u) => `"${u}"`).join(", ")}
              {unreadable.length > 4 ? ` and ${unreadable.length - 4} more` : ""}. Those rows are
              skipped, which shifts everything after them — fix the paste rather than the boxes.
            </p>
          )}
          {/* What each person will get, before anything is filled in. The
              whole point of pasting over uploading is that she sees the
              pairing while she can still change it. */}
          <ul className="mt-1.5 rounded-lg bg-surface border border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100">
            {employeeNames.map((n, i) => (
              <li key={n} className="flex items-baseline justify-between gap-3 px-2.5 py-1.5">
                <span className="text-[12px] text-ppp-charcoal-700 truncate">{n}</span>
                <span
                  className={`text-[12px] tabular-nums shrink-0 ${
                    i < cents.length ? "text-ppp-charcoal font-semibold" : "text-ppp-charcoal-400"
                  }`}
                >
                  {i < cents.length
                    ? `$${(cents[i] / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={cents.length === 0}
          className={`inline-flex items-center justify-center px-3.5 py-2 rounded-lg text-[12px] font-semibold min-h-[44px] ${
            cents.length === 0
              ? "bg-ppp-charcoal-100 text-ppp-charcoal-400 cursor-not-allowed"
              : "bg-cc-brand-600 text-white hover:bg-cc-brand-700"
          }`}
        >
          Fill the boxes
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setText("");
          }}
          className="text-[11.5px] font-semibold text-ppp-charcoal-500 hover:underline min-h-[44px] inline-flex items-center px-1"
        >
          Cancel
        </button>
        <span className="text-[11px] text-ppp-charcoal-500">
          Nothing is saved until you press Save Gusto costs.
        </span>
      </div>
    </div>
  );
}
