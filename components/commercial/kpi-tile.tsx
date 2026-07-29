/**
 * Shared commercial KPI tile (2026-07-28) — ONE primitive for every KPI strip
 * across the Commercial Command Center, so dashboard / Projects / Submittals /
 * Account 360 all read identically. Number-first (condensed-black, tabular),
 * semantic left stripe, optional icon, optional drill-down link.
 *
 * Tone rules (design system): cc-brand crimson = ACTION only → tone "action",
 * used sparingly. Status/metric KPIs use neutral / blue / emerald / amber /
 * rose / navy.
 */
import Link from "next/link";
import type { ReactNode } from "react";

export type KpiTone = "neutral" | "blue" | "emerald" | "amber" | "rose" | "navy" | "action";

const TONE: Record<KpiTone, { ring: string; stripe: string; glow: string; icon: string }> = {
  neutral: {
    ring: "border-ppp-charcoal-100 bg-white hover:border-ppp-charcoal-300",
    stripe: "bg-ppp-charcoal-300",
    glow: "bg-ppp-charcoal-100/50",
    icon: "bg-gradient-to-br from-ppp-charcoal-100 to-ppp-charcoal-50 text-ppp-charcoal-600 group-hover/kpi:from-ppp-charcoal-500 group-hover/kpi:to-ppp-charcoal-400 group-hover/kpi:text-white",
  },
  blue: {
    ring: "border-ppp-blue-100/70 bg-white hover:border-ppp-blue-300",
    stripe: "bg-gradient-to-b from-ppp-blue-600 via-ppp-blue-500 to-ppp-blue-400",
    glow: "bg-ppp-blue-100/50",
    icon: "bg-gradient-to-br from-ppp-blue-100 to-ppp-blue-50 text-ppp-blue-700 group-hover/kpi:from-ppp-blue-600 group-hover/kpi:to-ppp-blue-500 group-hover/kpi:text-white",
  },
  emerald: {
    ring: "border-emerald-100/70 bg-white hover:border-emerald-300",
    stripe: "bg-gradient-to-b from-emerald-600 via-emerald-500 to-emerald-400",
    glow: "bg-emerald-100/60",
    icon: "bg-gradient-to-br from-emerald-100 to-emerald-50 text-emerald-700 group-hover/kpi:from-emerald-600 group-hover/kpi:to-emerald-500 group-hover/kpi:text-white",
  },
  amber: {
    ring: "border-amber-100/70 bg-white hover:border-amber-300",
    stripe: "bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300",
    glow: "bg-amber-100/60",
    icon: "bg-gradient-to-br from-amber-100 to-amber-50 text-amber-700 group-hover/kpi:from-amber-500 group-hover/kpi:to-amber-400 group-hover/kpi:text-white",
  },
  rose: {
    ring: "border-rose-100/70 bg-white hover:border-rose-300",
    stripe: "bg-gradient-to-b from-rose-600 via-rose-500 to-rose-400",
    glow: "bg-rose-100/60",
    icon: "bg-gradient-to-br from-rose-100 to-rose-50 text-rose-700 group-hover/kpi:from-rose-600 group-hover/kpi:to-rose-500 group-hover/kpi:text-white",
  },
  navy: {
    ring: "border-ppp-navy-100/70 bg-white hover:border-ppp-navy-300",
    stripe: "bg-gradient-to-b from-ppp-navy-600 via-ppp-navy-500 to-ppp-navy-400",
    glow: "bg-ppp-navy-100/50",
    icon: "bg-gradient-to-br from-ppp-navy-100 to-ppp-navy-50 text-ppp-navy-700 group-hover/kpi:from-ppp-navy-600 group-hover/kpi:to-ppp-navy-500 group-hover/kpi:text-white",
  },
  action: {
    ring: "border-cc-brand-100/70 bg-white hover:border-cc-brand-300",
    stripe: "bg-gradient-to-b from-cc-brand-600 via-cc-brand-500 to-cc-brand-400",
    glow: "bg-cc-brand-100/60",
    icon: "bg-gradient-to-br from-cc-brand-100 to-cc-brand-50 text-cc-brand-700 group-hover/kpi:from-cc-brand-600 group-hover/kpi:to-cc-brand-500 group-hover/kpi:text-white",
  },
};

export function KpiTile({
  label,
  value,
  sub,
  tone = "neutral",
  href,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
  href?: string;
  icon?: ReactNode;
}) {
  const t = TONE[tone];
  const shell = `group/kpi relative block border rounded-xl px-4 py-4 overflow-hidden shadow-sm transition-all ${
    href ? "hover:shadow-lg hover:-translate-y-0.5 touch-manipulation" : ""
  } ${t.ring}`;
  const inner = (
    <>
      <span aria-hidden className={`pointer-events-none absolute -top-10 -right-10 w-28 h-28 rounded-full blur-2xl opacity-80 ${t.glow}`} />
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${t.stripe}`} />
      <div className="relative pl-1">
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-500 leading-tight">{label}</span>
          {icon && (
            <span aria-hidden className={`inline-flex items-center justify-center h-9 w-9 rounded-xl shadow-sm transition-all group-hover/kpi:shadow-md shrink-0 ${t.icon}`}>
              {icon}
            </span>
          )}
        </div>
        <div className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal leading-none tracking-tight tabular-nums">{value}</div>
        {sub && <div className="mt-1.5 text-[11px] text-ppp-charcoal-500 leading-snug">{sub}</div>}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className={shell}>{inner}</Link>
  ) : (
    <div className={shell}>{inner}</div>
  );
}
