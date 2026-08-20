import { csvEscape as csv } from "@/lib/commercial/csv";
import { etTodayIso } from "@/lib/date-et";
import type { ReceivablesReport, ReceivableRow } from "./receivables";

/**
 * The receivables sheet as a file — ONE builder, used by both the download
 * route and the email to Alex, so the two can never drift.
 *
 * Modelled column-for-column on the sheet Mary keeps by hand (Job ·
 * Billed/Open · Notes) with the columns she derives in her head made explicit:
 * what kind of receivable it is, the reference she hand-types as
 * "AIA#3-7/22/26", and how late it is.
 *
 * The total row is the last line, where hers is, so the file reads the same
 * way in Excel as the page does on screen.
 */

const money = (cents: number) => (cents / 100).toFixed(2);

const KIND_LABEL: Record<ReceivableRow["kind"], string> = {
  invoice: "Invoice",
  aia: "AIA",
  retainage: "Retention",
};

/** How late, in the words the page uses. Retention is never "late". */
function ageLabel(r: ReceivableRow): string {
  if (r.kind === "retainage") return "Held to close-out";
  if (r.daysOut === null) return "No due date";
  if (r.daysOut > 0) return `${r.daysOut} days late`;
  return "Not yet due";
}

export function receivablesCsv(report: ReceivablesReport): string {
  const header = ["Job", "GC", "Type", "Reference", "Billed / open", "Status", "Notes"];
  const line = (r: ReceivableRow) =>
    [r.jobName, r.accountName, KIND_LABEL[r.kind], r.reference, money(r.openCents), ageLabel(r), r.note ?? ""]
      .map(csv)
      .join(",");

  // Mary's sheet ends with the total. Retention is broken out beneath it
  // because her total includes it but it isn't collectible — the distinction
  // that makes the number mean something to Alex.
  const blank = ["", "", "", "", "", "", ""].map(csv).join(",");
  const totals = [
    ["TOTAL OUTSTANDING", "", "", "", money(report.totalOpenCents), "", ""],
    ["Collectible now", "", "", "", money(report.dueNowCents), "excludes retention", ""],
    ["Past due", "", "", "", money(report.overdueCents), "", ""],
    ["Retention held", "", "", "", money(report.retainageCents), "released at close-out", ""],
  ].map((row) => row.map(csv).join(","));

  return (
    [header.map(csv).join(","), ...report.rows.map(line), blank, ...totals].join("\r\n") + "\r\n"
  );
}

export function receivablesFilename(): string {
  return `Receivables_${etTodayIso()}.csv`;
}
