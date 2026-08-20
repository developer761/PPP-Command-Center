import type { NextRequest } from "next/server";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { getSalesTaxReport } from "@/lib/commercial/reports/sales-tax";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { etTodayIso } from "@/lib/date-et";
import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sales tax as a file — the one export here that leaves the building.
 *
 * It goes to whoever prepares the filing, so it carries BOTH halves: the
 * collected total broken out by rate, and every exempt invoice with the
 * certificate behind it (or the absence of one). A tax export that lists only
 * what was charged hands the preparer half the picture and keeps the risky half
 * on a screen nobody opened.
 */
const money = (cents: number) => (cents / 100).toFixed(2);

export async function GET(req: NextRequest) {
  const guard = await guardExport();
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const period = resolvePreset(sp.get("tp") ?? undefined, ACTIVITY_PRESETS, ACTIVITY_DEFAULT);
  const range = activityRange(period);
  const report = await getSalesTaxReport({
    fromYmd: range?.fromYmd,
    toYmd: range?.toYmd,
    uncertifiedOnly: sp.get("nocert") === "1" || undefined,
  });

  const header = ["Issued", "Invoice", "Job", "GC", "Taxable base", "Rate %", "Tax", "Exempt", "Certificate"];
  const blank = new Array(header.length).fill("").map(csv).join(",");
  const lines = [
    header.map(csv).join(","),
    ...report.rows.map((r) =>
      [
        r.issuedYmd,
        r.invoiceNumber,
        r.jobName,
        r.accountName,
        money(r.subtotalCents),
        r.exempt ? "" : r.taxPct.toFixed(3),
        r.exempt ? "" : money(r.taxCents),
        r.exempt ? "Yes" : "No",
        // An exempt row with no certificate says so in words rather than
        // leaving a blank cell somebody reads as "not applicable".
        r.exempt ? r.certNumber ?? "MISSING" : "",
      ]
        .map(csv)
        .join(",")
    ),
    blank,
    ...report.byRate.map((b) =>
      [`Rate ${b.taxPct.toFixed(3)}%`, `${b.count} invoices`, "", "", money(b.baseCents), "", money(b.taxCents), "", ""]
        .map(csv)
        .join(",")
    ),
    blank,
    ["TAXABLE BASE", "", "", "", money(report.taxableBaseCents), "", "", "", ""].map(csv).join(","),
    ["TAX COLLECTED", "", "", "", "", "", money(report.taxCollectedCents), "", ""].map(csv).join(","),
    ["BILLED EXEMPT", `${report.exemptCount} invoices`, "", "", money(report.exemptBaseCents), "", "", "", ""].map(csv).join(","),
    [
      "EXEMPT WITHOUT A CERTIFICATE",
      `${report.uncertifiedCount} invoices`,
      "",
      "",
      money(report.uncertifiedBaseCents),
      "",
      "",
      "",
      "",
    ]
      .map(csv)
      .join(","),
  ];

  const scope = period !== "all" ? `_${period}` : "";
  return csvResponse(lines.join("\r\n") + "\r\n", `SalesTax${scope}_${etTodayIso()}.csv`);
}
