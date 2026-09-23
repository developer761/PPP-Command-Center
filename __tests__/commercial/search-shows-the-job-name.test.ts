import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";
import { derivedOppName } from "@/lib/commercial/opportunities/db";

/**
 * Stephanie, 2026-09-23: "When searching for opportunities, the address of the
 * GC populates the search instead of the name of the opportunity."
 *
 * The ⌘K palette built its own label and put `client_name — property_street`
 * AHEAD of the title, so unless a deal had been manually renamed, search
 * showed the customer and their street while every other screen showed the
 * job's name. Measured against live data when it was fixed: 127 of 133
 * opportunities changed what search displayed — "45-16 Ramsey Road" became
 * "Creative Biolabs #2 -LMJ".
 *
 * What made it survive was the comment above it, which said "Same name the
 * rest of the platform shows". It read as settled, so nobody re-derived it.
 */
describe("the search label is the shared rule, not a copy", () => {
  const ROUTE = stripComments(readFileSync("app/api/commercial/palette-search/route.ts", "utf8"));

  it("the palette calls derivedOppName", () => {
    expect(ROUTE).toContain("derivedOppName");
  });

  it("it does not build a name out of the street again", () => {
    // The precise shape of the old bug: street joined into a display label.
    expect(ROUTE).not.toMatch(/\[o\.client_name,\s*o\.property_street\]/);
  });

  it("it selects the field the shared rule needs", () => {
    // Without title_override_mode, derivedOppName treats every nickname as
    // "replace" — so a deal nicknamed "Building C" in append mode loses its
    // full name in search only, which is a quieter version of the same bug.
    expect(ROUTE).toContain("title_override_mode");
  });
});

describe("derivedOppName prefers the name somebody typed", () => {
  const base = {
    client_name: "Tesla",
    property_street: "45-16 Ramsey Road",
    title_override: null,
    title_override_mode: null,
  };

  it("a typed title beats the client and the street", () => {
    const name = derivedOppName({ ...base, title: "Creative Biolabs #2 -LMJ" }, "LMJ Management");
    expect(name).toBe("Creative Biolabs #2 -LMJ");
    // The thing Stephanie was seeing must not be what comes back.
    expect(name).not.toContain("45-16 Ramsey Road");
  });

  it("falls back to the computed name only when there is no typed one", () => {
    const name = derivedOppName({ ...base, title: "" }, "LMJ Management");
    expect(name).toBeTruthy();
    expect(name).not.toBe("(untitled)");
  });
});
