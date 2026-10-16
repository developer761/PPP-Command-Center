import { csvEscape as csv } from "@/lib/commercial/csv";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import type { ArAging, ArAgingRow } from "@/lib/commercial/reports/ar-aging";

/**
 * The AR Aging sheet, as bytes — everything but the title block and the BOM,
 * which `csvResponse` adds. Pure so the FILE can be tested, not the route.
 */

/*
 * THE BUCKET HEADERS SAY "days".
 *
 * They were "1-30", "31-60", "61-90". Excel reads `1-30` as a date and turns
 * the header into 30-Jan; `31-60` and `61-90` are not dates, so they stay
 * text. One of three sibling column labels silently became a different type,
 * and quoting does not stop it — only a label that is not date-shaped does.
 */
export const AR_AGING_CSV_HEADER = [
  "GC",
  "Current",
  "1-30 days",
  "31-60 days",
  "61-90 days",
  "90+ days",
  "Total",
  "Open items",
  "Oldest days",
] as const;

const money = (cents: number) => (cents / 100).toFixed(2);

export function arAgingCsv(aging: ArAging): string {
  const width = AR_AGING_CSV_HEADER.length;
  const line = (r: ArAgingRow) =>
    [r.accountName, money(r.current), money(r.d1_30), money(r.d31_60), money(r.d61_90), money(r.d90_plus), money(r.total), r.invoiceCount, Math.max(0, r.oldestDays)]
      .map(csv)
      .join(",");
  const totals = [
    "All GCs",
    money(aging.totals.current),
    money(aging.totals.d1_30),
    money(aging.totals.d31_60),
    money(aging.totals.d61_90),
    money(aging.totals.d90_plus),
    money(aging.totals.total),
    aging.invoiceCount,
    "",
  ].map(csv).join(",");

  // An item with no due date cannot age, so it sits in Current and the file
  // reads as a healthy book. Tomco's migrated invoices are all like that. The
  // screen says so; a CSV that leaves it out is the version that gets emailed
  // on to somebody who never saw the screen.
  //
  // Padded to the sheet's width, like every other export's caveat row — a
  // one-cell row in a nine-column sheet is the line a paste or an import
  // treats as a different table. The figure in the prose carries its `$`,
  // because in a sentence a bare `170.00` is not obviously money.
  const caveat =
    aging.noDueDateCents > 0
      ? [
          "",
          [
            `NOTE: ${formatCentsFull(aging.noDueDateCents)} across ${aging.noDueDateCount} open item${aging.noDueDateCount === 1 ? "" : "s"} has no due date, so it is counted as Current and can never show as overdue. The ageing above is only as complete as the due dates behind it.`,
            ...Array(width - 1).fill(""),
          ]
            .map(csv)
            .join(","),
        ]
      : [];

  return [AR_AGING_CSV_HEADER.map(csv).join(","), ...aging.rows.map(line), totals, ...caveat].join("\r\n") + "\r\n";
}
