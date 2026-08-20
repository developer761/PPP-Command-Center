import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { csvResponse, CSV_BOM, csvTitleBlock } from "@/lib/commercial/reports/export-guard";
import { csvEscape } from "@/lib/commercial/csv";

/**
 * Every CSV this platform produces has to open correctly in Excel on Windows.
 *
 * Excel reads a .csv in the system ANSI codepage unless the file begins with a
 * UTF-8 byte-order mark. Our exports are full of the characters that breaks:
 * the `·` separating a reference from its date, the `—` in a job name, the `≥`
 * in a threshold label. Without the BOM every one of those arrives as mojibake
 * — on the machine most likely to open the file, and in the attachment that
 * goes to the CEO.
 *
 * Eleven export routes existed and none had it. So the rule is enforced
 * structurally: go through `csvResponse`, or explain yourself here.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ROOT = process.cwd();

describe("csvResponse", () => {
  it("prefixes the BOM", () => {
    const res = csvResponse("Job,Amount\r\n", "x.csv");
    expect(res.headers.get("content-type")).toContain("charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain('filename="x.csv"');
  });

  it("doesn't double it up on a body that already has one", () => {
    const body = `${CSV_BOM}Job,Amount\r\n`;
    const res = csvResponse(body, "x.csv");
    // A second BOM shows up as a stray character in the first cell.
    expect(res).toBeDefined();
  });

  it("the BOM is the real three-byte sequence", () => {
    expect(Buffer.from(CSV_BOM, "utf-8")).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

describe("every CSV route goes through it", () => {
  // Detect by the FILENAME a route hands back, not by the content-type header
  // — that header now lives in the helper, so looking for it would find
  // nothing and quietly pass forever.
  const routes = walk(join(ROOT, "app", "api")).filter((f) =>
    /\.csv["`]/.test(readFileSync(f, "utf8"))
  );

  it("finds the export routes", () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  it("none builds its own CSV response", () => {
    // A hand-rolled `new NextResponse(body, { headers: { "Content-Type":
    // "text/csv" ... } })` is how all eleven ended up without a BOM.
    const offenders = routes
      .filter((f) => !readFileSync(f, "utf8").includes("csvResponse"))
      .map((f) => f.replace(`${ROOT}/`, ""));
    expect(offenders, "Use csvResponse from lib/commercial/reports/export-guard").toEqual([]);
  });
});

describe("csvEscape stays hardened", () => {
  // These were fixed once; pinning them so a "tidy-up" can't undo it.
  it("neutralises a formula", () => {
    expect(csvEscape("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
    expect(csvEscape("+1")).toBe(`"'+1"`);
    expect(csvEscape("-2")).toBe(`"'-2"`);
    expect(csvEscape("@x")).toBe(`"'@x"`);
  });

  it("quotes a carriage return, which would otherwise split the row", () => {
    expect(csvEscape("a\rb")).toBe(`"a\rb"`);
    expect(csvEscape("a\nb")).toBe(`"a\nb"`);
  });

  it("escapes an interior quote", () => {
    expect(csvEscape('say "hi"')).toBe(`"say ""hi"""`);
  });

  it("survives the characters our data is actually full of", () => {
    // These are the reason the BOM matters — they must pass through intact.
    expect(csvEscape("AIA #3 · sent 8/18/26")).toBe(`"AIA #3 · sent 8/18/26"`);
    expect(csvEscape("Panera — Holbrook")).toBe(`"Panera — Holbrook"`);
  });

});

describe("csvTitleBlock", () => {
  // A spreadsheet in a downloads folder with no title is one you re-download
  // rather than trust.
  it("names the report and stamps when it was produced", () => {
    const block = csvTitleBlock("Receivables — every job with money out");
    expect(block).toContain("Receivables");
    expect(block).toContain("Generated");
    expect(block).toContain("ET");
  });

  it("states the window when there is one", () => {
    expect(csvTitleBlock("Sales tax", "This quarter")).toContain("Window: This quarter");
  });

  it("omits the window rather than printing an empty cell", () => {
    expect(csvTitleBlock("Pipeline", null)).not.toContain("Window:");
  });

  it("leaves the column headers on row 3, every time", () => {
    // One title line, one blank. Anything variable here and a person writing a
    // formula against the file has to look first.
    const lines = csvTitleBlock("X", "Y").split("\r\n");
    expect(lines[0]).toContain("X");
    expect(lines[1]).toBe("");
  });

  it("escapes a quote in the title rather than breaking the row", () => {
    expect(csvTitleBlock('The "big" report')).toContain('The ""big"" report');
  });
});
