import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * Brendan 2026-09-23: "Add an internal line item button on the proposal when
 * making the inclusions."
 *
 * An internal line is real, priced work Tomco is doing and paying for — lifts,
 * night access, a dumpster — that they do not itemise to the GC. So it counts
 * toward the TOTAL (leaving it out would under-charge the job) and never
 * appears on the customer copy.
 *
 * The property that matters is the NEGATIVE one: it must not leak onto the
 * page a GC reads. That is enforced by filtering once on the way into the
 * renderer rather than inside each of the three places that print a line —
 * so these assert the filter is where it cannot be forgotten.
 */
const PDF = stripComments(readFileSync("lib/commercial/proposals/pdf.tsx", "utf8"));
const DB = stripComments(readFileSync("lib/commercial/proposals/db.ts", "utf8"));
const MIGRATION = readFileSync(
  "supabase/migrations/20260923190000_proposal_internal_line_items.sql",
  "utf8"
);

describe("an internal line never reaches the customer", () => {
  it("is filtered out of the customer copy, by mode", () => {
    expect(PDF).toContain('mode === "customer" ? allInclusions.filter((i) => i.is_internal !== true)');
  });

  it("is marked on the internal report, so an approver can tell what it is", () => {
    expect(PDF).toContain('it.is_internal ? "[INTERNAL] " : ""');
  });
});

describe("but it is still part of the price", () => {
  it("the sum does not exclude it — that would under-charge the job", () => {
    // If the TOTAL were summed from what the customer PDF renders, hiding a
    // line would silently drop its money. The sum reads the ROWS, and must
    // stay blind to is_internal: the customer is buying that work.
    const i = DB.indexOf("export async function proposalLineItemSumCents");
    expect(i, "proposalLineItemSumCents has moved or been renamed").toBeGreaterThan(-1);
    const body = DB.slice(i, DB.indexOf("\nexport async function", i + 10));
    expect(body, "the total now filters internal lines out — the job would be under-charged").not.toContain("is_internal");
  });
});

describe("the column can arrive late", () => {
  it("the migration is idempotent, as this repo requires", () => {
    // No migration runner here — SQL is pasted by hand and may be re-run.
    expect(MIGRATION).toContain("add column if not exists");
    expect(MIGRATION).toContain("create index if not exists");
  });

  it("defaults false, so every existing line and proposal is unchanged", () => {
    expect(MIGRATION).toMatch(/is_internal boolean not null default false/);
  });
});
