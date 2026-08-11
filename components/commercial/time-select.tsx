"use client";

/**
 * Friendly time picker for scheduling — replaces the native `<input type="time">`
 * whose HH / MM / AM-PM spinner Karan found "weird and annoying" (2026-08).
 *
 * Built on SearchableSelect so it's consistent with the Crew / Work-order pickers
 * it sits next to: click to open a list of times, or type "7", "730", "3 pm" to
 * jump. 15-minute increments across the full day.
 *
 * - `value` submitted to FormData is 24-hour "HH:MM" (exactly what the schedule
 *   API + DB `time` column expect) — so it drops into the existing form with no
 *   server change.
 * - `label` shown to the user is 12-hour ("7:00 AM").
 * - Leaving it blank is valid (the schedule form treats blank start+end as a
 *   full 8h day) — the × clear button restores blank.
 */

import { SearchableSelect } from "./searchable-select";

// 15-minute increments, 12:00 AM → 11:45 PM. value = "HH:MM" (24h), label = 12h.
// Extra searchable aliases in `hint` so typing "730" or "3pm" also finds it.
const TIME_OPTIONS = (() => {
  const opts: { value: string; label: string; hint?: string }[] = [];
  for (let m = 0; m < 24 * 60; m += 15) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const hh = String(h).padStart(2, "0");
    const mm = String(min).padStart(2, "0");
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    // Aliases people type: "730", "7 30", "7:30", "730am", "7am"
    const compact = `${h12}${mm}`;
    const hint = `${compact} ${h12}${mm}${ampm.toLowerCase()} ${h12}${ampm.toLowerCase()} ${hh}${mm}`;
    opts.push({ value: `${hh}:${mm}`, label: `${h12}:${mm} ${ampm}`, hint });
  }
  return opts;
})();

/** Normalize a stored time (e.g. "07:00:00" from a Postgres time column) to the
 *  "HH:MM" key TIME_OPTIONS uses, so a pre-filled edit value matches an option. */
function toHHMM(v: string): string {
  const m = v.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : v;
}

export function TimeSelect({
  name,
  defaultValue = "",
  ariaLabel,
  placeholder = "Pick a time…",
}: {
  name: string;
  defaultValue?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  return (
    <SearchableSelect
      name={name}
      options={TIME_OPTIONS}
      defaultValue={defaultValue ? toHHMM(defaultValue) : ""}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      emptyMessage="No match — try 7, 730, or 3pm."
    />
  );
}
