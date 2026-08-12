import Link from "next/link";
import {
  SAVED_VIEWS,
  savedView,
  viewHref,
  type FilterChip,
} from "@/lib/commercial/opportunities/saved-views";

/**
 * The view picker + the list's own status line, from the Opportunities
 * screenshot.
 *
 * The view name sits in the TITLE position, because in Salesforce the view is
 * the page identity — you open "New This Week", not "Opportunities, filtered".
 *
 * Under it, the line that keeps the list honest: how many rows, what they add
 * up to, how they're sorted. Ours prints a true count where Salesforce prints
 * "50+", because a capped count on a money list is the kind of small lie that
 * costs someone an afternoon.
 *
 * Server component. The dropdown is a <details>, so it needs no JS and works
 * before hydration.
 */
export function SavedViewPicker({
  activeKey,
  current,
  totalCount,
  totalLabel,
  sortLabel,
  chips,
}: {
  activeKey: string | null;
  current: Record<string, string | undefined>;
  totalCount: number;
  /** Summed value of the rows on screen — the header total. */
  totalLabel?: string | null;
  sortLabel: string;
  chips: FilterChip[];
}) {
  const active = savedView(activeKey ?? "");
  const groups = [
    { key: "pipeline", label: "Pipeline" },
    { key: "delivery", label: "Delivery" },
    { key: "attention", label: "Needs attention" },
  ] as const;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
          Opportunities
        </span>
      </div>

      <details className="group relative inline-block">
        <summary className="list-none inline-flex items-center gap-1.5 cursor-pointer min-h-[44px]">
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
            {active ? active.label : "Custom filter"}
          </h1>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform shrink-0">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div className="absolute z-30 mt-1.5 w-[19rem] max-w-[calc(100vw-2rem)] rounded-xl border border-ppp-charcoal-200 bg-surface shadow-lg overflow-hidden">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="px-3 pt-2.5 pb-1 text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-400">
                {g.label}
              </div>
              <ul>
                {SAVED_VIEWS.filter((v) => v.group === g.key).map((v) => {
                  const on = v.key === activeKey;
                  return (
                    <li key={v.key}>
                      <Link
                        href={viewHref(v, current)}
                        aria-current={on ? "page" : undefined}
                        className={`block px-3 py-2 min-h-[44px] ${
                          on ? "bg-cc-brand-50" : "hover:bg-ppp-charcoal-50"
                        }`}
                      >
                        <span className={`block text-[12.5px] font-bold ${on ? "text-cc-brand-800" : "text-ppp-charcoal"}`}>
                          {v.label}
                        </span>
                        <span className="block text-[11px] text-ppp-charcoal-500 leading-snug">
                          {v.hint}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </details>

      {/* The status line. Small, and the reason a filtered list never feels
          like it is hiding something. */}
      <p className="text-[11.5px] text-ppp-charcoal-500 tabular-nums mt-0.5">
        <strong className="text-ppp-charcoal font-bold">{totalCount}</strong>{" "}
        {totalCount === 1 ? "opportunity" : "opportunities"}
        {totalLabel && (
          <>
            {" · "}
            <strong className="text-ppp-charcoal font-bold">{totalLabel}</strong>
          </>
        )}
        {" · sorted by "}
        {sortLabel.toLowerCase()}
        {active && <> · {active.hint}</>}
      </p>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1 h-11 sm:h-7 pl-3 sm:pl-2.5 pr-1 rounded-full bg-cc-brand-50 border border-cc-brand-200 text-[11.5px] font-semibold text-cc-brand-800"
            >
              {c.label}
              <Link
                href={c.removeHref}
                aria-label={`Remove filter: ${c.label}`}
                className="inline-flex items-center justify-center h-9 w-9 sm:h-6 sm:w-6 rounded-full hover:bg-cc-brand-100 text-cc-brand-700"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </Link>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
