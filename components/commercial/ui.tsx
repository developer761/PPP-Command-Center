/**
 * Commercial UI primitives (RUX-0 foundation).
 *
 * ONE canonical set of small building blocks so every tool/panel reads as one
 * system instead of ~11 bespoke tile/empty-state variants. Adopt these as the
 * tools get standardized (RUX-3+). All accents use the brand blue (cc-brand);
 * rose is reserved for genuinely destructive/overdue states, emerald for
 * success/"good", amber for "needs attention".
 *
 * Server-safe: these are presentational, no client hooks — usable in RSC.
 */
import Link from "next/link";
import type { ReactNode } from "react";

/** The platform tone vocabulary. `brand` = blue (the default accent). */
export type Tone = "neutral" | "brand" | "blue" | "emerald" | "amber" | "rose" | "navy";

/** Solid-ish pill classes (bg + text + border) per tone — for StatusPill/chips. */
const PILL_TONE: Record<Tone, string> = {
  neutral: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200",
  brand: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200",
  blue: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  navy: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200",
};

/** Value text color per tone — for StatTile figures. */
const VALUE_TONE: Record<Tone, string> = {
  neutral: "text-ppp-charcoal",
  brand: "text-cc-brand-700",
  blue: "text-ppp-blue-700",
  emerald: "text-emerald-700",
  amber: "text-amber-800",
  rose: "text-rose-700",
  navy: "text-ppp-navy-700",
};

/**
 * A status/label pill. Each domain keeps its own label helper (e.g.
 * proposalStatusLabel) + decides the tone; this just renders it consistently.
 */
export function StatusPill({
  label,
  tone = "neutral",
  className = "",
  title,
}: {
  label: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] font-bold uppercase tracking-wide whitespace-nowrap ${PILL_TONE[tone]} ${className}`}
    >
      {label}
    </span>
  );
}

/**
 * A compact KPI tile: tiny uppercase label + condensed value + optional sub.
 * The one tile shape for tool KPI rows (replaces StatCard/MiniFig/ProjectStat
 * divergence). Wrap several in a `grid` for a KPI strip.
 */
export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-ppp-charcoal-100 bg-surface px-3 py-2.5 ${className}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 leading-none">
        {label}
      </div>
      <div className={`font-condensed text-[19px] font-black tabular-nums leading-tight mt-1 ${VALUE_TONE[tone]}`}>
        {value}
      </div>
      {sub != null && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}

/**
 * The one empty-state pattern: soft icon disc + title + one-line hint + an
 * optional CTA (Link or button). Replaces the ad-hoc per-tool empty blocks.
 */
export function EmptyState({
  icon,
  title,
  hint,
  cta,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  cta?: { label: string; href: string } | ReactNode;
  className?: string;
}) {
  return (
    <div className={`text-center py-12 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl ${className}`}>
      {icon && (
        <span aria-hidden className="mx-auto mb-3 inline-flex items-center justify-center h-12 w-12 rounded-full bg-ppp-charcoal-100 text-ppp-charcoal-400">
          {icon}
        </span>
      )}
      <p className="text-sm font-semibold text-ppp-charcoal">{title}</p>
      {hint && <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto leading-snug">{hint}</p>}
      {cta && (
        <div className="mt-4">
          {isLinkCta(cta) ? (
            <Link
              href={cta.href}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]"
            >
              {cta.label}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14 M13 5l7 7-7 7" /></svg>
            </Link>
          ) : (
            cta
          )}
        </div>
      )}
    </div>
  );
}

function isLinkCta(cta: unknown): cta is { label: string; href: string } {
  return typeof cta === "object" && cta !== null && "href" in cta && "label" in cta;
}
