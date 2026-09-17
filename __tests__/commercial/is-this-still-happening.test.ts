import { describe, it, expect } from "vitest";

import { attentionFor, type AttentionInput } from "@/lib/commercial/opportunities/attention";

/**
 * "Is this still happening?"
 *
 * Karan 2026-09-17: "if a due date for a project is like 6 months ago, or like
 * it might not happen, still in the talks, it'll give us a little nudge."
 *
 * Steps 1 and 2 of docs/PROJECTED_CALENDAR_PLAN.md, shipped ahead of the
 * calendar on purpose: measured against the live book, all 46 open deals have
 * NO expected start (29 sent, 9 estimating, 8 pre-construction). Every date
 * that exists is on a job already underway or finished, because it came from a
 * work order at import. A projected calendar on that data is a permanently
 * empty month — so these rules, which fill the column, come first.
 */

const base: AttentionInput = {
  oppId: "11111111-1111-4111-8111-111111111111",
  status: "proposal",
  subStatus: "sent",
  contractBaseCents: null,
  hasProject: false,
  followUpAt: "2026-09-20",
  proposalCount: 1,
  sentProposalCount: 1,
  hasWorkOrder: false,
  hasBilling: false,
  todayIso: "2026-09-17",
};

const keys = (i: Partial<AttentionInput>) => attentionFor({ ...base, ...i }).map((a) => a.key);

describe("expected start", () => {
  it("asks for one on a live deal that has none", () => {
    expect(keys({ proposedStartAt: null })).toContain("no_expected_start");
  });

  it("says nothing when the caller did not load the column", () => {
    // THE TRAP. `undefined` is "we didn't ask", not "there isn't one". Treating
    // the two the same would put a nudge on every deal on any surface that had
    // not been updated to pass the field — which is most of them.
    expect(keys({})).not.toContain("no_expected_start");
    expect(keys({ proposedStartAt: undefined })).not.toContain("no_expected_start");
  });

  it("stops asking once there is one", () => {
    expect(keys({ proposedStartAt: "2026-11-01" })).not.toContain("no_expected_start");
  });

  it("nudges when the date has come and gone", () => {
    const k = keys({ proposedStartAt: "2026-08-01" });
    expect(k).toContain("expected_start_passed");
    expect(k).not.toContain("no_expected_start");
  });

  it("says six months when it has been six months", () => {
    const [item] = attentionFor({ ...base, proposedStartAt: "2026-01-02" }).filter(
      (a) => a.key === "expected_start_passed"
    );
    expect(item.title).toMatch(/six months/i);
    expect(item.tone).toBe("warn");
  });

  it("counts the days for a recent slip", () => {
    const [item] = attentionFor({ ...base, proposedStartAt: "2026-09-10" }).filter(
      (a) => a.key === "expected_start_passed"
    );
    expect(item.title).toBe("Expected start was 7 days ago");
  });

  it("does not fire on today or a future date", () => {
    // An off-by-one here nags about a job starting this morning.
    expect(keys({ proposedStartAt: "2026-09-17" })).not.toContain("expected_start_passed");
    expect(keys({ proposedStartAt: "2026-09-18" })).not.toContain("expected_start_passed");
  });

  it("leaves a job that is already on site alone", () => {
    // Once the crew is there the real dates are in Field Ops, and an estimate
    // that has been overtaken by reality is noise on the busiest job.
    for (const status of ["in_progress", "billing", "post_sale_closed"]) {
      const k = keys({ status, subStatus: null, proposedStartAt: "2026-01-02" });
      expect(k, status).not.toContain("expected_start_passed");
      expect(k, status).not.toContain("no_expected_start");
    }
  });

  it("leaves a LOST deal alone", () => {
    // attentionFor returns early on lost — a nudge about a job we didn't get is
    // exactly the noise that teaches people to ignore the whole rail.
    const k = keys({ status: "pre_sale_closed", subStatus: "lost", proposedStartAt: null });
    expect(k).toEqual([]);
  });

  it("covers the stages that are actually planning work", () => {
    for (const [status, sub] of [
      ["estimating", "estimating"],
      ["proposal", "sent"],
      ["pre_construction", "coordination"],
    ] as const) {
      expect(keys({ status, subStatus: sub, proposedStartAt: null }), status).toContain(
        "no_expected_start"
      );
    }
  });
});
