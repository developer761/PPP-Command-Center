import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { getCashFlowReport } from "@/lib/commercial/reports/cash-flow";
import { CASH_FLOW_PRESETS, CASH_FLOW_DEFAULT, cashFlowRange, resolvePreset } from "@/lib/commercial/reports/presets";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (c: number) => (c / 100).toFixed(2);

/** Cash flow — three sections in one sheet, in the order the page shows them. */
export async function GET(req: NextRequest) {
  const guard = await guardExport();
  if (!guard.ok) return guard.response;

  const preset = resolvePreset(
    req.nextUrl.searchParams.get("preset") ?? undefined,
    CASH_FLOW_PRESETS,
    CASH_FLOW_DEFAULT
  );
  const range = cashFlowRange(preset);
  const r = await getCashFlowReport(range);

  const L: string[] = [];
  const row = (...cells: (string | number)[]) => L.push(cells.map(csv).join(","));

  row("Cash flow", range.label, `${range.fromYmd} to ${range.toYmd}`);
  row("");
  row("Collected", money(r.totals.collectedCents));
  row("Billed", money(r.totals.billedCents));
  row("Payments", r.totals.paymentCount);
  row("Avg days to pay", r.totals.avgDaysToPay ?? "");
  // Over 100% is normal — older invoices landing in the window, not an error.
  row("Collection rate %", r.totals.collectionRatePct ?? "");
  row("Open balance", money(r.totals.openCents));
  row("");

  row("BY MONTH");
  row("Month", "Collected", "Billed", "Payments");
  for (const m of r.months) row(m.label, money(m.collectedCents), money(m.billedCents), m.paymentCount);
  row("");

  row("BY METHOD");
  row("Method", "Collected", "Payments");
  for (const m of r.byMethod) row(m.label, money(m.collectedCents), m.count);
  row("");

  row("SLOWEST TO PAY");
  row("GC", "Collected", "Avg days to pay", "Still open");
  for (const s of r.slowest) row(s.accountName, money(s.collectedCents), s.avgDaysToPay ?? "", money(s.openCents));

  if (r.untimedPayments > 0 || r.paidBeforeIssued > 0) {
    row("");
    row("DATA NOTES");
    // Carried into the file so a spreadsheet can't imply a precision the
    // underlying data doesn't have.
    if (r.untimedPayments > 0) row("Payments with no invoice issue date (excluded from days-to-pay)", r.untimedPayments);
    if (r.paidBeforeIssued > 0) row("Payments received before the invoice was issued (counted same-day)", r.paidBeforeIssued);
  }

  return csvResponse(L.join("\r\n") + "\r\n", `Cash_Flow_${range.fromYmd}_to_${range.toYmd}.csv`, "Cash flow — money received, and how long it took", range.label);
}
