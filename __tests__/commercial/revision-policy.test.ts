import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { proposalWentOut, mayCreateRevision } from "@/lib/commercial/proposals/revision-policy";

/**
 * Revisions only after the GC has seen it.
 *
 * Stephanie 2026-08-13: *"do not automatically create a revision every time the
 * proposal is accessed until after the proposal is sent."* Kim works on the
 * original until it goes out; a revision exists because the GC asked for a
 * change, not because someone opened a page.
 */

describe("proposalWentOut", () => {
  it("a fresh draft has not gone out", () => {
    expect(proposalWentOut({ status: "draft", sent_at: null })).toBe(false);
    expect(mayCreateRevision({ status: "draft", sent_at: null })).toBe(false);
  });

  it("a sent proposal has", () => {
    expect(proposalWentOut({ status: "sent", sent_at: "2026-08-13T12:00:00Z" })).toBe(true);
  });

  it("a sent_at stamp counts even if the status was dragged back to draft", () => {
    // It was emailed. The GC has it. Relabelling the row does not un-send it.
    expect(proposalWentOut({ status: "draft", sent_at: "2026-08-01T12:00:00Z" })).toBe(true);
  });

  it("terminal states count, since none is reachable without going out", () => {
    for (const status of ["won", "lost", "superseded", "expired"]) {
      expect(proposalWentOut({ status, sent_at: null })).toBe(true);
    }
  });

  it("a missing parent is not a licence to revise", () => {
    expect(proposalWentOut(null)).toBe(false);
    expect(proposalWentOut(undefined)).toBe(false);
    expect(proposalWentOut({})).toBe(false);
  });
});

describe("the rule is enforced on the route, not just the button", () => {
  it("/proposal/new consults the policy before honouring ?bump=", () => {
    // This route MUTATES ON GET. A hidden button is a suggestion; a bookmark,
    // a browser-back or a hand-typed ?bump= is what actually mints a stray R2
    // and splits the work across two rows. If this assertion ever fails, the
    // guard has moved back to being cosmetic.
    const src = readFileSync(
      join(__dirname, "..", "..", "app/commercial/accounts/[id]/deals/[dealId]/proposal/new/page.tsx"),
      "utf8"
    );
    expect(src).toContain("proposalWentOut(parent)");
    // And it must land the user on the original rather than erroring.
    expect(src).toContain("?kept=1");
  });
});
