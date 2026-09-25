import Link from "next/link";
import {
  SPEND_PERIODS,
  spendPeriodRange,
  type SpendPeriodKey,
} from "@/lib/commercial/reports/tomco/spend-periods";

/**
 * The week picker over a money-out register.
 *
 * Links, not a form, so the choice is in the URL: Mary reconciles against
 * Salesforce a week at a time and sends the link to Brendan, and a filter held
 * in component state cannot be sent to anybody.
 *
 * It states the dates it resolved to. "This week" means something different on
 * a Monday than on a Friday, and a register she is ticking off against a bank
 * statement has to say which days it is showing rather than leave her to work
 * it out from the rows that happen to be there.
 */
export function SpendPeriodBar({
  active,
  hrefFor,
  rowCount,
  undated,
}: {
  active: SpendPeriodKey;
  /** Build the URL for a period, preserving whatever else is on the page. */
  hrefFor: (key: SpendPeriodKey) => string;
  rowCount: number;
  /** Rows with no date, which sit outside every window. */
  undated: number;
}) {
  const range = spendPeriodRange(active);
  return (
    <div className="space-y-1.5" data-print-hide>
      <div className="flex flex-wrap items-center gap-1.5">
        {SPEND_PERIODS.map((p) => {
          const on = p.key === active;
          return (
            <Link
              key={p.key}
              href={hrefFor(p.key)}
              aria-current={on ? "true" : undefined}
              className={`inline-flex items-center px-3 min-h-[44px] rounded-lg border text-[12.5px] font-semibold touch-manipulation ${
                on
                  ? "bg-cc-brand-600 border-cc-brand-600 text-white"
                  : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
      <p className="text-[11.5px] text-ppp-charcoal-500">
        {range ? (
          <>
            Showing <span className="font-semibold text-ppp-charcoal-700">{range.from}</span> to{" "}
            <span className="font-semibold text-ppp-charcoal-700">{range.to}</span> ·{" "}
          </>
        ) : null}
        {rowCount.toLocaleString("en-US")} {rowCount === 1 ? "row" : "rows"}
        {/* Not silently dropped. A register that quietly loses rows is one you
            cannot reconcile against anything. */}
        {active !== "all" && undated > 0 ? (
          <>
            {" "}
            · {undated} with no date {undated === 1 ? "is" : "are"} outside every window — see All
            time
          </>
        ) : null}
      </p>
    </div>
  );
}
