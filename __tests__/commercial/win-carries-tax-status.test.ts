import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Winning a job carries the proposal's tax treatment onto the job.
 *
 * Stephanie 2026-09-01: "When the job is won, tax status should carry over."
 *
 * The capital-improvement notice is a PER-PROPOSAL tick. It hydrates FROM the
 * deal (`opp.tax_exempt_reason === "capital_improvement"`), but the estimator
 * can turn it on or off on the document itself — and that answer never
 * travelled back. So a proposal quoted and signed as a capital improvement was
 * won onto a deal that still read taxable, and the first invoice charged tax
 * the GC had already been told in writing they would not pay.
 *
 * A seam test: the tick lives in the proposal's header_json, the status lives
 * on the opportunity, and nothing in the type system connects them.
 */
const SRC = readFileSync("lib/commercial/projects/accepted-contract.ts", "utf8");

describe("the win carries the tax status", () => {
  it("reads the winning proposal's capital-improvement tick", () => {
    expect(SRC).toContain("header_json");
    expect(SRC).toMatch(/show_capital_improvement_notice\s*===\s*true/);
  });

  it("writes it onto the opportunity", () => {
    expect(SRC).toMatch(/tax_exempt:\s*true/);
    expect(SRC).toMatch(/tax_exempt_reason:\s*"capital_improvement"/);
  });

  it("only ever turns the exemption ON", () => {
    // Clearing a `certificate` exemption because a proposal didn't happen to
    // tick the CI box would throw away a cert somebody recorded against the
    // job — a different fact, and one this has no business touching.
    expect(SRC).not.toMatch(/tax_exempt:\s*false/);
    expect(SRC).toMatch(/if\s*\(!t\?\.tax_exempt\)/);
  });

  it("does not let a tax write break the contract snapshot", () => {
    // The snapshot is the reason this function exists. A tax status that failed
    // to carry is visible on the job and correctable; a lost contract sum is
    // neither.
    expect(SRC).toMatch(/could not carry the capital-improvement status/);
  });
});
