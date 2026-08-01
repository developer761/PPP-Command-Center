/**
 * Commercial chart kit — lightweight, dependency-free SVG viz that reads the
 * brand CSS color tokens (so it's automatically light/dark-mode correct, same
 * as TrendChart). Pure components (no hooks) → render on the server; native
 * <title> tooltips keep them interactive without client JS.
 *
 *   GaugeRing   — one percentage as a 270° arc + center value (win rate, % billed)
 *   DonutChart  — a money/count mix as a ring + legend (Invoiced/Paid/Outstanding)
 *   MiniBars    — a tiny sparkline for KPI tiles (monthly trend at a glance)
 *   StatCard    — a KPI tile that optionally embeds a MiniBars sparkline + delta
 */
import Link from "next/link";
import type { ReactNode } from "react";

export type ChartTone = "blue" | "brand" | "emerald" | "amber" | "rose" | "navy" | "neutral";

/** Brand CSS-var stroke/fill per tone (light + dark safe — the token flips). */
export function toneVar(tone: ChartTone): string {
  switch (tone) {
    case "blue": return "var(--color-ppp-blue-500)";
    case "brand": return "var(--color-cc-brand-500)";
    case "emerald": return "var(--color-emerald-500)";
    case "amber": return "var(--color-amber-500)";
    case "rose": return "var(--color-rose-500)";
    case "navy": return "var(--color-ppp-navy-500)";
    default: return "var(--color-ppp-charcoal-300)";
  }
}

const TRACK = "var(--color-ppp-charcoal-100)";

// ─────────────────────────── GaugeRing ───────────────────────────

export function GaugeRing({
  pct,
  tone = "emerald",
  size = 108,
  thickness = 9,
  value,
  label,
}: {
  /** 0–100. Clamped. */
  pct: number;
  tone?: ChartTone;
  size?: number;
  thickness?: number;
  /** Big center text (defaults to `${pct}%`). */
  value?: ReactNode;
  /** Small caption under the value. */
  label?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  // 270° arc: 75% of the circle, gap centered at the bottom (rotate 135°).
  return (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="w-full h-full" role="img" aria-label={typeof label === "string" ? `${label}: ${clamped}%` : `${clamped}%`}>
        <circle cx="50" cy="50" r="42" fill="none" stroke={TRACK} strokeWidth={thickness} pathLength={100} strokeDasharray="75 100" strokeLinecap="round" transform="rotate(135 50 50)" />
        <circle cx="50" cy="50" r="42" fill="none" stroke={toneVar(tone)} strokeWidth={thickness} pathLength={100} strokeDasharray={`${(clamped / 100) * 75} 100`} strokeLinecap="round" transform="rotate(135 50 50)" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
        <div className="font-condensed text-xl sm:text-2xl font-black leading-none tabular-nums text-ppp-charcoal">{value ?? `${Math.round(clamped)}%`}</div>
        {label && <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mt-0.5 leading-tight">{label}</div>}
      </div>
    </div>
  );
}

// ─────────────────────────── DonutChart ───────────────────────────

export type DonutSegment = { label: string; value: number; tone: ChartTone };

export function DonutChart({
  segments,
  size = 132,
  thickness = 13,
  centerValue,
  centerLabel,
  legend = true,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerValue?: ReactNode;
  centerLabel?: ReactNode;
  legend?: boolean;
}) {
  const clean = segments.map((s) => ({ ...s, value: Math.max(0, Number.isFinite(s.value) ? s.value : 0) }));
  const total = clean.reduce((acc, s) => acc + s.value, 0);
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90" role="img" aria-label="Breakdown chart">
          <circle cx="50" cy="50" r="42" fill="none" stroke={TRACK} strokeWidth={thickness} pathLength={100} />
          {total > 0 &&
            clean.map((seg, i) => {
              const frac = (seg.value / total) * 100;
              if (frac <= 0) return null;
              const el = (
                <circle
                  key={i}
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke={toneVar(seg.tone)}
                  strokeWidth={thickness}
                  pathLength={100}
                  strokeDasharray={`${frac} ${100 - frac}`}
                  strokeDashoffset={-offset}
                >
                  <title>{`${seg.label}: ${Math.round(frac)}%`}</title>
                </circle>
              );
              offset += frac;
              return el;
            })}
        </svg>
        {(centerValue || centerLabel) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
            {centerValue && <div className="font-condensed text-lg sm:text-xl font-black leading-none tabular-nums text-ppp-charcoal">{centerValue}</div>}
            {centerLabel && <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mt-0.5">{centerLabel}</div>}
          </div>
        )}
      </div>
      {legend && (
        <ul className="min-w-0 space-y-1.5">
          {clean.map((seg, i) => (
            <li key={i} className="flex items-center gap-2 text-[11.5px]">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: toneVar(seg.tone) }} />
              <span className="text-ppp-charcoal-600 truncate">{seg.label}</span>
              <span className="ml-auto font-bold tabular-nums text-ppp-charcoal">{total > 0 ? Math.round((seg.value / total) * 100) : 0}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────── MiniBars (sparkline) ───────────────────────────

export function MiniBars({
  values,
  tone = "blue",
  className = "",
  labels,
}: {
  values: number[];
  tone?: ChartTone;
  className?: string;
  /** Optional per-bar hover title (e.g. month names). */
  labels?: string[];
}) {
  const max = Math.max(1, ...values.map((v) => (Number.isFinite(v) ? v : 0)));
  return (
    <div className={`flex items-end gap-0.5 ${className}`} aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(6, (Math.max(0, v) / max) * 100);
        const last = i === values.length - 1;
        return (
          <div
            key={i}
            className="flex-1 rounded-[1px] min-w-[2px]"
            style={{ height: `${h}%`, backgroundColor: toneVar(tone), opacity: last ? 1 : 0.45 }}
            title={labels?.[i]}
          />
        );
      })}
    </div>
  );
}

// ─────────────────────────── StatCard (KPI + sparkline) ───────────────────────────

export function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
  spark,
  sparkLabels,
  delta,
  href,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: ChartTone;
  /** Optional monthly sparkline series. */
  spark?: number[];
  sparkLabels?: string[];
  /** Optional signed delta chip (e.g. +3 vs last month). */
  delta?: { value: number; suffix?: string } | null;
  href?: string;
  icon?: ReactNode;
}) {
  const valueCls =
    tone === "emerald" ? "text-emerald-700"
    : tone === "rose" ? "text-rose-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "blue" ? "text-ppp-blue-700"
    : tone === "brand" ? "text-cc-brand-700"
    : tone === "navy" ? "text-ppp-navy-700"
    : "text-ppp-charcoal";
  const accent =
    tone === "emerald" ? "bg-emerald-500"
    : tone === "rose" ? "bg-rose-500"
    : tone === "amber" ? "bg-amber-500"
    : tone === "blue" ? "bg-ppp-blue-500"
    : tone === "brand" ? "bg-cc-brand-500"
    : tone === "navy" ? "bg-ppp-navy-500"
    : "bg-ppp-charcoal-300";

  const inner = (
    <>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${accent}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
        {icon && <span aria-hidden className="text-ppp-charcoal-300 shrink-0">{icon}</span>}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className={`font-condensed text-2xl sm:text-3xl font-black leading-none tracking-tight tabular-nums ${valueCls}`}>{value}</div>
        {spark && spark.length > 1 && <MiniBars values={spark} tone={tone === "neutral" ? "blue" : tone} labels={sparkLabels} className="h-7 w-16 sm:w-20 shrink-0" />}
      </div>
      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
        {sub && <div className="text-[11px] text-ppp-charcoal-500 leading-snug">{sub}</div>}
        {delta && delta.value !== 0 && (
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${delta.value > 0 ? "text-emerald-700" : "text-ppp-charcoal-400"}`}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={delta.value > 0 ? "" : "rotate-180"}><path d="M12 19V5 M5 12l7-7 7 7" /></svg>
            {delta.value > 0 ? "+" : ""}{delta.value}{delta.suffix ?? ""}
          </span>
        )}
      </div>
    </>
  );

  const cls = "relative block bg-surface border border-ppp-charcoal-100 rounded-xl pl-4 pr-3.5 py-3 overflow-hidden";
  return href ? (
    <Link href={href} className={`${cls} transition-all hover:shadow-md hover:border-ppp-charcoal-200 touch-manipulation`}>{inner}</Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
