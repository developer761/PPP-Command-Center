"use client";

/**
 * DateField — a brand-styled date picker that replaces the ugly native
 * <input type="date"> calendar (Karan 2026-08). Renders a button showing the
 * formatted date + a calendar popover (month grid, brand accent). The chosen
 * value is written to a hidden <input name={name}> as `yyyy-mm-dd`, and a
 * bubbling `change` event is dispatched so it (a) submits with the form and
 * (b) triggers AutosaveForm's change listener exactly like a native input.
 *
 * The stored value is ALWAYS the explicit y-m-d string (never derived from a
 * Date's UTC conversion), so there's no timezone off-by-one.
 */

import { useEffect, useRef, useState } from "react";

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type YMD = { y: number; m: number; d: number };

function parseYmd(s: string | undefined | null): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}
function toYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function fmtDisplay(s: string): string {
  const p = parseYmd(s);
  return p ? `${MONTHS_SHORT[p.m - 1]} ${p.d}, ${p.y}` : "";
}
function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate(); // m is 1-12; day 0 of next month
}
function firstDow(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay(); // 0 (Sun) - 6 (Sat)
}
function todayParts(): YMD {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
}

export function DateField({
  name,
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  min,
  max,
  placeholder = "Select a date",
  disabled = false,
  required = false,
  ariaLabel,
  id,
  className = "",
}: {
  /** Form field name. Omit in controlled mode when the parent renders its own
   *  hidden input. */
  name?: string;
  defaultValue?: string;
  /** Controlled value (yyyy-mm-dd). When set, the parent owns the value + must
   *  render its own hidden input for form submission. */
  value?: string;
  onValueChange?: (next: string) => void;
  /** yyyy-mm-dd — days before this are disabled. */
  min?: string;
  /** yyyy-mm-dd — days after this are disabled. */
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
  id?: string;
  className?: string;
}) {
  const controlled = controlledValue !== undefined;
  const [internal, setInternal] = useState(defaultValue);
  const value = controlled ? controlledValue : internal;
  const [open, setOpen] = useState(false);
  const start = parseYmd(value) ?? parseYmd(min ?? "") ?? todayParts();
  const [view, setView] = useState<{ y: number; m: number }>({ y: start.y, m: start.m });
  const hiddenRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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

  function commit(next: string) {
    if (controlled) {
      onValueChange?.(next);
    } else {
      setInternal(next);
      const el = hiddenRef.current;
      if (el) {
        el.value = next;
        // Bubbling change so the enclosing form (+ AutosaveForm listener) reacts
        // exactly like a native input edit.
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    // Keep the calendar viewing the month it just picked into.
    const p = parseYmd(next);
    if (p) setView({ y: p.y, m: p.m });
    setOpen(false);
  }

  const minP = parseYmd(min ?? "");
  const maxP = parseYmd(max ?? "");
  function beforeMin(y: number, m: number, d: number): boolean {
    const iso = toYmd(y, m, d);
    if (minP && iso < toYmd(minP.y, minP.m, minP.d)) return true;
    if (maxP && iso > toYmd(maxP.y, maxP.m, maxP.d)) return true;
    return false;
  }

  const selP = parseYmd(value);
  const tp = todayParts();
  const dim = daysInMonth(view.y, view.m);
  const lead = firstDow(view.y, view.m);
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: dim }, (_, i) => i + 1),
  ];

  function shiftMonth(delta: number) {
    setView((v) => {
      const idx = (v.m - 1) + delta;
      const y = v.y + Math.floor(idx / 12);
      const m = ((idx % 12) + 12) % 12 + 1;
      return { y, m };
    });
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {/* Form value. Uncontrolled → ref-updated + change-dispatched on commit.
          Controlled WITH a name → a React-controlled hidden input so it still
          submits (parent owns the value). Controlled WITHOUT a name → parent
          renders its own hidden input (e.g. the preset picker). */}
      {controlled
        ? name
          ? <input type="hidden" name={name} value={value} readOnly required={required} />
          : null
        : <input ref={hiddenRef} type="hidden" name={name} defaultValue={defaultValue} required={required} />}
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`w-full flex items-center gap-2 rounded-lg border px-3 py-2 min-h-[44px] text-left text-[13.5px] transition-colors ${
          disabled
            ? "border-ppp-charcoal-100 bg-ppp-charcoal-50 text-ppp-charcoal-400 cursor-not-allowed"
            : open
            ? "border-cc-brand-400 ring-2 ring-cc-brand-100 bg-surface text-ppp-charcoal"
            : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal hover:border-ppp-charcoal-300"
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-cc-brand-600">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4 M8 2v4 M3 10h18" />
        </svg>
        <span className={`flex-1 ${value ? "" : "text-ppp-charcoal-400"}`}>
          {value ? fmtDisplay(value) : placeholder}
        </span>
        {value && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear date"
            onClick={(e) => {
              e.stopPropagation();
              commit("");
            }}
            className="shrink-0 text-ppp-charcoal-400 hover:text-rose-600 leading-none text-[15px] px-0.5"
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute z-40 mt-1 w-[268px] rounded-xl border border-ppp-charcoal-200 bg-surface shadow-xl p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-ppp-charcoal-500 hover:bg-ppp-charcoal-50">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div className="text-[13px] font-bold text-ppp-charcoal tabular-nums">{MONTHS[view.m - 1]} {view.y}</div>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-ppp-charcoal-500 hover:bg-ppp-charcoal-50">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {DOW.map((d) => (
              <div key={d} className="text-center text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-400 py-1">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (d === null) return <div key={`e${i}`} />;
              const isSel = !!selP && selP.y === view.y && selP.m === view.m && selP.d === d;
              const isToday = tp.y === view.y && tp.m === view.m && tp.d === d;
              const isDisabled = beforeMin(view.y, view.m, d);
              return (
                <button
                  key={d}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => commit(toYmd(view.y, view.m, d))}
                  className={`h-9 rounded-lg text-[12.5px] font-semibold tabular-nums transition-colors ${
                    isSel
                      ? "bg-cc-brand-600 text-white"
                      : isDisabled
                      ? "text-ppp-charcoal-300 cursor-not-allowed"
                      : isToday
                      ? "text-cc-brand-700 ring-1 ring-cc-brand-200 hover:bg-cc-brand-50"
                      : "text-ppp-charcoal-700 hover:bg-cc-brand-50"
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-ppp-charcoal-100">
            <button
              type="button"
              onClick={() => {
                const t = todayParts();
                if (!beforeMin(t.y, t.m, t.d)) commit(toYmd(t.y, t.m, t.d));
              }}
              className="text-[11.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 px-1 py-1"
            >
              Today
            </button>
            {value && (
              <button type="button" onClick={() => commit("")} className="text-[11.5px] font-semibold text-ppp-charcoal-500 hover:text-rose-600 px-1 py-1">
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
