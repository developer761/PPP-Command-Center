import { describe, it, expect } from "vitest";
import { groupedReportCsv } from "@/lib/commercial/reports/grouped/csv";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";
import { csvTitleBlock } from "@/lib/commercial/reports/export-guard";
import { arAgingCsv } from "@/lib/commercial/reports/ar-aging-csv";
import type { ArAging } from "@/lib/commercial/reports/ar-aging";
import { parseRange } from "@/lib/commercial/win-loss/range";
import { winLossCsv } from "@/lib/commercial/win-loss/export-csv";
import { summarizeWinLoss } from "@/lib/commercial/win-loss/reports";

/**
 * Four things a downloaded CSV said that the screen did not, each asserted on
 * the FILE — the bytes a spreadsheet opens — not on the code that builds it.
 *
 * Proven able to fail against the pre-fix builders (6a125921):
 *   · line endings: 2 of 9 lines CRLF in the grouped sheet → "mixed";
 *   · "1-30" is a date-shaped header → flagged;
 *   · the caveat row parsed to 1 cell against a 9-wide header;
 *   · the 1900 win/loss request produced no NOTE row.
 */

/** RFC-4180 enough for our own output: quoted fields, "" escapes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Each line terminator in the file, by kind. */
function lineEndings(text: string): { crlf: number; lf: number } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const all = (text.match(/\n/g) ?? []).length;
  return { crlf, lf: all - crlf };
}

describe("the grouped Accounting sheets use one line ending", () => {
  type R = { vendor: string; cents: number };
  const spec: ReportSpec<R> = {
    title: "Purchases",
    sourceLabel: "test",
    totals: [{ label: "Total spend", value: (rs) => rs.reduce((s, r) => s + r.cents, 0) }],
    groupings: [[{ key: "vendor", label: "Vendor", of: (r) => r.vendor }]],
    columns: [
      { key: "vendor", label: "Vendor", text: (r) => r.vendor },
      { key: "amount", label: "Amount", kind: "money", amount: (r) => r.cents },
    ],
  };
  const rows: R[] = [
    { vendor: "Sherwin-Williams", cents: 12_345 },
    { vendor: "Sherwin-Williams", cents: -1_469 },
    { vendor: "Home Depot", cents: 9_900 },
  ];

  it("title block + body is CRLF on every line", () => {
    // What csvResponse actually sends: the title block prepended to the body.
    const file = csvTitleBlock("Purchases by vendor", "all time") + groupedReportCsv(spec, rows);
    const e = lineEndings(file);
    expect(e.crlf).toBeGreaterThan(5);
    expect(e.lf).toBe(0);
    // And it still parses to the figures it is meant to carry.
    const parsed = parseCsv(file);
    const total = parsed.find((r) => r[0].startsWith("TOTAL ("));
    expect(total?.[2]).toBe("207.76");
  });
});

describe("the AR Aging sheet", () => {
  const aging: ArAging = {
    rows: [
      { accountId: "a1", accountName: "Vision GC", current: 17_000, d1_30: 50_000, d31_60: 0, d61_90: 0, d90_plus: 0, total: 67_000, invoiceCount: 3, oldestDays: 12 },
    ],
    totals: { current: 17_000, d1_30: 50_000, d31_60: 0, d61_90: 0, d90_plus: 0, total: 67_000 },
    invoiceCount: 3,
    customerCount: 1,
    weightedAvgAgeDays: 9,
    noDueDateCents: 17_000,
    noDueDateCount: 2,
  };
  const parsed = parseCsv(arAgingCsv(aging)).filter((r) => r.some((c) => c !== ""));
  const header = parsed[0];

  it("has no header Excel would turn into a date", () => {
    // `1-30` → 30-Jan in Excel. Any `n-n` or `n/n` label is that trap.
    const dateShaped = header.filter((h) => /^\d{1,2}[-/]\d{1,2}$/.test(h));
    expect(dateShaped).toEqual([]);
    expect(header).toContain("1-30 days");
  });

  it("pads the caveat row to the sheet's width and prints its money as money", () => {
    const note = parsed.find((r) => r[0].startsWith("NOTE:"));
    expect(note).toBeDefined();
    expect(note!.length).toBe(header.length);
    expect(note![0]).toContain("$170.00 across 2 open items");
    // Every data row is the same width too.
    for (const r of parsed) expect(r.length).toBe(header.length);
  });

  it("has no caveat row when every item has a due date", () => {
    const clean = parseCsv(arAgingCsv({ ...aging, noDueDateCents: 0, noDueDateCount: 0 }));
    expect(clean.some((r) => r[0].startsWith("NOTE:"))).toBe(false);
  });
});

describe("the win / loss export says when it ignored the range asked for", () => {
  const empty = { summary: summarizeWinLoss([]), records: [], competitors: [], factors: [], lessons: [] };

  it("a rejected custom range leaves a NOTE naming both windows", () => {
    const asked = { from: "1900-01-01", to: "1900-01-02" };
    const range = parseRange(asked);
    expect(range.rejected).toBe(true);
    const rows = parseCsv(winLossCsv({ range, asked, ...empty }));
    const note = rows.find((r) => r[0].startsWith("NOTE:"));
    expect(note?.[0]).toContain("1900-01-01 to 1900-01-02");
    expect(note?.[0]).toContain(range.label);
  });

  it("an accepted range prints no NOTE", () => {
    const asked = { from: "2026-07-01", to: "2026-09-30" };
    const range = parseRange(asked);
    expect(range.rejected).toBe(false);
    const rows = parseCsv(winLossCsv({ range, asked, ...empty }));
    expect(rows.some((r) => r[0].startsWith("NOTE:"))).toBe(false);
    expect(lineEndings(winLossCsv({ range, asked, ...empty })).lf).toBe(0);
  });
});
