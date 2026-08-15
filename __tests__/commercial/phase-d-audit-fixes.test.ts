import { describe, it, expect } from "vitest";
import { csvEscape } from "@/lib/commercial/csv";
import { weeklyExportedRows } from "@/lib/commercial/field-ops/payroll";
import { transliterateToWinAnsi } from "@/lib/commercial/proposals/pdf";
import { taxHeadsUpFor } from "@/lib/commercial/change-orders/db";

/**
 * Regression tests for the Phase D parallel re-audit fixes.
 *
 * Each block pins a specific defect the audit found, so the same bug can't
 * come back quietly. Only the genuinely pure logic is covered here — the
 * DB-bound fixes (AIA seed guard, invoice status reconcile, storage-key
 * ownership) are asserted by reading, not by unit test.
 */

describe("csvEscape — the one hardened escaper (was 7 copies, 5 of them weak)", () => {
  it("neutralizes formula injection on every OWASP trigger character", () => {
    // The payroll CSV leaves the building for an outside payroll processor, so
    // a crew display name starting with any of these must not execute on open.
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const out = csvEscape(`${lead}cmd|'/c calc'!A1`);
      expect(out.startsWith(`"'${lead}`)).toBe(true);
    }
  });

  it("quotes a carriage return so an interior CR can't split one row into two", () => {
    // Lines are joined with \r\n; the old regex only triggered on [",\n], so a
    // pasted-from-Excel name with an interior CR shifted every later column.
    const out = csvEscape("Ruiz\rJose");
    expect(out).toBe('"Ruiz\rJose"'); // always quoted, CR preserved inside the field
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("renders null/undefined as an empty quoted field, not the string 'null'", () => {
    expect(csvEscape(null)).toBe('""');
    expect(csvEscape(undefined)).toBe('""');
  });

  it("leaves an ordinary name untouched apart from quoting", () => {
    expect(csvEscape("Jose Ruiz")).toBe('"Jose Ruiz"');
  });
});

describe("weeklyExportedRows — payroll re-download must not re-pay a prior week", () => {
  const meta = new Map([["e1", { name: "Jose Ruiz", external_ref: "R-1" }]]);

  it("splits overtime at 40h per week, not across the whole range", () => {
    // Two sub-40h weeks must stay regular time. Summing the range and capping
    // at 40 invented 30h of overtime that the original CSV never paid.
    const rows = weeklyExportedRows(
      [
        { employee_id: "e1", work_date: "2026-08-03", actual_hours: 35 }, // wk of Aug 3
        { employee_id: "e1", work_date: "2026-08-10", actual_hours: 35 }, // wk of Aug 10
      ],
      meta
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reg).toBe(70);
    expect(rows[0].ot).toBe(0);
    expect(rows[0].total).toBe(70);
  });

  it("credits overtime once a single week crosses 40h", () => {
    const rows = weeklyExportedRows(
      [{ employee_id: "e1", work_date: "2026-08-03", actual_hours: 50 }],
      meta
    );
    expect(rows[0].reg).toBe(40);
    expect(rows[0].ot).toBe(10);
  });

  it("uses the prior-pass baseline so a week paid across two passes doesn't restart at zero", () => {
    // THE FIX. An earlier pass already paid 38h of this week. The second pass
    // pays 6 more: 2h finish out regular time, 4h are overtime. Without the
    // baseline the 6h all read as regular — paying straight time for overtime,
    // and re-crediting the first 40h that was already paid.
    const rows = weeklyExportedRows(
      [{ employee_id: "e1", work_date: "2026-08-05", actual_hours: 6 }],
      meta,
      [{ employee_id: "e1", work_date: "2026-08-03", actual_hours: 38 }]
    );
    expect(rows[0].reg).toBe(2);
    expect(rows[0].ot).toBe(4);
    expect(rows[0].total).toBe(6); // only the marginal hours are paid
  });

  it("pays nothing when the baseline already covers the week", () => {
    const rows = weeklyExportedRows(
      [],
      meta,
      [{ employee_id: "e1", work_date: "2026-08-03", actual_hours: 40 }]
    );
    expect(rows).toHaveLength(0);
  });
});

describe("transliterateToWinAnsi — PDF text must survive Helvetica/WinAnsi", () => {
  it("maps U+2212 MINUS to an ASCII hyphen", () => {
    // WinAnsi has no slot for U+2212, so pdfkit emitted the raw code point and
    // a credit change order printed as `"$500.00` (0x22 = quotedbl).
    expect(transliterateToWinAnsi("−$500.00")).toBe("-$500.00");
  });

  it("maps prime and double-prime marks pasted from GC specs", () => {
    expect(transliterateToWinAnsi("6″ CMU at 8′ height")).toBe('6" CMU at 8\' height');
  });

  it("maps non-breaking hyphen, non-breaking space, and math symbols", () => {
    expect(transliterateToWinAnsi("A‑B")).toBe("A-B");
    expect(transliterateToWinAnsi("10 ft")).toBe("10 ft");
    expect(transliterateToWinAnsi("≤ 5")).toBe("<= 5");
    expect(transliterateToWinAnsi("2 × 4")).toBe("2 x 4");
  });

  it("leaves ordinary text and WinAnsi-safe punctuation alone", () => {
    // The em dash IS in WinAnsi (0x97) — don't mangle it.
    expect(transliterateToWinAnsi("Paint — two coats")).toBe("Paint — two coats");
  });
});

describe("taxHeadsUpFor — a 0% draft must say WHY it's 0%", () => {
  it("warns when the job's ZIP matches no jurisdiction", () => {
    expect(taxHeadsUpFor("unmatched_zip")).toMatch(/doesn't match any tax jurisdiction/i);
  });

  it("warns when the job has no ZIP at all", () => {
    expect(taxHeadsUpFor("no_zip")).toMatch(/no property ZIP/i);
  });

  it("stays silent when the customer is genuinely exempt", () => {
    // Exempt is a decision somebody made — not a silent under-collection.
    expect(taxHeadsUpFor("exempt")).toBeNull();
  });

  it("stays silent when a real rate was resolved", () => {
    expect(taxHeadsUpFor("rate")).toBeNull();
  });
});
