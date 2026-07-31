"use client";

/**
 * ProgressMeter — the ONE progress bar for the Commercial platform.
 *
 * Replaces the scattered thin flat bars (and the off-brand indigo payment bar)
 * with a single clean, on-brand meter: rounded track with subtle depth, a
 * gradient fill in the chosen tone, a smooth mount-grow, and a soft leading-edge
 * glow. Theme-aware (light/dark). No busy infinite sheen — calm and premium.
 *
 * Give it either `pct` (0–100) or `value` + `max`. Tone is explicit so callers
 * own the semantics (brand = in progress, emerald = complete/collected, amber =
 * attention/partial, rose = overdue/over, navy = neutral contract).
 */

import { useEffect, useState } from "react";

export type MeterTone = "blue" | "brand" | "emerald" | "amber" | "rose" | "navy";

const TONE: Record<MeterTone, { a: string; b: string; glow: string; text: string }> = {
  // Blue (#2BAAE1) — the platform's in-progress tone (Karan: blue reads better
  // than orange, and nothing on a bar should be red).
  blue: { a: "var(--cc-m-blue-a)", b: "var(--cc-m-blue-b)", glow: "var(--cc-m-blue-b)", text: "text-ppp-blue-700" },
  brand: { a: "var(--cc-m-brand-a)", b: "var(--cc-m-brand-b)", glow: "var(--cc-m-brand-b)", text: "text-cc-brand-700" },
  emerald: { a: "var(--cc-m-emerald-a)", b: "var(--cc-m-emerald-b)", glow: "var(--cc-m-emerald-b)", text: "text-emerald-700" },
  amber: { a: "var(--cc-m-amber-a)", b: "var(--cc-m-amber-b)", glow: "var(--cc-m-amber-b)", text: "text-amber-700" },
  rose: { a: "var(--cc-m-rose-a)", b: "var(--cc-m-rose-b)", glow: "var(--cc-m-rose-b)", text: "text-rose-700" },
  navy: { a: "var(--cc-m-navy-a)", b: "var(--cc-m-navy-b)", glow: "var(--cc-m-navy-b)", text: "text-ppp-navy-700" },
};

export function ProgressMeter({
  pct,
  value,
  max,
  tone = "brand",
  label,
  rightLabel,
  amounts,
  size = "md",
  note,
  className = "",
}: {
  pct?: number;
  value?: number;
  max?: number;
  tone?: MeterTone;
  /** Small-caps label on the left of the top row. */
  label?: string;
  /** Right of the top row (e.g. "62%"). Defaults to the computed percent. */
  rightLabel?: string;
  /** "$X of $Y" amounts shown under/next to the label. */
  amounts?: { done: string; total: string } | null;
  size?: "sm" | "md";
  note?: string | null;
  className?: string;
}) {
  const computed = pct != null ? pct : max && max > 0 ? (value ?? 0) / max * 100 : 0;
  const clamped = Math.max(0, Math.min(100, Math.round(computed)));
  const t = TONE[tone];

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const width = mounted ? clamped : 0;

  const h = size === "sm" ? "h-2" : "h-2.5";
  const showTopRow = label || rightLabel || amounts;

  return (
    <div className={className}>
      {showTopRow && (
        <div className="flex items-end justify-between gap-2 mb-1.5 flex-wrap">
          <div className="min-w-0">
            {label && <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ppp-charcoal-500">{label}</div>}
            {amounts && (
              <div className="text-[11px] text-ppp-charcoal-600 tabular-nums leading-tight">
                <strong className={t.text}>{amounts.done}</strong>
                <span className="text-ppp-charcoal-400"> of {amounts.total}</span>
              </div>
            )}
          </div>
          <div className={`text-[12px] font-bold tabular-nums shrink-0 ${t.text}`}>{rightLabel ?? `${clamped}%`}</div>
        </div>
      )}

      <div
        className={`relative ${h} w-full rounded-full overflow-hidden bg-ppp-charcoal-100`}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ? `${label}: ${clamped}%` : `${clamped}%`}
      >
        <div className="absolute inset-0 rounded-full shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]" aria-hidden />
        <div
          className="relative h-full rounded-full will-change-[width]"
          style={{
            width: `${width}%`,
            background: `linear-gradient(90deg, ${t.a}, ${t.b})`,
            transition: "width 900ms cubic-bezier(.22,1,.36,1)",
            boxShadow: width > 0 ? `0 0 8px -1px ${t.glow}` : "none",
          }}
        >
          {width > 4 && width < 100 && (
            <span
              className="absolute right-0 top-1/2 -translate-y-1/2 h-full w-1 rounded-full"
              style={{ background: t.glow, boxShadow: `0 0 6px 1px ${t.glow}`, opacity: 0.85 }}
              aria-hidden
            />
          )}
        </div>
      </div>

      {note && <div className="mt-1.5 text-[10.5px] text-ppp-charcoal-500">{note}</div>}

      <style>{`
        :root {
          --cc-m-blue-a: #5bc0ea; --cc-m-blue-b: #2baae1;
          --cc-m-brand-a: #f2814e; --cc-m-brand-b: #ee662e;
          --cc-m-emerald-a: #34d399; --cc-m-emerald-b: #10b981;
          --cc-m-amber-a: #fbbf24; --cc-m-amber-b: #f59e0b;
          --cc-m-rose-a: #fb7185; --cc-m-rose-b: #f43f5e;
          --cc-m-navy-a: #3b5b95; --cc-m-navy-b: #172b4d;
        }
        :root[data-theme="dark"] {
          --cc-m-blue-a: #2baae1; --cc-m-blue-b: #5bc0ea;
          --cc-m-brand-a: #ee662e; --cc-m-brand-b: #f2814e;
          --cc-m-emerald-a: #10b981; --cc-m-emerald-b: #34d399;
          --cc-m-amber-a: #f59e0b; --cc-m-amber-b: #fbbf24;
          --cc-m-rose-a: #f43f5e; --cc-m-rose-b: #fb7185;
          --cc-m-navy-a: #2b4573; --cc-m-navy-b: #5b7bb5;
        }
      `}</style>
    </div>
  );
}

export default ProgressMeter;
