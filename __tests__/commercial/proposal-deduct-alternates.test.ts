import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";

/**
 * Deduct alternates — an alternate that comes OFF the price.
 *
 * Stephanie 2026-10-08: "I need a option for deduct alternates that subtract
 * from the total, not add. Do I just put in a negative number?"
 *
 * The answer to her question was no, and that is the first thing asserted
 * here: both write paths refuse a negative unit price, so typing -2500 told
 * her the price was invalid and left her with nothing to try. The amount is
 * stored POSITIVE and a flag carries the direction, because a negative
 * `unit_price_cents` would push a sign through the proposal total, the G702
 * contract sum, the invoice and the change-order columns.
 */
void ExcelJS;

describe("the answer to what she actually asked", () => {
  const dbSrc = readFileSync("lib/commercial/proposals/db.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("still refuses a negative price, so a negative number is not the answer", () => {
    // Two guards — create and update. If either ever starts accepting one,
    // negative money is loose in the line items and this comment is a lie.
    const guards = dbSrc.match(/unit_price_cents < 0/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The direction is applied where an accepted alternate becomes money on the
 * job: the change order. Change orders already carry a sign —
 * netApprovedChangeOrderCents sums them signed and the G702 summary splits
 * additions from deductions — so a deduct flows through the contract sum, the
 * certificate and the invoice with nothing else needing to know.
 */
describe("accepting a deduct books a negative change order", () => {
  const pageSrc = readFileSync(
    "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx",
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("negates the amount for a deduct and leaves an add alone", () => {
    expect(pageSrc).toMatch(/is_deduct === true \? -Math\.abs\(magnitude\) : magnitude/);
  });

  it("offers the checkbox on alternates only", () => {
    // An inclusion that subtracts is just a lower price; offering it there
    // invites a line that silently reduces the contract with no alternate to
    // explain it.
    expect(pageSrc).toMatch(/isAlternate && \([\s\S]{0,400}name="is_deduct"/);
  });

  it("carries the flag onto a revision", () => {
    const bump = readFileSync(
      "app/commercial/accounts/[id]/deals/[dealId]/proposal/new/page.tsx",
      "utf8",
    );
    // A deduct that revised into an add would flip the sign of real money.
    expect(bump).toMatch(/is_deduct: item\.is_deduct/);
  });
});

describe("the proposal prints adds and deducts apart", () => {
  const pdfSrc = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("has its own heading, so a deduct never prints under Add Alternate", () => {
    expect(pdfSrc).toMatch(/Deduct Alternate:/);
    expect(pdfSrc).toMatch(/items\.filter\(\(i\) => i\.is_deduct === true\)/);
    expect(pdfSrc).toMatch(/items\.filter\(\(i\) => i\.is_deduct !== true\)/);
  });

  it("prints a deduct's money with a minus", () => {
    expect(pdfSrc).toMatch(/negatePrice \? "-" : ""/);
  });

  it("reads correctly before the migration is applied", () => {
    // Every row arrives without the column. `=== true` means nothing becomes a
    // deduct by accident, which would flip the sign of an existing alternate.
    expect(pdfSrc).not.toMatch(/i\.is_deduct \?/);
  });
});

/**
 * THE GLYPH, AND THE WORDING. Both of these looked right in the source and
 * were wrong on the page; both were found by rendering a proposal with a
 * deduct on it and reading the PDF.
 */
describe("a deduct reads as a deduct on the page", () => {
  const pdfSrc = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");

  it("uses an ASCII hyphen, because Times has no minus-sign glyph", () => {
    // U+2212 printed as nothing at all: "$3,200.00" under "Deduct Alternate:",
    // which reads as an add. Same trap as the bullets that came out as "Ï".
    expect(pdfSrc).not.toMatch(/negatePrice \? "−"/);
    expect(pdfSrc).toMatch(/negatePrice \? "-"/);
  });

  it("leaves alone the sanitiser that already strips U+2212 out of HER text", () => {
    /*
     * The codebase knew this before I did: everything typed into a proposal
     * runs through `transliterateToWinAnsi`, which maps the minus sign to an
     * ASCII hyphen among a dozen other characters Times cannot draw. A minus
     * we GENERATE is built after that has run, which is how this one reached
     * the page. Pinned so the sanitiser is not removed as redundant.
     */
    expect(pdfSrc).toMatch(/transliterateToWinAnsi|minus sign/);
  });

  it("says the tax comes OFF a deduct, not on", () => {
    // "+ $276.00 NYS Sales Tax = $3,476.00" under a deduct tells a GC the
    // number is going up, directly under a heading saying it goes down.
    expect(pdfSrc).toMatch(/const sign = deduct \? "-" : "\+"/);
    expect(pdfSrc).toMatch(/const totalText = \(deduct \? "-" : ""\)/);
  });
});

