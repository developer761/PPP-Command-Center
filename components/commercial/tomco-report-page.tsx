import Link from "next/link";
import { GroupedReport } from "@/components/commercial/grouped-report";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";

/**
 * The page around one of Tomco's reports.
 *
 * Header, the group-by switcher, then the table. Every one of these reports
 * wants exactly this, so a new report is a spec plus its rows — not another
 * copy of a page.
 */
export function TomcoReportPage<R>({
  spec,
  rows,
  href,
  view,
  views,
  emptyHint,
  footer,
}: {
  spec: ReportSpec<R>;
  rows: R[];
  /** This report's own path, for the group-by links. */
  href: string;
  view: number;
  views: { key: string; label: string }[];
  emptyHint?: string;
  /** Anything that belongs under the table — a chart, a caveat. */
  footer?: React.ReactNode;
}) {
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
          views.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">Group by</span>
              {views.map((v, i) => {
                const active = i === view;
                return (
                  <Link
                    key={v.key}
                    href={`${href}?view=${v.key}`}
                    aria-current={active ? "true" : undefined}
                    className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center transition-colors ${
                      active
                        ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                        : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    {v.label}
                  </Link>
                );
              })}
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
