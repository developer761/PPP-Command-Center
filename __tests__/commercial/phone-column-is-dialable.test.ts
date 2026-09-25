import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatUsPhone } from "@/lib/commercial/format-phone";

/**
 * THE TWO COLUMNS THE PIPELINE REPORT EXISTS FOR WERE PLAIN TEXT.
 *
 * Its own blurb says Brendan works down this list, and the module's docblock
 * says "the phone and email columns are the point of it". Every other surface
 * that shows a contact — the account page, the project team card — dials and
 * mails from it. Here you had to copy the number out, on a phone as much as on
 * a desk.
 *
 * And the numbers arrive however they were typed, so the column ran
 * "631-224-8894" down to "5165236737" and back. A column read down at speed
 * with one row in a different shape is where a misdial comes from.
 */

describe("formatUsPhone", () => {
  it("gives ten digits one shape, however they arrived", () => {
    for (const raw of ["5165236737", "(516) 523-6737", "516.523.6737", "516 523 6737"]) {
      expect(formatUsPhone(raw)).toBe("516-523-6737");
    }
  });

  it("drops a leading US country code", () => {
    expect(formatUsPhone("1-631-224-8894")).toBe("631-224-8894");
    expect(formatUsPhone("16312248894")).toBe("631-224-8894");
  });

  it("leaves what it doesn't recognise exactly as stored", () => {
    // Inventing a shape for a number this doesn't understand is worse than
    // leaving it: a reader can see an odd number and check it, and cannot see
    // a tidy one that is wrong.
    for (const raw of [
      "631-224-8894 x12",
      "+44 20 7946 0958",
      "ask Erika",
      "631-224-8894/8895",
    ]) {
      expect(formatUsPhone(raw)).toBe(raw);
    }
  });

  it("is empty, not the string 'null', when there is no number", () => {
    expect(formatUsPhone(null)).toBe(null);
    expect(formatUsPhone(undefined)).toBe(null);
    expect(formatUsPhone("   ")).toBe(null);
  });

  it("does not mangle a number it has already formatted", () => {
    // These columns re-render on every request; a formatter that is not
    // idempotent drifts a digit at a time.
    expect(formatUsPhone(formatUsPhone("5165236737"))).toBe("516-523-6737");
  });
});

const ROOT = process.cwd();
const src = readFileSync(
  join(ROOT, "lib/commercial/reports/tomco/opportunities.ts"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const balanceOwed = readFileSync(
  join(ROOT, "lib/commercial/reports/tomco/balance-owed.ts"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the contact columns are clickable", () => {
  /**
   * Every report that puts a GC's number next to money. Leaving one as plain
   * text would make the odd one out the one you chase from — and an
   * inconsistency you introduce while fixing the others is worse than the
   * original, because now the shape of the column means nothing.
   */
  it("all three reports dial the phone", () => {
    const tel = /href:\s*\(r\) => \(r\.phone \? `tel:/g;
    // Pipeline Manager and Scheduling live in one module; Balance Owed in its
    // own.
    expect((src.match(tel) ?? []).length).toBe(2);
    expect((balanceOwed.match(tel) ?? []).length).toBe(1);
  });

  it("Balance Owed formats its column too", () => {
    expect(balanceOwed).toMatch(/text:\s*\(r\) => formatUsPhone\(r\.phone\)/);
    expect(balanceOwed).toMatch(/csvText:\s*\(r\) => r\.phone/);
  });

  it("dials the raw digits, not the formatted string", () => {
    // Formatting is for the eye. A dialler should never be handed a guess
    // about what the punctuation meant.
    expect(src).toMatch(/tel:\$\{r\.phone\.replace\(\/\[\^0-9\+\]\/g, ""\)\}/);
    expect(src).not.toMatch(/tel:\$\{formatUsPhone/);
  });

  it("mails the email", () => {
    expect(src).toMatch(/href:\s*\(r\) => \(r\.email \? `mailto:\$\{r\.email\}`/);
  });

  it("exports the number as stored, not as displayed", () => {
    // A spreadsheet gets the raw value; re-formatting into a CSV loses what
    // was actually recorded.
    expect((src.match(/csvText:\s*\(r\) => r\.phone/g) ?? []).length).toBe(2);
  });
});

describe("a tel: link does not go through the router", () => {
  const cell = readFileSync(
    join(ROOT, "components/commercial/grouped-report.tsx"),
    "utf8",
  ).replace(/\/\/.*$/gm, "");

  it("uses a plain anchor for anything that is not an in-app path", () => {
    // Next's Link is for routes. `tel:` and `mailto:` belong to the OS.
    expect(cell).toMatch(/!href\.startsWith\("\/"\)/);
  });
});
