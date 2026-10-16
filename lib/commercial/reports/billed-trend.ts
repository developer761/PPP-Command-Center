import "server-only";

import { etTodayIso } from "@/lib/date-et";
import { loadPeriodBilling, monthlyPointsFor, type PeriodInvoice } from "./period-billing";

/**
 * "Revenue billed / month · last 6 mo" — BOTH ledgers.
 *
 * Every one of these small trend charts was drawn by `monthlyBilledSeries`,
 * which reads `commercial_invoices` alone. Tomco's largest jobs bill through
 * AIA G702/G703 applications, which write no invoice row, so on 2026-10-16
 * LMJ's account page read $1.3M billed to date (all but $91k of it AIA) above
 * two charts that topped out at $7K, and the Reports and Job Costs charts were
 * missing the same money company-wide. They each said they tied out with the
 * dashboard; the dashboard had moved to `loadPeriodBilling` and they had not.
 *
 * This is that fold — invoices by sent date, each AIA application's added
 * work by its billing period, pre-tax, gross of retainage — so a chart here
 * and the dashboard's "Revenue billed" draw the same bars for the same jobs.
 * (The Invoices page keeps its invoice-only series on purpose and says so.)
 *
 * Values in $K for TrendChart's `currency-k`. Trailing six ET months ending
 * in the current one: a one-day range pads back to `monthlyPointsFor`'s
 * six-month minimum.
 */
export async function billedTrendLastSixMonths(
  oppIds: Iterable<string>,
  invoices: PeriodInvoice[],
  todayEt: string = etTodayIso(),
): Promise<{ label: string; value: number }[]> {
  const billing = await loadPeriodBilling([...oppIds], invoices, null);
  return lastSixMonthsPoints(billing.monthly, todayEt);
}

/** The six trailing ET months of a period-billing `monthly` map. Pure. */
export function lastSixMonthsPoints(
  monthly: Map<string, number>,
  todayEt: string,
): { label: string; value: number }[] {
  return monthlyPointsFor(monthly, { fromYmd: todayEt, toYmd: todayEt, label: "Last 6 months" }, todayEt).map(
    ({ label, value }) => ({ label, value }),
  );
}
