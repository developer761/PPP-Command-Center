/**
 * AIA G702/G703 Excel export — Stephanie's own workbook, filled.
 *
 * Stephanie 2026-09-01: "The excel spreadsheet is not going to fly, has to look
 * like the spreadsheet provided."
 *
 * It used to build a workbook from scratch that mirrored her form's cell
 * addresses. The addresses were right and the document still wasn't
 * submittable, because a G702 is not its numbers — it is the certification the
 * contractor signs, the notary block underneath it, the Architect's Certificate
 * for Payment, the change-order summary and the AIA legal footer. None of that
 * was there. You cannot notarise a spreadsheet that has no notary block.
 *
 * So this loads her actual workbook and writes values into it. Everything she
 * cares about — borders, merges, column widths, print setup, the 1992 AIA
 * boilerplate — is correct by construction, because it is her file.
 *
 * HARD VALUES, not formulas. Her template computes itself (line 3 reads the
 * G703 grand total, line 5a reads its retainage column) and its per-row
 * retainage formulas are inconsistent — rows 13-14 use 5%, rows 15-34 use 10%,
 * which looks like an old edit rather than intent. Writing computed values over
 * the formulas means the sheet says exactly what `computeG702` says, and the
 * two AIA sheets a GC receives cannot disagree with each other or with the
 * invoice.
 */
import ExcelJS from "exceljs";
import type { AiaApplication, AiaLineItem } from "./db";
import { lineCompletedStoredCents, type AiaG702 } from "./constants";
import { aiaTemplateBuffer } from "./template/template-b64";

const MONEY = '#,##0.00;(#,##0.00)';
const d = (cents: number) => cents / 100;

/** Sheet names carry a trailing space on the G703 — hers does, and a GC's AP
 *  system or her own copy-paste may key off it. Matched exactly. */
const SHEET_G702 = "Loan G-702";
const SHEET_G703 = "G-703 Total Hard Cost ";

/** The template's line-item slots and its grand-total row. */
const FIRST_LINE_ROW = 13;
const LAST_LINE_ROW = 34;
const TOTALS_ROW = 35;

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
  await wb.xlsx.load(aiaTemplateBuffer() as unknown as ArrayBuffer);

  const g = wb.getWorksheet(SHEET_G702);
  const s = wb.getWorksheet(SHEET_G703);
  if (!g || !s) {
    throw new Error(
      `AIA template is missing a sheet (found: ${wb.worksheets.map((w) => w.name).join(", ")})`
    );
  }

  // Clamp for parity with computeG702 so the G703 retainage column can't
  // diverge from G702 line 5 if the DB CHECK on retainage_pct is relaxed.
  const pct = Math.min(100, Math.max(0, Number(app.retainage_pct) || 0));
  const periodTo = app.period_to ? new Date(app.period_to) : null;

  const money = (cell: string, cents: number, sheet: ExcelJS.Worksheet = g) => {
    const c = sheet.getCell(cell);
    c.value = d(cents);
    c.numFmt = MONEY;
  };

  // ── Sheet 1 · G702 ──────────────────────────────────────────────────────
  // The header labels ("TO OWNER:", "PROJECT:") are part of her form; only the
  // values go in, on the line beneath each, which is where she writes them.
  g.getCell("A4").value = input.ownerLabel;
  g.getCell("D4").value = input.projectLabel;
  g.getCell("A11").value = input.contractorLabel;
  g.getCell("I4").value = app.application_number;
  if (periodTo) {
    const c = g.getCell("I7"); // overwrites the template's =TODAY()
    c.value = periodTo;
    c.numFmt = "mm/dd/yyyy";
  }

  money("E24", g702.originalContractCents);
  money("E25", g702.netChangeOrdersCents);
  money("E26", g702.contractSumToDateCents);
  money("E27", g702.totalCompletedStoredCents);

  // 5a is retainage on completed work (G703 columns D+E); 5b is the remainder,
  // so 5a + 5b is exactly line 5 and the sheet foots however the split falls.
  g.getCell("B30").value = pct;
  const completedDE = lines.reduce((n, l) => n + l.from_previous_cents + l.this_period_cents, 0);
  const ret5a = Math.round((completedDE * pct) / 100);
  money("D30", ret5a);
  money("D32", g702.retainageCents - ret5a);
  money("E35", g702.retainageCents);

  money("E36", g702.totalEarnedLessRetainageCents);
  money("E39", g702.previousCertificatesCents);
  money("E40", g702.currentPaymentDueCents);
  money("E41", g702.balanceToFinishCents);

  // Change-order summary. Her form has this block and the old export wrote none
  // of it — it wasn't even in the cells the map said to fill. Split additions
  // from deductions, because that is what the two columns mean; a net figure in
  // the ADDITIONS column would be wrong on a job with a credit.
  const coLines = lines.filter((l) => !!l.change_order_id || /^CO-0*\d+$/i.test(l.item_no ?? ""));
  const additions = coLines.reduce((n, l) => n + Math.max(0, l.scheduled_value_cents), 0);
  const deductions = coLines.reduce((n, l) => n + Math.min(0, l.scheduled_value_cents), 0);
  // "Previous months" vs "this month" needs a per-CO approval date this export
  // does not receive, so everything lands on the THIS MONTH row rather than
  // being split on a guess. The totals are right either way, which is what the
  // GC reconciles against.
  money("D46", 0);
  money("E46", 0);
  money("D48", additions);
  money("E48", Math.abs(deductions));
  money("D50", additions);
  money("E50", Math.abs(deductions));
  money("D51", additions + deductions);

  // ── Sheet 2 · G703 ──────────────────────────────────────────────────────
  s.getCell("I2").value = app.application_number;
  if (periodTo) {
    for (const cell of ["I3", "I4"]) {
      const c = s.getCell(cell); // both are =TODAY() in the template
      c.value = periodTo;
      c.numFmt = "mm/dd/yyyy";
    }
  }
  s.getCell("J10").value = pct / 100;

  // Her form has 22 slots. More than that is rare now that the schedule is one
  // contract line plus change orders, but silently dropping a line from a
  // customer document is not something to leave to luck — grow the sheet.
  const overflow = Math.max(0, lines.length - (LAST_LINE_ROW - FIRST_LINE_ROW + 1));
  if (overflow > 0) s.duplicateRow(LAST_LINE_ROW, overflow, true);
  const totalsRow = TOTALS_ROW + overflow;

  let row = FIRST_LINE_ROW;
  let totC = 0, totD = 0, totE = 0, totF = 0, totG = 0, totJ = 0;
  for (const l of lines) {
    const completed = lineCompletedStoredCents(l);
    const ret = Math.round((completed * pct) / 100);
    s.getCell(`A${row}`).value = l.item_no ?? "";
    s.getCell(`B${row}`).value = l.description;
    money(`C${row}`, l.scheduled_value_cents, s);
    money(`D${row}`, l.from_previous_cents, s);
    money(`E${row}`, l.this_period_cents, s);
    money(`F${row}`, l.materials_stored_cents, s);
    money(`G${row}`, completed, s);
    const h = s.getCell(`H${row}`);
    h.value = l.scheduled_value_cents > 0 ? completed / l.scheduled_value_cents : 0;
    h.numFmt = "0.0%";
    money(`I${row}`, l.scheduled_value_cents - completed, s);
    money(`J${row}`, ret, s);
    totC += l.scheduled_value_cents; totD += l.from_previous_cents; totE += l.this_period_cents;
    totF += l.materials_stored_cents; totG += completed; totJ += ret;
    row += 1;
  }

  // Blank the slots we didn't use. The template ships them pre-filled with
  // formulas and zeros; leaving those behind puts rows of $0.00 under the last
  // real line, which reads as work priced at nothing.
  for (let r = row; r <= LAST_LINE_ROW + overflow; r++) {
    for (const col of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]) {
      s.getCell(`${col}${r}`).value = null;
    }
  }

  money(`C${totalsRow}`, totC, s);
  money(`D${totalsRow}`, totD, s);
  money(`E${totalsRow}`, totE, s);
  money(`F${totalsRow}`, totF, s);
  money(`G${totalsRow}`, totG, s);
  money(`I${totalsRow}`, totC - totG, s);
  money(`J${totalsRow}`, totJ, s);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
