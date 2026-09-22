import { getArAging, type ArAgingRow } from "@/lib/commercial/reports/ar-aging";
import { etTodayIso } from "@/lib/date-et";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (cents: number) => (cents / 100).toFixed(2);

export async function GET() {
  const guard = await guardExport({ report: "ar-aging" });
  if (!guard.ok) return guard.response;

  const aging = await getArAging();
  const header = ["GC", "Current", "1-30", "31-60", "61-90", "90+", "Total", "Open items", "Oldest days"];
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
  const caveat =
    aging.noDueDateCents > 0
      ? [
          "",
          [
            csv(
              `NOTE: ${money(aging.noDueDateCents)} across ${aging.noDueDateCount} open item${aging.noDueDateCount === 1 ? "" : "s"} has no due date, so it is counted as Current and can never show as overdue. The ageing above is only as complete as the due dates behind it.`
            ),
          ].join(","),
        ]
      : [];

  const body = [header.map(csv).join(","), ...aging.rows.map(line), totals, ...caveat].join("\r\n") + "\r\n";
  const today = etTodayIso();
  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(body, `AR_Aging_${today}.csv`, "AR Aging — open invoices and AIA applications by age");
}
