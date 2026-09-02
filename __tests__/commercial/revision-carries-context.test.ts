import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A revision keeps what the previous one said.
 *
 * Stephanie 2026-09-01: "Carry over contact information and estimator info when
 * proposal is revised."
 *
 * Everything else already came forward from the parent — intro, notes,
 * exclusions, bid-set date, price override. The header (which carries the
 * Attention contact) and the estimator sign-off did not: both were re-derived
 * from the deal on every revision. So an estimator who fixed the contact name
 * or their own title on R1 — things the editor explicitly invites — watched R2
 * revert, and had to redo it every time.
 *
 * A source-level test because this is a seam: the copy happens in the route,
 * the defaults live in createProposal, and nothing in the type system says the
 * two lists have to match. Dropping either line compiles perfectly.
 */
const ROUTE = "app/commercial/accounts/[id]/deals/[dealId]/proposal/new/page.tsx";
const src = readFileSync(ROUTE, "utf8");

describe("a revision inherits its parent's context", () => {
  it("captures the parent's header and estimator", () => {
    expect(src).toMatch(/parentHeader\s*=\s*parent\.header_json/);
    expect(src).toMatch(/parentEstimator\s*=\s*parent\.estimator_snapshot_json/);
  });

  it("passes them to createProposal, merged over the hydrated values", () => {
    // Merged, not replaced: a field the parent never set (a phone added to the
    // profile since) should still fill in, while anything typed by hand wins.
    expect(src).toMatch(/header_json:\s*parentHeader\s*\?\s*\{\s*\.\.\.ctx\.header,\s*\.\.\.parentHeader\s*\}/);
    expect(src).toMatch(/\.\.\.ctx\.estimator,\s*\.\.\.parentEstimator/);
  });

  it("still hydrates a FIRST proposal", () => {
    // No parent means no inheritance — hydration is the only source there is,
    // and a null-guarded ternary is what keeps that true.
    expect(src).toMatch(/parentHeader\s*:\s*CommercialProposal\["header_json"\]\s*\|\s*null\s*=\s*null/);
    expect(src).toMatch(/parentEstimator[^=]*=\s*null/);
  });

  it("keeps carrying the things it already carried", () => {
    // Guards against a future edit that swaps rather than adds.
    for (const field of ["intro_text_override", "alternate_notes", "bid_notes", "exclusion_ids", "bid_set_date"]) {
      expect(src, `the revision stopped carrying ${field}`).toContain(field);
    }
  });
});
