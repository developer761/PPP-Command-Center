/**
 * AIA G702/G703 Excel export (Phase H3). Builds a workbook whose sheets +
 * cells mirror Katie's "Blank AIA Requisition.xls" (see TEMPLATE_MAP.md), then
 * writes the HARD computed values from resolveG702 + the G703 lines so the
 * file is correct regardless of any formula state. Server-only (exceljs is
 * Node) — imported from the export API route.
 */
import ExcelJS from "exceljs";
import type { AiaApplication, AiaLineItem } from "./db";
import { lineCompletedStoredCents, type AiaG702 } from "./constants";

const MONEY = '#,##0.00;(#,##0.00)';
const d = (cents: number) => cents / 100;

export async function buildAiaWorkbookBuffer(input: {
  application: AiaApplication;
  lines: AiaLineItem[];
  g702: AiaG702;
  projectLabel: string;
  ownerLabel: string;
  contractorLabel: string;
}): Promise<Buffer> {
  const { application: app, lines, g702 } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = "PPP Command Center";
  wb.created = new Date(0); // deterministic; the app stamps real dates elsewhere

  // Clamp to [0,100] for parity with computeG702 (constants.ts) so the G703
  // total-retainage column can't diverge from the G702 line-35 figure if the
  // DB CHECK on retainage_pct is ever relaxed. Defense-in-depth.
  const pct = Math.min(100, Math.max(0, Number(app.retainage_pct) || 0));
  const periodTo = app.period_to ? new Date(app.period_to) : null;

  // ── Sheet 1: G702 summary certificate ──
  const g = wb.addWorksheet("Loan G-702");
  g.getColumn(1).width = 42; // A (labels)
  g.getColumn(4).width = 3; // D ($)
  g.getColumn(5).width = 16; // E (values)
  const put = (cell: string, value: ExcelJS.CellValue, opts?: { bold?: boolean; money?: boolean }) => {
    const c = g.getCell(cell);
    c.value = value;
    if (opts?.bold) c.font = { bold: true };
    if (opts?.money) c.numFmt = MONEY;
  };

  put("A1", "APPLICATION AND CERTIFICATION FOR PAYMENT", { bold: true });
  put("G1", "AIA DOCUMENT G702");
  put("A3", `TO OWNER: ${input.ownerLabel}`);
  put("D3", `PROJECT: ${input.projectLabel}`);
  put("H3", "APPLICATION NO:");
  put("I4", app.application_number);
  put("H7", "PERIOD TO:");
  if (periodTo) { const c = g.getCell("I7"); c.value = periodTo; c.numFmt = "mm/dd/yyyy"; }
  put("A10", `FROM CONTRACTOR: ${input.contractorLabel}`);

  const line = (row: number, label: string, cents: number, opts?: { bold?: boolean }) => {
    put(`A${row}`, label, { bold: opts?.bold });
    put(`D${row}`, "$");
    put(`E${row}`, d(cents), { bold: opts?.bold, money: true });
  };
  line(24, "1.  ORIGINAL CONTRACT SUM", g702.originalContractCents);
  line(25, "2.  Net change by Change Orders", g702.netChangeOrdersCents);
  line(26, "3.  CONTRACT SUM TO DATE (Line 1 ± 2)", g702.contractSumToDateCents, { bold: true });
  line(27, "4.  TOTAL COMPLETED & STORED TO DATE", g702.totalCompletedStoredCents);
  put("A29", "5.  RETAINAGE:");
  put("A30", "a.");
  put("B30", pct);
  put("C30", "% of Completed Work            $");
  // 5a on completed work (D+E); 5b = remainder so 5a+5b = total retainage exactly.
  const completedDE = lines.reduce((s, l) => s + l.from_previous_cents + l.this_period_cents, 0);
  const ret5a = Math.round((completedDE * pct) / 100);
  const ret5b = g702.retainageCents - ret5a;
  put("D30", d(ret5a), { money: true });
  put("A32", "b.");
  put("C32", "% of Stored Material           $");
  put("D32", d(ret5b), { money: true });
  line(35, "Total Retainage (Lines 5a + 5b)", g702.retainageCents);
  line(36, "6.  TOTAL EARNED LESS RETAINAGE", g702.totalEarnedLessRetainageCents);
  line(39, "7.  LESS PREVIOUS CERTIFICATES FOR PAYMENT", g702.previousCertificatesCents);
  line(40, "8.  CURRENT PAYMENT DUE", g702.currentPaymentDueCents, { bold: true });
  line(41, "9.  BALANCE TO FINISH, INCLUDING RETAINAGE", g702.balanceToFinishCents);

  // ── Sheet 2: G703 continuation sheet ──
  const s = wb.addWorksheet("G-703 Total Hard Cost");
  s.getColumn(1).width = 6; // A item
  s.getColumn(2).width = 40; // B description
  [3, 4, 5, 6, 7, 8, 9, 10].forEach((i) => (s.getColumn(i).width = 14)); // C..J
  s.getCell("A1").value = "CONTINUATION SHEET";
  s.getCell("E1").value = "AIA DOCUMENT G703";
  s.getCell("H2").value = "APPLICATION NO:";
  s.getCell("I2").value = app.application_number;
  if (periodTo) { const c = s.getCell("I4"); c.value = periodTo; c.numFmt = "mm/dd/yyyy"; }
  s.getCell("J10").value = pct / 100;

  const headers: [string, string][] = [
    ["A7", "A"], ["B7", "B"], ["C7", "C"], ["D7", "D"], ["E7", "E"], ["F7", "F"], ["G7", "G"], ["H7", "H"], ["I7", "I"], ["J7", "RET."],
    ["A8", "ITEM NO."], ["B8", "DESCRIPTION OF WORK"], ["C8", "SCHEDULED VALUE"], ["D8", "FROM PREVIOUS"], ["E8", "THIS PERIOD"],
    ["F8", "STORED"], ["G8", "TOTAL COMPLETED & STORED"], ["H8", "% (G/C)"], ["I8", "BALANCE TO FINISH"], ["J8", "RETAINAGE"],
  ];
  for (const [cell, val] of headers) {
    const c = s.getCell(cell);
    c.value = val;
    c.font = { bold: true, size: 9 };
  }

  let row = 13;
  let totC = 0, totD = 0, totE = 0, totF = 0, totG = 0, totJ = 0;
  for (const l of lines) {
    const total = lineCompletedStoredCents(l);
    const bal = l.scheduled_value_cents - total;
    const ret = Math.round((total * pct) / 100);
    const pctG = l.scheduled_value_cents > 0 ? total / l.scheduled_value_cents : 0;
    s.getCell(`A${row}`).value = l.item_no ?? "";
    s.getCell(`B${row}`).value = l.description;
    s.getCell(`C${row}`).value = d(l.scheduled_value_cents);
    s.getCell(`D${row}`).value = d(l.from_previous_cents);
    s.getCell(`E${row}`).value = d(l.this_period_cents);
    s.getCell(`F${row}`).value = d(l.materials_stored_cents);
    s.getCell(`G${row}`).value = d(total);
    s.getCell(`H${row}`).value = pctG;
    s.getCell(`I${row}`).value = d(bal);
    s.getCell(`J${row}`).value = d(ret);
    for (const col of ["C", "D", "E", "F", "G", "I", "J"]) s.getCell(`${col}${row}`).numFmt = MONEY;
    s.getCell(`H${row}`).numFmt = "0.0%";
    totC += l.scheduled_value_cents; totD += l.from_previous_cents; totE += l.this_period_cents;
    totF += l.materials_stored_cents; totG += total; totJ += ret;
    row++;
  }
  // Grand totals
  const gt = Math.max(row + 1, 35);
  s.getCell(`B${gt}`).value = "GRAND TOTALS";
  s.getCell(`B${gt}`).font = { bold: true };
  const totals: [string, number][] = [["C", totC], ["D", totD], ["E", totE], ["F", totF], ["G", totG], ["J", totJ]];
  for (const [col, cents] of totals) {
    const c = s.getCell(`${col}${gt}`);
    c.value = d(cents);
    c.numFmt = MONEY;
    c.font = { bold: true };
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
