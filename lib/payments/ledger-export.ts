import ExcelJS from "exceljs";
import {
  EXPORT_COLUMNS,
  PAID_WITH_LABEL,
  RANGE_LABEL,
  exportRow,
  totalsOf,
  type LedgerPayment,
  type LedgerQuery,
  type PaidWith,
} from "@/lib/payments/ledger";

/**
 * The Payments tab as an .xlsx — the rows on screen, with base and fee in
 * separate columns, a totals row, and a Summary sheet. Dollar cells are
 * numbers with a currency format so finance can sum, pivot and chart them.
 */
const MONEY_COLUMNS = new Set<string>([
  "Base amount (to Salesforce)",
  "Card fee collected (3%)",
  "Total charged",
  "Stripe processing cost",
  "Fee minus Stripe cost",
]);
const MONEY_FMT = '"$"#,##0.00;[Red]-"$"#,##0.00';

export async function buildLedgerWorkbook(rows: LedgerPayment[], q: LedgerQuery): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PPP Command Center";
  wb.created = new Date();

  const ws = wb.addWorksheet("Payments", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map((h) => ({
    header: h,
    key: h,
    width: Math.max(12, Math.min(34, h.length + 4)),
    style: MONEY_COLUMNS.has(h) ? { numFmt: MONEY_FMT } : undefined,
  }));
  ws.getRow(1).font = { bold: true };
  for (const p of rows) ws.addRow(exportRow(p));

  // Totals row: real SUM formulas over the money columns, so the file stays
  // right if someone deletes or filters rows in Excel.
  if (rows.length) {
    const last = rows.length + 1;
    const totals = ws.addRow(EXPORT_COLUMNS.map((h, i) => (i === 0 ? "TOTAL" : null)));
    EXPORT_COLUMNS.forEach((h, i) => {
      if (!MONEY_COLUMNS.has(h)) return;
      const col = ws.getColumn(i + 1).letter;
      totals.getCell(i + 1).value = { formula: `SUM(${col}2:${col}${last})` };
    });
    totals.font = { bold: true };
  }

  const t = totalsOf(rows);
  const sum = wb.addWorksheet("Summary");
  sum.columns = [
    { header: "", key: "a", width: 32 },
    { header: "", key: "b", width: 16 },
    { header: "", key: "c", width: 16 },
    { header: "", key: "d", width: 16 },
    { header: "", key: "e", width: 16 },
  ];
  const range = q.from && q.to ? `${q.from} to ${q.to}` : q.from ? `from ${q.from}` : q.to ? `to ${q.to}` : "all time";
  sum.addRow(["PPP online payments", RANGE_LABEL[q.preset]]).font = { bold: true, size: 13 };
  sum.addRow(["Dates", range]);
  sum.addRow(["Payments", q.livemode ? "Real" : "Stripe TEST mode"]);
  if (q.paidWith !== "all") sum.addRow(["Paid with", PAID_WITH_LABEL[q.paidWith]]);
  sum.addRow([]);
  const money = (c: number) => c / 100;
  const lines: [string, number | string][] = [
    ["Payments counted", t.count],
    ["Collected — base (to Salesforce)", money(t.baseCents)],
    ["Card fees collected (3%)", money(t.feeCents)],
    ["Total charged", money(t.totalCents)],
    [`Stripe's cost (${t.stripeFeeKnownCount} of ${t.count} cleared)`, money(t.stripeFeeCents)],
    ["Card fees minus Stripe's cost", money(t.feeNetCents)],
    ["Refunded (not counted above)", money(t.refundedCents)],
  ];
  for (const [label, v] of lines) {
    const r = sum.addRow([label, v]);
    if (typeof v === "number" && label !== "Payments counted") r.getCell(2).numFmt = MONEY_FMT;
  }
  sum.addRow([]);
  sum.addRow(["Paid with", "Payments", "Base", "Card fees", "Total"]).font = { bold: true };
  for (const w of Object.keys(PAID_WITH_LABEL) as PaidWith[]) {
    const b = t.byPaidWith[w];
    if (!b.count) continue;
    const r = sum.addRow([PAID_WITH_LABEL[w], b.count, money(b.baseCents), money(b.feeCents), money(b.totalCents)]);
    [3, 4, 5].forEach((c) => (r.getCell(c).numFmt = MONEY_FMT));
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
