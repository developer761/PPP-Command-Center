import { describe, it, expect } from "vitest";
import { parsePastedAmounts } from "@/lib/commercial/field-ops/paste-amounts";

/**
 * What actually lands on the clipboard when somebody copies a column out of
 * Gusto — which is never as tidy as "one number per line".
 *
 * The rule throughout: anything unreadable comes back as an unparsed LINE, not
 * as zero. Zero is a real figure — it clears "no cost entered" and lets a week
 * post with somebody costed at nothing — which is the bug this codebase
 * shipped and fixed earlier the same day in `dollarsToCents`.
 */
describe("a column pasted out of Gusto", () => {
  it("reads a plain column", () => {
    const { cents, unreadable } = parsePastedAmounts("1150.00\n1104.00\n902.00");
    expect(cents).toEqual([115_000, 110_400, 90_200]);
    expect(unreadable).toEqual([]);
  });

  it("copes with currency symbols and thousands separators", () => {
    // A comma inside 1,040.00 is a separator, not a column break.
    expect(parsePastedAmounts("$1,040.00\n$26,000.00").cents).toEqual([104_000, 2_600_000]);
  });

  it("takes the LAST number when a whole row is pasted", () => {
    // Spreadsheets copy the row, not the cell: name, hours, then the money.
    const { cents } = parsePastedAmounts("Greg Stankewicz\t40.00\t1,150.00\nJJ Lucatorto\t32\t520.00");
    expect(cents).toEqual([115_000, 52_000]);
  });

  it("reads a row with no tabs, money on the end", () => {
    expect(parsePastedAmounts("Greg Stankewicz 1,150.00").cents).toEqual([115_000]);
  });

  it("skips blank lines rather than counting them", () => {
    // A trailing newline is not a person.
    const { cents, unreadable } = parsePastedAmounts("520.00\n\n  \n260.00\n");
    expect(cents).toEqual([52_000, 26_000]);
    expect(unreadable).toEqual([]);
  });

  it("reads accounting parentheses and minus signs as negative", () => {
    // On a payroll report these mean a deduction. Reading (500) as 500 would
    // be worse than refusing the line.
    expect(parsePastedAmounts("(500.00)\n-250.00").cents).toEqual([-50_000, -25_000]);
  });

  it("returns the LINE for anything it cannot read, never a zero", () => {
    const { cents, unreadable } = parsePastedAmounts("1150.00\nN/A\npending\n902.00");
    expect(cents).toEqual([115_000, 90_200]);
    expect(unreadable).toEqual(["N/A", "pending"]);
    expect(cents).not.toContain(0);
  });

  it("refuses a figure large enough to overflow the column", () => {
    const { cents, unreadable } = parsePastedAmounts("99999999999999999999");
    expect(cents).toEqual([]);
    expect(unreadable).toHaveLength(1);
  });

  it("handles an empty paste without inventing rows", () => {
    expect(parsePastedAmounts("")).toEqual({ cents: [], unreadable: [] });
    expect(parsePastedAmounts("   \n\n")).toEqual({ cents: [], unreadable: [] });
  });

  it("keeps a genuine zero, which is different from unreadable", () => {
    // Somebody who was paid nothing this week is a real answer; the screen can
    // then decide what to do with it. "N/A" is not.
    expect(parsePastedAmounts("0.00").cents).toEqual([0]);
  });
});
