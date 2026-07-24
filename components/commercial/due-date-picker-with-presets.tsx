"use client";

/**
 * Due-date picker with quick-preset buttons above a standard `<input
 * type="date">`. Alex-love (Karan 2026-07-07): GCs pick "Net 30 from
 * today" 90% of the time — a one-tap preset beats scrolling a calendar
 * every single invoice.
 *
 * Presets set the visible date value AND submit as a normal form field
 * so the server action `updateCoreFieldsAction` doesn't need to change.
 * Custom dates via the picker still work (presets are additive UX).
 *
 * ET-safe: preset math uses `new Date()` (local time) then formats via
 * en-CA locale so the resulting YYYY-MM-DD matches what the user "sees"
 * on the wall clock, avoiding UTC off-by-one when the user's local TZ
 * is west of UTC.
 */

import { useState, useEffect } from "react";

const PRESETS: Array<{ key: string; label: string; days: number }> = [
  { key: "today", label: "Today", days: 0 },
  { key: "net15", label: "+15d", days: 15 },
  { key: "net30", label: "+30d", days: 30 },
  { key: "net45", label: "+45d", days: 45 },
];

function toIsoDateLocal(date: Date): string {
  // "en-CA" formats as YYYY-MM-DD in local time — sidesteps UTC
  // off-by-one issues that would happen with .toISOString().slice(0,10).
  return date.toLocaleDateString("en-CA");
}

function endOfMonthIso(): string {
  const now = new Date();
  const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return toIsoDateLocal(eom);
}

export default function DueDatePickerWithPresets({
  id,
  name,
  defaultValue,
  disabled,
}: {
  id: string;
  name: string;
  defaultValue: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<string>(defaultValue);

  // Sync when the server re-renders with a different default (e.g. after
  // saving the form). Without this, users see stale local state on the
  // second edit.
  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  const applyPreset = (days: number) => {
    if (disabled) return;
    const d = new Date();
    d.setDate(d.getDate() + days);
    setValue(toIsoDateLocal(d));
  };

  const applyEndOfMonth = () => {
    if (disabled) return;
    setValue(endOfMonthIso());
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p.days)}
            disabled={disabled}
            className="px-2 py-0.5 text-[11px] font-semibold rounded border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={applyEndOfMonth}
          disabled={disabled}
          className="px-2 py-0.5 text-[11px] font-semibold rounded border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
        >
          EOM
        </button>
      </div>
      <input
        id={id}
        name={name}
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="w-full px-3 py-2 border border-ppp-charcoal-200 rounded-lg text-base sm:text-sm min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 disabled:bg-ppp-charcoal-50 disabled:text-ppp-charcoal-500"
      />
    </div>
  );
}
