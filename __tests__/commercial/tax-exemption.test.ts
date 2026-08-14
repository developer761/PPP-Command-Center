import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveTaxExemption,
  isTaxExempt,
  taxExemptionNote,
} from "@/lib/commercial/tax/exemption";

/**
 * Per-job tax exemption.
 *
 * Stephanie 2026-08-13: *"tax exemption follows opportunity not account."* In
 * New York an exemption certificate is issued for a PROJECT, so the same GC
 * can be exempt on a municipal job and taxable on the private one next door.
 */

describe("resolveTaxExemption", () => {
  it("inherits the account when the job says nothing", () => {
    // Today's behaviour, and the reason the column is nullable: every existing
    // opportunity must keep billing exactly as it did.
    expect(resolveTaxExemption({ opportunityTaxExempt: null, accountTaxExempt: true })).toEqual({
      exempt: true,
      source: "account",
    });
    expect(resolveTaxExemption({ accountTaxExempt: false })).toEqual({
      exempt: false,
      source: "account",
    });
  });

  it("the job wins when it is set", () => {
    expect(isTaxExempt({ opportunityTaxExempt: true, accountTaxExempt: false })).toBe(true);
  });

  it("a job can be TAXABLE for an otherwise-exempt customer", () => {
    // The case that makes `false` a real answer rather than an absence. If
    // this ever reads as "unset", an exempt customer's taxable job silently
    // bills at 0% and Tomco eats the tax.
    expect(resolveTaxExemption({ opportunityTaxExempt: false, accountTaxExempt: true })).toEqual({
      exempt: false,
      source: "opportunity",
    });
  });

  it("charges tax when nothing is on file", () => {
    // Under-charging is money Tomco pays itself; a missing record must not
    // silently make a job exempt.
    expect(resolveTaxExemption({})).toEqual({ exempt: false, source: "default" });
  });

  it("says which record decided, so nobody has to guess", () => {
    expect(taxExemptionNote({ exempt: true, source: "opportunity" })).toContain("this job");
    expect(taxExemptionNote({ exempt: true, source: "account" })).toContain("customer");
    expect(taxExemptionNote({ exempt: false, source: "opportunity" })).toContain("overriding");
  });
});

describe("every tax path uses the shared rule", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

  it("no path reads tax_exempt off the account directly any more", () => {
    // The answer used to be computed in three places, and the comment in the
    // first says what that cost: the change-order path "computed tax from the
    // ZIP alone and auto-created drafts charging an exempt GC sales tax".
    // Adding a per-job override to three copies would repeat it exactly.
    for (const f of ["lib/commercial/invoices/db.ts", "lib/commercial/change-orders/db.ts"]) {
      const src = read(f);
      expect(src, `${f} should call isTaxExempt`).toContain("isTaxExempt(");
      expect(src, `${f} still derives exemption itself`).not.toMatch(
        /Boolean\(\s*\(acct as \{ tax_exempt/
      );
    }
  });

  it("the invoice EDIT path selects the job's override too", () => {
    // Same trap, second location — missed on the first pass. Any select whose
    // result is read for opportunity_id must actually ask for it.
    const src = read("lib/commercial/invoices/db.ts");
    for (const m of src.matchAll(/\.from\("commercial_invoices"\)[\s\S]{0,400}?\.select\("([^"]+)"\)/g)) {
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 700);
      if (!after.includes("opportunity_id")) continue;
      // `select("*")` returns every column, so it is fine.
      if (m[1].trim() === "*") continue;
      expect(
        m[1],
        `a commercial_invoices select reads opportunity_id but does not select it: ${m[1]}`
      ).toContain("opportunity_id");
    }
  });

  it("the invoice create path actually SELECTS the job's override", () => {
    // The trap this guards: a column missing from a PostgREST select comes
    // back undefined rather than erroring, so the override would read as
    // "inherit" forever and nothing would fail. Caught exactly that here.
    const src = read("lib/commercial/invoices/db.ts");
    // Scoped to createCommercialInvoice — the file queries opportunities in
    // more than one place, and an unscoped match happily read the wrong one.
    const start = src.indexOf("export async function createCommercialInvoice");
    expect(start, "createCommercialInvoice not found").toBeGreaterThan(-1);
    const body = src.slice(start, start + 3000);
    const sel = body.match(/\.from\("commercial_opportunities"\)\s*\n\s*\.select\("([^"]+)"\)/);
    expect(sel, "could not find the opportunity select").not.toBeNull();
    expect(sel![1]).toContain("tax_exempt");
  });
});
