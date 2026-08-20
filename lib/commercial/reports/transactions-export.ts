import { csvEscape as csv } from "@/lib/commercial/csv";
import { etTodayIso } from "@/lib/date-et";
import type { TransactionsReport, TxnRow } from "./transactions";

/**
 * The ledger as a CSV — ONE builder, so the download and the screen can't drift.
 *
 * Keeps the page's structure rather than flattening it: a month header row, its
 * transactions, then that month's subtotal. Alex's Salesforce export reads the
 * same way, and a bookkeeper reconciling a month wants the subtotal next to the
 * rows it covers — not recomputed with a spreadsheet formula that nobody
 * checks.
 */

const money = (cents: number) => (cents / 100).toFixed(2);

/** Money out prints negative, so a spreadsheet SUM over the column is the net. */
function signed(r: TxnRow): string {
  return money(r.direction === "in" ? r.amountCents : -r.amountCents);
}

function depositCell(r: TxnRow): string {
  if (!r.depositable) return "n/a";
  return r.depositedAtIso ? `Yes ${r.depositedAtIso.slice(0, 10)}` : "No";
}

export function transactionsCsv(report: TransactionsReport): string {
  const header = ["Date", "Name", "GC", "Record type", "Amount", "Deposited", "Reference"];
  const blank = new Array(header.length).fill("").map(csv).join(",");
  const lines: string[] = [header.map(csv).join(",")];

  for (const m of report.months) {
    lines.push([`${m.label} (${m.rows.length})`, "", "", "", "", "", ""].map(csv).join(","));
    for (const r of m.rows) {
      lines.push(
        [
          r.dateYmd,
          r.name,
          r.accountName ?? "",
          r.recordType,
          signed(r),
          depositCell(r),
          r.reference ?? "",
        ]
          .map(csv)
          .join(",")
      );
    }
    lines.push(
      ["Subtotal", "", "", "", money(m.inCents - m.outCents), "", ""].map(csv).join(",")
    );
    lines.push(blank);
  }

  // Totals last, the way his report closes. Money in and money out are kept on
  // their own lines: a single "total" over a mixed ledger is not a number
  // anybody can use.
  lines.push(["MONEY IN", "", "", "", money(report.inCents), "", ""].map(csv).join(","));
  lines.push(["MONEY OUT", "", "", "", money(-report.outCents), "", ""].map(csv).join(","));
  lines.push(["NET", "", "", "", money(report.netCents), "", ""].map(csv).join(","));
  lines.push(
    ["Not yet deposited", "", "", "", money(report.undepositedCents), `${report.undepositedCount} payment${report.undepositedCount === 1 ? "" : "s"}`, ""]
      .map(csv)
      .join(",")
  );

  return lines.join("\r\n") + "\r\n";
}

export function transactionsFilename(period?: string): string {
  const scope = period && period !== "all" ? `_${period}` : "";
  return `Transactions${scope}_${etTodayIso()}.csv`;
}
