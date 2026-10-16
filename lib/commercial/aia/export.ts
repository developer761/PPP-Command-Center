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
import {
  lineCompletedStoredCents,
  lineRetainableCompletedCents,
  lineRetainageCents,
  type AiaG702,
} from "./constants";
import { aiaTemplateBuffer } from "./template/template-b64";
import { etDateOf } from "@/lib/date-et";

const MONEY = '#,##0.00;(#,##0.00)';
const d = (cents: number) => cents / 100;

/** Sheet names carry a trailing space on the G703 — hers does, and a GC's AP
 *  system or her own copy-paste may key off it. Matched exactly. */
const SHEET_G702 = "Loan G-702";
const SHEET_G703 = "G-703 Total Hard Cost ";

/** The template's line-item slots and its grand-total row. */
/** The blank spacer row on her G702 between line 9 and CHANGE ORDER SUMMARY,
 *  used only to explain a retainage figure the header rate cannot account for. */
const RELEASE_NOTE_CELL = "A43";
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

  /*
   * A DATE CELL NEVER KEEPS THE TEMPLATE'S =TODAY().
   *
   * Her workbook computes three dates for itself — G702!I7 "PERIOD TO",
   * G703!I3 "APPLICATION DATE", G703!I4 "PERIOD TO" — and all three writes
   * used to sit behind `if (periodTo)`. On an application with no period_to
   * the formula therefore SURVIVED into the exported file, so the certificate
   * re-dated itself to whatever day it was opened. Four live applications are
   * affected and two of them are PAID: a paid certificate is a settled record,
   * and one whose date moves every time a GC's AP department reopens it is
   * evidence of nothing. (Measured 2026-10-16: three TODAY() formulas in the
   * exported sheet XML of apps #1, #2, #3 and #5.)
   *
   * Setting the cell to null genuinely removes the formula — verified by
   * reading the written sheet XML back, not by trusting exceljs's API. So the
   * rule is: always write, and write null when there is nothing true to say.
   *
   * WHAT GOES IN WHEN THERE IS NO PERIOD, per cell, because they ask different
   * questions:
   *
   *  · PERIOD TO is a claim about what was billed. With no period recorded,
   *    any date put there invents a billing period — on a PAID certificate
   *    that is a false statement, and a freeze date would read as one. So it
   *    goes BLANK: a blank period on a certificate that has none is honest and
   *    visibly incomplete, which is what it is.
   *
   *  · APPLICATION DATE is a claim about the DOCUMENT, and the document always
   *    has one. `frozen_at` is the instant the certificate was issued and
   *    stopped being editable — fixed, already recorded, and exactly what this
   *    cell means. A draft that was never frozen falls back to `created_at`.
   *    Either way it is a date that cannot move.
   *
   * Taken as the ET calendar day, matching every other date on the platform —
   * a certificate frozen at 9pm ET must not print tomorrow's date.
   */
  const certIso = etDateOf(app.frozen_at) ?? etDateOf(app.created_at);
  const certificateDate = certIso ? new Date(certIso) : null;

  const dateCell = (sheet: ExcelJS.Worksheet, ref: string, value: Date | null) => {
    const c = sheet.getCell(ref);
    // Unconditional: assigning null is what clears the template's =TODAY().
    c.value = value;
    if (value) c.numFmt = "mm/dd/yyyy";
  };

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
  /*
   * TAKES THE WHOLE LABEL AND DOES ITS OWN SPLITTING.
   *
   * It used to be handed `label.split("\n")` by each call site, which could
   * only ever see the separator header-labels joins WITH — so a line break
   * living INSIDE one of the fields (20 live accounts keep the suite on a
   * second line of `billing_street`, CRLF from the Salesforce import) came
   * through as a bare "\r" riding on the end of a part. These cells are
   * `wrapText: false`, so it drew as a control glyph on the certificate, and
   * the extra part pushed a three-part block to four against three cells —
   * the overflow branch below then merged the middles into
   * "1998 Springdale Road⏎, Suite 101".
   *
   * header-labels normalises now, so in practice the label arrives clean. This
   * splits on every line-break form and strips each part anyway: it is the
   * last thing between a stored address and a document a GC signs, and the
   * trailing-comma strip means the ", " the overflow branch inserts can never
   * land next to one the data already had.
   */
  const fill = (label: string, cells: readonly string[], color: { argb: string }) => {
    const parts = (label ?? "")
      .split(/\r\n|\r|\n/)
      .map((p) => p.replace(/\s+/g, " ").replace(/[\s,]+$/, "").trim())
      .filter(Boolean);
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
  fill(input.ownerLabel, ["C5", "C6", "C7"], HER_BLUE);
  fill(input.projectLabel, ["E5", "E6", "E7"], HER_RED);
  fill(input.contractorLabel, ["C12", "C14", "C15"], HER_BLUE);
  // The cells the old layout used. Cleared, or the block appears twice.
  for (const ref of ["A4", "D4", "A11"]) g.getCell(ref).value = null;
  g.getCell("I4").value = app.application_number;
  dateCell(g, "I7", periodTo); // PERIOD TO:

  money("E24", g702.originalContractCents);
  money("E25", g702.netChangeOrdersCents);
  money("E26", g702.contractSumToDateCents);
  money("E27", g702.totalCompletedStoredCents);

  // 5a is retainage on completed work (G703 columns D+E); 5b is the remainder,
  // so 5a + 5b is exactly line 5 and the sheet foots however the split falls.
  g.getCell("B30").value = pct;
  // Retainable, not completed: once a release application has gone out, the
  // work it released is not withheld again, and 5a has to come off the same
  // base G702 line 5 does or 5b (its remainder) goes NEGATIVE on the sheet.
  const completedDE = lines.reduce((n, l) => n + lineRetainableCompletedCents(l), 0);
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
  dateCell(s, "I3", periodTo ?? certificateDate); // APPLICATION DATE:
  dateCell(s, "I4", periodTo); // PERIOD TO:
  s.getCell("J10").value = pct / 100;

  /*
   * SAY SO WHEN COLUMN J IS NOT pct × COLUMN G.
   *
   * Once an earlier application released the retainage, this sheet withholds
   * only on work that release did not cover — so the rate in the header is the
   * contract's rate and the column beneath it is $0.00 on every released line.
   * Right, and baffling to a GC's accounts payable clerk reading one against
   * the other with nothing on the page to account for it.
   *
   * Written on the G702, in the blank spacer row between line 9 and the CHANGE
   * ORDER SUMMARY (row 43 of her form, empty across A–J), rather than onto the
   * G703: the continuation sheet's 22 line slots are hers and inserting a row
   * would push its totals off the form. Not wrapped and not merged — at 8pt it
   * runs across the empty cells to its right, which is what her layout does
   * everywhere else, and a merge would change the print area.
   */
  const releasedCents = lines.reduce(
    (n, l) => n + Math.round((l as { retainage_released_cents?: number }).retainage_released_cents ?? 0),
    0
  );
  if (releasedCents > 0 && pct > 0) {
    const note = g.getCell(RELEASE_NOTE_CELL);
    note.value =
      `Retainage withheld on new work only — ${d(releasedCents).toLocaleString("en-US", { style: "currency", currency: "USD" })} ` +
      `released on an earlier application; ${pct}% applies to the balance billed since.`;
    note.font = { ...(note.font ?? {}), italic: true, size: 8 };
  }

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
    // The SHARED per-line rule — this column is what G702 line 5 sums, so it
    // has to honour an earlier release exactly as line 5 does.
    const ret = lineRetainageCents(l, pct);
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
