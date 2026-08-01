"use client";

/**
 * Commercial chart kit — lightweight, dependency-free SVG viz that reads the
 * brand CSS color tokens (so it's automatically light/dark-mode correct, same
 * as TrendChart). Interactive: donut segments + bars highlight on hover and the
 * donut center flips to whatever you point at.
 *
 *   GaugeRing   — one percentage as a 270° arc + center value (win rate, % billed)
 *   DonutChart  — a money/count mix as a ring + legend; hover a segment/legend row
 *                 → it pops, the others dim, and the center shows that slice
 *   HBars       — labeled horizontal comparison bars (per-project billing, mix)
 *   MiniBars    — a tiny sparkline for KPI tiles
 *   StatCard    — a KPI tile with an embedded sparkline + delta chip
 */
import Link from "next/link";
import { useState, type ReactNode } from "react";

export type ChartTone = "blue" | "brand" | "emerald" | "amber" | "rose" | "navy" | "neutral";

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
  pct: number;
  tone?: ChartTone;
  size?: number;
  thickness?: number;
  value?: ReactNode;
  label?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="w-full h-full" role="img" aria-label={typeof label === "string" ? `${label}: ${clamped}%` : `${clamped}%`}>
        <circle cx="50" cy="50" r="42" fill="none" stroke={TRACK} strokeWidth={thickness} pathLength={100} strokeDasharray="75 100" strokeLinecap="round" transform="rotate(135 50 50)" />
        <circle cx="50" cy="50" r="42" fill="none" stroke={toneVar(tone)} strokeWidth={thickness} pathLength={100} strokeDasharray={`${(clamped / 100) * 75} 100`} strokeLinecap="round" transform="rotate(135 50 50)" style={{ transition: "stroke-dasharray .5s ease" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
        <div className="font-condensed text-xl sm:text-2xl font-black leading-none tabular-nums text-ppp-charcoal">{value ?? `${Math.round(clamped)}%`}</div>
        {label && <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mt-0.5 leading-tight">{label}</div>}
      </div>
    </div>
  );
}

// ─────────────────────────── DonutChart (interactive) ───────────────────────────

export type DonutSegment = { label: string; value: number; tone: ChartTone; valueLabel?: string };

export function DonutChart({
  segments,
  size = 148,
  thickness = 16,
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
  const [hover, setHover] = useState<number | null>(null);
  const clean = segments.map((s) => ({ ...s, value: Math.max(0, Number.isFinite(s.value) ? s.value : 0) }));
  const total = clean.reduce((acc, s) => acc + s.value, 0);
  let offset = 0;
  const active = hover !== null ? clean[hover] : null;

  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90" role="img" aria-label="Breakdown chart">
          <circle cx="50" cy="50" r="42" fill="none" stroke={TRACK} strokeWidth={thickness} pathLength={100} />
          {total > 0 &&
            clean.map((seg, i) => {
              const frac = (seg.value / total) * 100;
              if (frac <= 0) return null;
              const isHover = hover === i;
              const dimmed = hover !== null && !isHover;
              const el = (
                <circle
                  key={i}
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke={toneVar(seg.tone)}
                  strokeWidth={isHover ? thickness + 4 : thickness}
                  pathLength={100}
                  strokeDasharray={`${frac} ${100 - frac}`}
                  strokeDashoffset={-offset}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity .15s, stroke-width .15s", cursor: "pointer" }}
                >
                  <title>{`${seg.label}: ${seg.valueLabel ?? `${Math.round(frac)}%`}`}</title>
                </circle>
              );
              offset += frac;
              return el;
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center pointer-events-none">
          {active ? (
            <>
              <div className="font-condensed text-base sm:text-lg font-black leading-none tabular-nums" style={{ color: toneVar(active.tone) }}>{active.valueLabel ?? `${total > 0 ? Math.round((active.value / total) * 100) : 0}%`}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mt-0.5 leading-tight max-w-[76px]">{active.label}</div>
            </>
          ) : (
            <>
              {centerValue && <div className="font-condensed text-lg sm:text-xl font-black leading-none tabular-nums text-ppp-charcoal">{centerValue}</div>}
              {centerLabel && <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mt-0.5">{centerLabel}</div>}
            </>
          )}
        </div>
      </div>
      {legend && (
        <ul className="min-w-0 space-y-1.5">
          {clean.map((seg, i) => (
            <li
              key={i}
              className="flex items-center gap-2 text-[11.5px] rounded px-1 -mx-1 cursor-default"
              style={{ backgroundColor: hover === i ? "var(--color-ppp-charcoal-50)" : "transparent" }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: toneVar(seg.tone) }} />
              <span className="text-ppp-charcoal-600 truncate">{seg.label}</span>
              <span className="ml-auto font-bold tabular-nums text-ppp-charcoal">{seg.valueLabel ?? `${total > 0 ? Math.round((seg.value / total) * 100) : 0}%`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────── HBars (comparison) ───────────────────────────

export type HBarItem = { label: string; value: number; tone?: ChartTone; valueLabel?: string; sub?: string; href?: string };

export function HBars({ items, max }: { items: HBarItem[]; max?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const hi = max ?? Math.max(1, ...items.map((i) => Math.max(0, i.value)));
  return (
    <ul className="space-y-2.5">
      {items.map((it, i) => {
        const pct = Math.max(2, Math.min(100, (Math.max(0, it.value) / hi) * 100));
        const tone = it.tone ?? "blue";
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className="text-[12px] font-medium text-ppp-charcoal truncate">{it.label}</span>
              <span className="text-[12px] font-bold tabular-nums text-ppp-charcoal shrink-0">{it.valueLabel ?? it.value}</span>
            </div>
            <div className="h-2.5 rounded-full overflow-hidden" style={{ backgroundColor: TRACK }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: toneVar(tone), opacity: hover !== null && hover !== i ? 0.5 : 1, transition: "width .5s ease, opacity .15s" }} />
            </div>
            {it.sub && <div className="text-[10.5px] text-ppp-charcoal-400 mt-0.5">{it.sub}</div>}
          </>
        );
        return (
          <li key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            {it.href ? <Link href={it.href} className="block rounded-lg -mx-1 px-1 py-0.5 hover:bg-ppp-charcoal-50/60 transition-colors">{row}</Link> : row}
          </li>
        );
      })}
    </ul>
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
            className="flex-1 rounded-[1px] min-w-[2px] transition-opacity hover:opacity-100"
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
  spark?: number[];
  sparkLabels?: string[];
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
