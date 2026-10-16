import type { NextRequest } from "next/server";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { getSalesTaxReport } from "@/lib/commercial/reports/sales-tax";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { etTodayIso } from "@/lib/date-et";
import { ACTIVITY_PRESETS, LEDGER_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";

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
  const guard = await guardExport({ accounting: true });
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  /*
   * 🔴 THE SAME DEFAULT AS THE SCREEN THAT LINKS HERE.
   *
   * This fell back to ACTIVITY_DEFAULT ("all") while the Accounting page runs
   * on LEDGER_DEFAULT ("this month") and — correctly — omits `tp` from the URL
   * when it is at its own default. So "Export for filing" from a screen
   * showing ONE MONTH produced a file covering everything.
   *
   * Measured 2026-10-16. Sales tax: screen 1 invoice / $0.00; file 74 invoices
   * / $9,267.15 spanning Aug 2025 to Oct 2026. Ledger: screen 129 rows / net
   * -$59,245.58; file 1,977 rows / net +$369,496.40 — the sign flips. This is
   * the file that goes to the accountant to file from.
   *
   * The Accounting page is the only caller of this route (grepped), so there
   * is no second consumer relying on "all".
   */
  const period = resolvePreset(sp.get("tp") ?? undefined, ACTIVITY_PRESETS, LEDGER_DEFAULT);
  const range = activityRange(period);
  // The same narrowing the screen is showing, or the file and the screen
  // disagree — the trap this route's siblings already name.
  const rawKind = sp.get("kind");
  const kind = rawKind === "no_cert" || rawKind === "unmarked" ? rawKind : undefined;
  const report = await getSalesTaxReport({
    fromYmd: range?.fromYmd,
    toYmd: range?.toYmd,
    exemptKind: kind,
    uncertifiedOnly: (!kind && sp.get("nocert") === "1") || undefined,
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
        // Three different situations, three different words. "MISSING" for both
        // of the bad ones told the person doing the filing they had the same
        // problem twice — one is an unfiled document, the other is tax that was
        // probably never charged.
        r.exempt
          ? r.certNumber ??
            (r.exemptKind === "unmarked" ? "NEVER MARKED EXEMPT" : "CERTIFICATE MISSING")
          : "",
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
  return csvResponse(lines.join("\r\n") + "\r\n", `SalesTax${scope}_${etTodayIso()}.csv`, "Sales tax — collected, and exemptions on file", range?.label ?? "all time");
}
