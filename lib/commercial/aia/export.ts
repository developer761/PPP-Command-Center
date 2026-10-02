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
  /**
   * The approved change orders behind line 2, with their approval dates, so the
   * CHANGE ORDER SUMMARY can split previous months from this month. Omitted,
   * the block still foots to line 2 and reports it all as previous months —
   * never as work approved in a period nobody can evidence.
   */
  changeOrders?: Array<{ amountCents: number; decidedAt: string | null }>;
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
  // values go in.
  //
  // The wrapText note that stood here is gone with the layout it described:
  // Stephanie 2026-09-11 asked for the block to wrap rather than run on in one
  // cell, which was the right fix while all three lines shared a single cell.
  // They no longer do — see below — so there is nothing left to wrap.
  /*
   * ONE LINE PER ROW, in the cells her form actually uses.
   *
   * Stephanie 2026-10-02, with a filled sample attached: "the heading on the
   * G702 (pg 1) doesn't export the way we need it to."
   *
   * Her sample puts each block's name, street and city/state/ZIP in three
   * SEPARATE cells going down the column the label points at:
   *
   *     TO OWNER:        C5 name · C6 street · C7 city, state ZIP
   *     PROJECT:         E5 name · E6 street · E7 city, state ZIP
   *     FROM CONTRACTOR: C12 name · C14 street · C15 city, state ZIP
   *
   * We were writing all three lines as ONE newline-joined, wrapped string into
   * A4, D4 and A11 — cells her form leaves empty, in the wrong column, with the
   * block crammed into a single cell. Every cell above was empty in our export
   * and every cell we wrote was one her layout does not read.
   *
   * The contractor block skips row 13: that is her sheet's spacing, not a typo.
   *
   * The labels are joined with "\n" by header-labels, so splitting on it gives
   * the parts back. Three slots per block; an address with a second line
   * produces four parts, so the middle ones are merged into the street slot
   * rather than pushing the city off the end.
   */
  /*
   * The color is hers too, and it only became visible when we started filling
   * these cells.
   *
   * Her form colors the typed-in values: the owner and contractor blocks blue,
   * the project block red (palette indices 12 and 10, same standard palette in
   * both files). Our template carries BLUE on the owner and contractor cells —
   * already matching — and GREEN on the project cells, which nobody had ever
   * seen because those cells were empty. Filling them put a bright green
   * project block next to two blue ones on a document that goes to a GC.
   *
   * Written as explicit ARGB rather than her palette INDEX. The template's
   * colors are all indexed and the .xls -> .xlsx conversion carried no
   * <indexedColors> palette with them, so every one of them is resolved against
   * whatever default the reader happens to use — which is how a block nobody
   * chose ended up green. An explicit color renders the same in Excel, Numbers
   * and Sheets and cannot drift when the template is next reconverted.
   */
  const HER_BLUE = { argb: "FF0000FF" }; // palette index 12 in her sample
  const HER_RED = { argb: "FFFF0000" }; // palette index 10 in her sample
  const fill = (lines: string[], cells: readonly string[], color: { argb: string }) => {
    const parts = lines.filter((p) => p.trim() !== "");
    const laid =
      parts.length <= cells.length
        ? parts
        : [parts[0], parts.slice(1, parts.length - 1).join(", "), parts[parts.length - 1]];
    cells.forEach((ref, i) => {
      const cell = g.getCell(ref);
      cell.value = laid[i] ?? null;
      // Single line per cell now, so no wrapping — wrapped text in a one-line
      // row is what made the old block unreadable.
      cell.alignment = { ...(cell.alignment ?? {}), wrapText: false, vertical: "top" };
      // Keep the template's face, size and weight; only the color is ours.
      cell.font = { ...(cell.font ?? {}), color: color };
    });
  };
  fill(input.ownerLabel.split("\n"), ["C5", "C6", "C7"], HER_BLUE);
  fill(input.projectLabel.split("\n"), ["E5", "E6", "E7"], HER_RED);
  fill(input.contractorLabel.split("\n"), ["C12", "C14", "C15"], HER_BLUE);
  // The cells the old layout used. Cleared, or the block appears twice.
  for (const ref of ["A4", "D4", "A11"]) g.getCell(ref).value = null;
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
  /*
   * LINE 8 IS THE NUMBER THE GC PAYS, and both forms pick it out in color —
   * hers in red, ours in green. Every other money cell on the sheet is black in
   * both. Same template-lineage drift as the project block, and the same fix:
   * take her sample's color, explicitly, so it does not depend on a palette the
   * file does not carry.
   */
  g.getCell("E40").font = { ...(g.getCell("E40").font ?? {}), color: HER_RED };

  // Change-order summary. Her form has this block and the old export wrote none
  // of it — it wasn't even in the cells the map said to fill. Split additions
  // from deductions, because that is what the two columns mean; a net figure in
  // the ADDITIONS column would be wrong on a job with a credit.
  /*
   * SPLIT BY WHEN EACH CHANGE ORDER WAS APPROVED, and foot to line 2.
   *
   * This block used to be derived from the G703 rows tagged as change orders,
   * which is a different population from the change orders that make up line 2
   * — so the cover sheet could contradict itself. Green Leaf App 5, measured
   * 2026-10-02: line 2 said $18,800.00 and this summary said $13,750.00, a
   * $5,050.00 disagreement on one page, on a document whose whole purpose is to
   * explain how the contract sum got where it is.
   *
   * It also put everything on the THIS MONTH row because the export had no
   * approval dates. It does now: `decided_at` is on every change order, and
   * Green Leaf's two were approved in July and on 22 September, which her form
   * wants on different lines.
   *
   * The split is by CALENDAR MONTH, because that is what her form asks for:
   * "Total changes approved in previous months by Owner" against "Total
   * approved this Month". Keying off `period_from` instead looks equivalent and
   * is not — Green Leaf App 5 runs 2026-09-23 to 2026-09-23, a single day, so a
   * change order approved on the 22nd of the same month fell into "previous"
   * and the THIS MONTH row read zero on a certificate that exists largely to
   * bill it.
   *
   * Measured against the period's own month (PERIOD TO, the date the
   * certificate carries). Strictly earlier month is previous; the same month or
   * later is this month, so a recent approval is never buried in a row the GC
   * reads as already-settled history. A CO with no approval date is previous —
   * it cannot be evidenced as belonging to this period. With no period recorded
   * at all, everything is previous rather than claiming this month's work.
   */
  const periodMark = input.application.period_to ?? input.application.period_from ?? null;
  const ym = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const periodYm = periodMark ? ym(new Date(periodMark)) : null;
  const isThisPeriod = (decidedAt: string | null): boolean => {
    if (!decidedAt || periodYm === null) return false;
    return ym(new Date(decidedAt)) >= periodYm;
  };
  /*
   * With no change orders supplied, line 2 still has to be EXPLAINED by the
   * rows above it — so the whole of it is reported as approved in previous
   * months. Leaving the buckets empty while forcing the net to line 2 made the
   * block not add up (D46 + D48 = 0 under a net of $8,000), which is the same
   * self-contradiction this change set out to remove. Caught by the footing
   * assertion, not by the one that only checked the net.
   */
  const cos =
    input.changeOrders && input.changeOrders.length > 0
      ? input.changeOrders
      : g702.netChangeOrdersCents !== 0
        ? [{ amountCents: g702.netChangeOrdersCents, decidedAt: null }]
        : [];
  const bucket = (want: boolean) => {
    const rows = cos.filter((c) => isThisPeriod(c.decidedAt) === want);
    return {
      add: rows.reduce((n, c) => n + Math.max(0, c.amountCents), 0),
      ded: rows.reduce((n, c) => n + Math.min(0, c.amountCents), 0),
    };
  };
  const prev = bucket(false);
  const now = bucket(true);
  /*
   * Line 2 carries sales tax on a taxable job while these raw amounts are
   * pre-tax (see resolveG702). Scaling both columns by the same factor keeps
   * each one's meaning and makes the block total exactly line 2 — which is the
   * invariant a GC's AP department checks. Every live job is capital-improvement
   * exempt, so the factor is 1 today and nothing moves.
   */
  const rawNet = prev.add + prev.ded + now.add + now.ded;
  const k = rawNet !== 0 ? g702.netChangeOrdersCents / rawNet : 1;
  const scaled = (n: number) => Math.round(n * k);
  const prevAdd = scaled(prev.add), prevDed = Math.abs(scaled(prev.ded));
  const nowAdd = scaled(now.add), nowDed = Math.abs(scaled(now.ded));
  money("D46", prevAdd);
  money("E46", prevDed);
  money("D48", nowAdd);
  money("E48", nowDed);
  money("D50", prevAdd + nowAdd);
  money("E50", prevDed + nowDed);
  // The net the GC reads, and it must equal line 2 to the cent.
  money("D51", g702.netChangeOrdersCents);

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
