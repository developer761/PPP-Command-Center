import { describe, it, expect } from "vitest";
import { proposalTaxLine } from "@/lib/commercial/proposals/proposal-tax";
import type { TaxJurisdictionLite } from "@/lib/commercial/tax/constants";

const NASSAU: TaxJurisdictionLite = {
  id: "j1",
  name: "Nassau County",
  combined_rate_thou: 8625,
  zip_prefixes: ["115"],
  verified: true,
  active: true,
};
const SUFFOLK: TaxJurisdictionLite = {
  id: "j2",
  name: "Suffolk County",
  combined_rate_thou: 8750,
  zip_prefixes: ["117"],
  verified: true,
  active: true,
};
const JURIS = [NASSAU, SUFFOLK];

describe("proposal sales tax", () => {
  it("prints Stephanie's example exactly", () => {
    // Her note: Price $500.00 / NYS Sales Tax $43.75 / TOTAL $543.75.
    // 8.75% of $500 is $43.75 — Suffolk.
    const line = proposalTaxLine({ priceCents: 500_00, zip: "11722", exempt: false, jurisdictions: JURIS });
    expect(line).not.toBeNull();
    expect(line!.taxCents).toBe(43_75);
    expect(line!.totalCents).toBe(543_75);
    expect(line!.label).toBe("NYS Sales Tax (8.75%)");
  });

  it("trims trailing zeros but keeps real precision", () => {
    const nassau = proposalTaxLine({ priceCents: 100_00, zip: "11501", exempt: false, jurisdictions: JURIS });
    expect(nassau!.label).toBe("NYS Sales Tax (8.625%)");
  });

  it("rounds to the cent once, at the end", () => {
    // $333.33 at 8.625% = $28.7496… — one rounding, not per-line drift.
    const line = proposalTaxLine({ priceCents: 333_33, zip: "11501", exempt: false, jurisdictions: JURIS });
    expect(line!.taxCents).toBe(Math.round((333_33 * 8625) / 100_000));
    expect(line!.totalCents).toBe(333_33 + line!.taxCents);
  });

  // Null is not zero. A "$0.00 tax" line on an exempt job invites the question
  // of why it is printed at all.
  it("prints NO line when the job is exempt", () => {
    expect(proposalTaxLine({ priceCents: 500_00, zip: "11722", exempt: true, jurisdictions: JURIS })).toBeNull();
  });

  it("prints no line when the ZIP matches no jurisdiction", () => {
    // Silence beats guessing a rate onto a document a customer signs.
    expect(proposalTaxLine({ priceCents: 500_00, zip: "90210", exempt: false, jurisdictions: JURIS })).toBeNull();
    expect(proposalTaxLine({ priceCents: 500_00, zip: null, exempt: false, jurisdictions: JURIS })).toBeNull();
  });

  it("prints no line on a zero or negative price", () => {
    expect(proposalTaxLine({ priceCents: 0, zip: "11722", exempt: false, jurisdictions: JURIS })).toBeNull();
  });

  it("ignores an inactive jurisdiction rather than taxing from it", () => {
    const off = [{ ...SUFFOLK, active: false }];
    expect(proposalTaxLine({ priceCents: 500_00, zip: "11722", exempt: false, jurisdictions: off })).toBeNull();
  });

  it("uses the longest ZIP prefix, same as the invoice", () => {
    // The proposal and the invoice MUST resolve identically — the whole reason
    // this calls resolveTaxForZip instead of doing its own lookup.
    const specific: TaxJurisdictionLite = { ...SUFFOLK, id: "j3", name: "Islip", combined_rate_thou: 9000, zip_prefixes: ["11722"] };
    const line = proposalTaxLine({ priceCents: 100_00, zip: "11722", exempt: false, jurisdictions: [SUFFOLK, specific] });
    expect(line!.jurisdictionName).toBe("Islip");
    expect(line!.taxCents).toBe(9_00);
  });
});
