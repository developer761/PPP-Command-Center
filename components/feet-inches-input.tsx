"use client";

/**
 * Enter a length the way a tape measure reads it.
 *
 * Every length field in the measure tool used to be a single decimal-feet box.
 * That asks a painter holding a tape at 12′ 7″ to work out 12.58 in their head,
 * on a phone, in someone's house — and to do it right, because 12.7 is a
 * different room. It is the kind of small friction that decides whether a tool
 * gets used at all.
 *
 * Two boxes, both numeric keypads, both optional. Feet alone works. Inches
 * alone works. The conversion happens here so nothing downstream has to care —
 * the geometry stays in decimal feet, which is what the maths wants.
 */

export type FeetInchesValue = { feet: string; inches: string };

export const EMPTY_FT_IN: FeetInchesValue = { feet: "", inches: "" };

/** Decimal feet, or 0 when nothing usable was entered. */
export function toDecimalFeet(v: FeetInchesValue): number {
  const ft = parseFloat(v.feet) || 0;
  const inch = parseFloat(v.inches) || 0;
  if (ft < 0 || inch < 0) return 0;
  const total = ft + inch / 12;
  return Number.isFinite(total) && total > 0 ? Math.round(total * 1000) / 1000 : 0;
}

/** Decimal feet back into boxes — for pre-filling from a saved measurement. */
export function fromDecimalFeet(decimal: number | null | undefined): FeetInchesValue {
  if (!decimal || !Number.isFinite(decimal) || decimal <= 0) return EMPTY_FT_IN;
  const ft = Math.floor(decimal);
  const inch = Math.round((decimal - ft) * 12);
  // 11.6″ rounds to 12″ — carry it rather than showing 12′ 12″.
  if (inch === 12) return { feet: String(ft + 1), inches: "" };
  // Under a foot, leave the feet box empty rather than showing a bare "0" —
  // a zero reads like a value that was entered on purpose.
  return { feet: ft ? String(ft) : "", inches: inch ? String(inch) : "" };
}

/** "12′ 7″" — how a painter says it back. */
export function formatFtIn(v: FeetInchesValue): string {
  const ft = parseFloat(v.feet) || 0;
  const inch = parseFloat(v.inches) || 0;
  if (!ft && !inch) return "";
  if (!inch) return `${ft}′`;
  if (!ft) return `${inch}″`;
  return `${ft}′ ${inch}″`;
}

export default function FeetInchesInput({
  value, onChange, label, autoFocus, onEnter, compact, placeholderFeet,
}: {
  value: FeetInchesValue;
  onChange: (v: FeetInchesValue) => void;
  label: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  /** Tighter styling for a row of several. */
  compact?: boolean;
  /** Typical value shown greyed, e.g. "8" for a ceiling. */
  placeholderFeet?: string;
}) {
  const box =
    "w-full px-2.5 py-3 text-base border border-ppp-charcoal-200 rounded-lg " +
    "focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue " +
    // text-base (16px) is load-bearing: anything smaller makes iOS Safari zoom
    // the page on focus, and the crew then has to pinch back out mid-entry.
    "min-h-[48px] text-center";

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); }
  };

  return (
    <div className={compact ? "flex-1 min-w-[104px]" : "flex-1"}>
      <span className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1">
        {label}
      </span>
      <div className="flex items-stretch gap-1">
        <label className="flex-1 relative">
          <span className="sr-only">{label} — feet</span>
          <input
            type="number" inputMode="numeric" step="1" min="0"
            value={value.feet}
            autoFocus={autoFocus}
            onChange={(e) => onChange({ ...value, feet: e.target.value })}
            onKeyDown={key}
            placeholder={placeholderFeet ?? "0"}
            className={box}
            aria-label={`${label} in feet`}
          />
          <span aria-hidden className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] text-ppp-charcoal-400 pointer-events-none">
            ft
          </span>
        </label>
        <label className="flex-1 relative">
          <span className="sr-only">{label} — inches</span>
          <input
            // inputMode numeric, not decimal: inches are whole numbers on a
            // tape, and the decimal pad puts a "." where a painter wants a digit.
            type="number" inputMode="numeric" step="1" min="0" max="11"
            value={value.inches}
            onChange={(e) => onChange({ ...value, inches: e.target.value })}
            onKeyDown={key}
            placeholder="0"
            className={box}
            aria-label={`${label} in inches`}
          />
          <span aria-hidden className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] text-ppp-charcoal-400 pointer-events-none">
            in
          </span>
        </label>
      </div>
    </div>
  );
}
