import { describe, it, expect } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  PROBABILITY_PRESERVING_STATUSES,
  HOT_DEAL_ACTIVE_STATUSES,
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
  OPEN_OPP_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import {
  isTransitionAllowed,
  allowedNextStatuses,
  shouldWarnTransition,
} from "@/lib/commercial/opportunities/status";
import type { OpportunityStatus } from "@/lib/commercial/opportunities/db";

// Cast helper: lets us pass arbitrary strings into the type-guarded
// function for negative-case testing without the TS compiler whining.
// The whole point of testing "rejects invalid status" is the input
// is INTENTIONALLY not a valid OpportunityStatus.
const asStatus = (s: string) => s as OpportunityStatus;

/**
 * Tests for the opp status DAG.
 *
 * Why this matters: a wrong transition rule = a deal moves to a state
 * that breaks reporting (e.g. "won → lost" with no audit trail) or
 * gets stuck (e.g. "no_bid" with no reopen path). The DAG is the
 * trust boundary for status integrity — every list page, every
 * automation, every report depends on these transitions being right.
 *
 * NOTE: these tests don't touch the database. They verify the pure
 * DAG logic + constants only.
 */

describe("isTransitionAllowed — DAG enforcement", () => {
  it("inquiry → site_visit_scheduled allowed", () => {
    expect(isTransitionAllowed("inquiry", "site_visit_scheduled")).toBe(true);
  });

  it("inquiry → estimating allowed (skip site visit)", () => {
    expect(isTransitionAllowed("inquiry", "estimating")).toBe(true);
  });

  // Was REJECTED before 2026-06-24. Karan opened it up so a rep can
  // close a repeat-customer verbal-yes without walking the whole funnel.
  // The transition is now allowed at the lib level; UI still warns via
  // WARN_TRANSITIONS so misclicks get a soft prompt.
  it("inquiry → won allowed (repeat-customer verbal-yes path)", () => {
    expect(isTransitionAllowed("inquiry", "won")).toBe(true);
  });

  it("negotiating → won allowed", () => {
    expect(isTransitionAllowed("negotiating", "won")).toBe(true);
  });

  it("won → reopened allowed (rare but valid)", () => {
    expect(isTransitionAllowed("won", "reopened")).toBe(true);
  });

  it("won → estimating REJECTED (must reopen first)", () => {
    expect(isTransitionAllowed("won", "estimating")).toBe(false);
  });

  it("lost → reopened allowed", () => {
    expect(isTransitionAllowed("lost", "reopened")).toBe(true);
  });

  it("no_bid → reopened allowed", () => {
    expect(isTransitionAllowed("no_bid", "reopened")).toBe(true);
  });

  it("every status can go on_hold (except terminal)", () => {
    const non_terminal: OpportunityStatus[] = [
      "inquiry",
      "site_visit_scheduled",
      "site_visit_done",
      "estimating",
      "proposal_sent",
      "negotiating",
    ];
    for (const s of non_terminal) {
      expect(isTransitionAllowed(s, "on_hold")).toBe(true);
    }
  });

  it("on_hold can resume to multiple states", () => {
    expect(isTransitionAllowed("on_hold", "estimating")).toBe(true);
    expect(isTransitionAllowed("on_hold", "proposal_sent")).toBe(true);
    expect(isTransitionAllowed("on_hold", "negotiating")).toBe(true);
  });

  it("rejects unknown from status", () => {
    expect(isTransitionAllowed(asStatus("invalid_status"), "won")).toBe(false);
  });

  it("rejects unknown to status", () => {
    expect(isTransitionAllowed("inquiry", asStatus("invalid_status"))).toBe(false);
  });
});

describe("allowedNextStatuses — list of valid next states", () => {
  it("returns the documented next states for inquiry", () => {
    const next = allowedNextStatuses("inquiry");
    expect(next).toContain("site_visit_scheduled");
    expect(next).toContain("estimating");
    expect(next).toContain("on_hold");
    expect(next).toContain("lost");
    expect(next).toContain("no_bid");
  });

  it("won only allows reopened", () => {
    expect(allowedNextStatuses("won")).toEqual(["reopened"]);
  });

  it("returns empty array for unknown status", () => {
    expect(allowedNextStatuses(asStatus("garbage"))).toEqual([]);
  });
});

describe("shouldWarnTransition — UX warn-only transitions", () => {
  it("warns on inquiry → lost (skipping site visit)", () => {
    expect(shouldWarnTransition("inquiry", "lost")).toBe(true);
  });

  it("warns on negotiating → estimating (scope re-bid)", () => {
    expect(shouldWarnTransition("negotiating", "estimating")).toBe(true);
  });

  // Won → reopened warning was removed 2026-06-24. Reopen is a dedicated
  // header action on terminal opps, not a dropdown choice, so the
  // "unusual transition" warning was misleading — re-engaging a closed
  // customer is a normal motion, not a flagged edge case.
  it("does NOT warn on won → reopened (Reopen is a normal header action)", () => {
    expect(shouldWarnTransition("won", "reopened")).toBe(false);
  });

  it("does NOT warn on normal forward motion", () => {
    expect(shouldWarnTransition("inquiry", "site_visit_scheduled")).toBe(false);
    expect(shouldWarnTransition("estimating", "proposal_sent")).toBe(false);
    expect(shouldWarnTransition("proposal_sent", "negotiating")).toBe(false);
    expect(shouldWarnTransition("negotiating", "won")).toBe(false);
  });
});

describe("constants — invariants", () => {
  it("TERMINAL_STATUSES contains exactly won/lost/no_bid", () => {
    expect(TERMINAL_STATUSES.has("won")).toBe(true);
    expect(TERMINAL_STATUSES.has("lost")).toBe(true);
    expect(TERMINAL_STATUSES.has("no_bid")).toBe(true);
    expect(TERMINAL_STATUSES.has("on_hold")).toBe(false);
    expect(TERMINAL_STATUSES.has("reopened")).toBe(false);
  });

  it("PROBABILITY_PRESERVING_STATUSES contains on_hold", () => {
    expect(PROBABILITY_PRESERVING_STATUSES.has("on_hold")).toBe(true);
  });

  it("OPEN_OPP_STATUSES excludes terminal states", () => {
    expect(OPEN_OPP_STATUSES).not.toContain("won");
    expect(OPEN_OPP_STATUSES).not.toContain("lost");
    expect(OPEN_OPP_STATUSES).not.toContain("no_bid");
  });

  it("HOT_DEAL_ACTIVE_STATUSES is a subset of OPEN_OPP_STATUSES", () => {
    for (const s of HOT_DEAL_ACTIVE_STATUSES) {
      expect(OPEN_OPP_STATUSES).toContain(s);
    }
  });

  it("HOT_DEAL_BID_CENTS is a sensible positive number", () => {
    expect(HOT_DEAL_BID_CENTS).toBeGreaterThan(0);
    expect(HOT_DEAL_BID_CENTS).toBe(5_000_000); // $50,000 — current threshold
  });

  it("HOT_DEAL_DECISION_DAYS is positive", () => {
    expect(HOT_DEAL_DECISION_DAYS).toBeGreaterThan(0);
  });

  it("ALLOWED_TRANSITIONS covers every status as a from", () => {
    const allStatuses: OpportunityStatus[] = [
      "inquiry",
      "site_visit_scheduled",
      "site_visit_done",
      "estimating",
      "proposal_sent",
      "negotiating",
      "on_hold",
      "won",
      "lost",
      "no_bid",
      "reopened",
    ];
    for (const s of allStatuses) {
      expect(ALLOWED_TRANSITIONS[s]).toBeDefined();
      expect(ALLOWED_TRANSITIONS[s]!.length).toBeGreaterThan(0);
    }
  });
});
