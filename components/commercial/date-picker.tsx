"use client";

/**
 * Karan 2026-07-09: custom calendar popover so every date field on the
 * platform looks the same. Native <input type="date"> paints an OS-
 * specific popup (ugly on Safari, garish on Firefox, inconsistent
 * across browsers). This component owns the popup + trigger + hidden
 * form value, so `name={foo}` still submits through a normal <form>.
 *
 * Not a wrapper around a library — vanilla Date math + Tailwind. Kept
 * intentionally small so it's easy to reason about.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { INPUT_CLS } from "@/lib/commercial/form-classnames";

type Props = {
  name: string;
  defaultValue?: string; // YYYY-MM-DD
  required?: boolean;
  disabled?: boolean;
  min?: string; // YYYY-MM-DD
  max?: string; // YYYY-MM-DD
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
};

const WEEKDAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toIsoLocal(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

function parseIso(s: string | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtDisplay(s: string | undefined): string {
  const d = parseIso(s);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function DatePicker({
  name,
  defaultValue,
  required,
  disabled,
  min,
  max,
  placeholder = "Pick a date",
  id,
  ariaLabel,
}: Props) {
  const [value, setValue] = useState<string>(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date>(() => parseIso(defaultValue) ?? new Date());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const grid = useMemo(() => {
    const y = viewMonth.getFullYear();
    const m = viewMonth.getMonth();
    const first = new Date(y, m, 1);
    const startPad = first.getDay(); // 0 = Sunday
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells: Array<{ date: Date; inMonth: boolean }> = [];
    // Previous month tail
    for (let i = startPad; i > 0; i--) {
      const d = new Date(y, m, 1 - i);
      cells.push({ date: d, inMonth: false });
    }
    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(y, m, d), inMonth: true });
    }
    // Next month head — pad to 6 weeks (42) so the popup height is stable
    while (cells.length < 42) {
      const last = cells[cells.length - 1].date;
      cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), inMonth: false });
    }
    return cells;
  }, [viewMonth]);

  const todayIso = toIsoLocal(new Date());
  const minDate = parseIso(min);
  const maxDate = parseIso(max);

  function isDisabled(d: Date): boolean {
    if (minDate && d < minDate) return true;
    if (maxDate && d > maxDate) return true;
    return false;
  }

  function pick(d: Date) {
    if (isDisabled(d)) return;
    setValue(toIsoLocal(d));
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value} required={required} />
      <button
        type="button"
        id={id}
        aria-label={ariaLabel ?? "Choose a date"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${INPUT_CLS} flex items-center justify-between text-left cursor-pointer ${value ? "text-ppp-charcoal" : "text-ppp-charcoal-400"} ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
      >
        <span>{value ? fmtDisplay(value) : placeholder}</span>
        <span aria-hidden className="ml-2 text-ppp-charcoal-400">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </span>
      </button>
      {value && !required && !disabled && (
        <button
          type="button"
          aria-label="Clear date"
          onClick={() => setValue("")}
          className="absolute right-10 top-1/2 -translate-y-1/2 p-1 text-ppp-charcoal-400 hover:text-ppp-charcoal-700"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18 M6 6l12 12" />
          </svg>
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-label="Date picker"
          className="absolute z-50 mt-2 w-[288px] max-w-[92vw] bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setViewMonth((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
              className="h-11 w-11 flex items-center justify-center rounded-md hover:bg-ppp-charcoal-50 text-ppp-charcoal-600 touch-manipulation"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="text-sm font-semibold text-ppp-charcoal">
              {MONTH_NAMES[viewMonth.getMonth()]} {viewMonth.getFullYear()}
            </div>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setViewMonth((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
              className="h-11 w-11 flex items-center justify-center rounded-md hover:bg-ppp-charcoal-50 text-ppp-charcoal-600 touch-manipulation"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0 mb-1">
            {WEEKDAY_HEADERS.map((d, i) => (
              <div key={i} className="text-[10px] font-semibold text-ppp-charcoal-400 text-center py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((cell, i) => {
              const iso = toIsoLocal(cell.date);
              const isSelected = iso === value;
              const isToday = iso === todayIso;
              const dis = isDisabled(cell.date);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={dis}
                  onClick={() => pick(cell.date)}
                  className={[
                    "h-11 sm:h-10 rounded-md text-[13px] transition-colors touch-manipulation",
                    !cell.inMonth ? "text-ppp-charcoal-300" : "text-ppp-charcoal-700",
                    isSelected ? "bg-cc-brand-600 text-white font-semibold hover:bg-cc-brand-700" : "hover:bg-cc-brand-50",
                    isToday && !isSelected ? "ring-1 ring-cc-brand-400 font-semibold" : "",
                    dis ? "opacity-30 cursor-not-allowed hover:bg-transparent" : "",
                  ].join(" ")}
                >
                  {cell.date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-2 pt-2 border-t border-ppp-charcoal-100 flex items-center justify-between">
            <button
              type="button"
              onClick={() => pick(new Date())}
              disabled={isDisabled(new Date())}
              className="text-[12px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed disabled:hover:text-ppp-charcoal-300"
            >
              Today
            </button>
            {value && (
              <button
                type="button"
                onClick={() => { setValue(""); setOpen(false); }}
                className="text-[12px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal-800"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
