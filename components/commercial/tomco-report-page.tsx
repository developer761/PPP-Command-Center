import Link from "next/link";
import { GroupedReport } from "@/components/commercial/grouped-report";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";

/**
 * The windows Tomco's reports are named after.
 *
 * Three of Mary's are literally called "This Week" or "Last 30 Days", so the
 * window is part of the report rather than something she re-derives. `all` is
 * first because a migrated book is mostly history and an empty default would
 * read as a failed import.
 */
export const REPORT_PERIODS = [
  { key: "all", label: "All time", days: null },
  { key: "week", label: "This week", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "year", label: "Last 12 months", days: 365 },
] as const;

export type ReportPeriodKey = (typeof REPORT_PERIODS)[number]["key"];

/** The earliest YMD a period keeps, or null for all time. */
export function periodFrom(key: string | undefined, nowMs = Date.now()): string | null {
  const p = REPORT_PERIODS.find((x) => x.key === key);
  if (!p || p.days === null) return null;
  return new Date(nowMs - p.days * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * The page around one of Tomco's reports.
 *
 * Header, the group-by switcher, the period row, then the table. Every one of
 * these reports wants exactly this, so a new report is a spec plus its rows —
 * not another copy of a page.
 */
export function TomcoReportPage<R>({
  spec,
  rows,
  href,
  view,
  views,
  period,
  emptyHint,
  footer,
}: {
  spec: ReportSpec<R>;
  rows: R[];
  /** This report's own path, for the group-by links. */
  href: string;
  view: number;
  views: { key: string; label: string }[];
  /** The active period key — omit to hide the period row entirely. */
  period?: string;
  emptyHint?: string;
  /** Anything that belongs under the table — a chart, a caveat. */
  footer?: React.ReactNode;
}) {
  const link = (v?: string, p?: string) => {
    const q = new URLSearchParams();
    if (v) q.set("view", v);
    if (p && p !== "all") q.set("period", p);
    const s = q.toString();
    return s ? `${href}?${s}` : href;
  };
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-400">{spec.sourceLabel}</p>
        <h2 className="text-lg font-bold text-ppp-charcoal leading-tight">{spec.title}</h2>
        {spec.blurb && <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 max-w-2xl">{spec.blurb}</p>}
      </div>

      <GroupedReport
        spec={spec}
        rows={rows}
        groupingIndex={view}
        emptyHint={emptyHint}
        controls={
          views.length > 1 || period !== undefined ? (
            <div className="space-y-2.5">
              {views.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">Group by</span>
                  {views.map((v, i) => (
                    <Link
                      key={v.key}
                      href={link(v.key, period)}
                      aria-current={i === view ? "true" : undefined}
                      className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center transition-colors ${
                        i === view
                          ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                          : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                      }`}
                    >
                      {v.label}
                    </Link>
                  ))}
                </div>
              )}
              {period !== undefined && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">Period</span>
                  {REPORT_PERIODS.map((p) => (
                    <Link
                      key={p.key}
                      href={link(views[view]?.key, p.key)}
                      aria-current={p.key === period ? "true" : undefined}
                      className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center transition-colors ${
                        p.key === period
                          ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                          : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                      }`}
                    >
                      {p.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ) : undefined
        }
      />

      {footer}
    </div>
  );
}

/** Which grouping the `?view=` param selects, defaulting to the first. */
export function viewIndex(views: { key: string }[], param: string | undefined): number {
  const i = views.findIndex((v) => v.key === param);
  return i >= 0 ? i : 0;
}
