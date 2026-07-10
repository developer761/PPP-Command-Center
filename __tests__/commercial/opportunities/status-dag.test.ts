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
 * Tests for the opp status DAG — v1.1 CEO status model.
 *
 * Why this matters: a wrong transition rule = a bid moves to a state
 * that breaks reporting (e.g. "won → lost" with no audit trail) or
 * gets stuck. The DAG is the trust boundary for status integrity —
 * every list page, every automation, every report depends on these
 * transitions being right.
 *
 * v1.1 Pre-Contract flow (per CEO email, 2026-07-09 PM):
 *   solicitation → rfp → estimating → proposal_pending_approval →
 *   proposal_sent → follow_up → (won | lost)
 *
 * NOTE: these tests don't touch the database. They verify the pure
 * DAG logic + constants only.
 */

describe("isTransitionAllowed — v1.1 DAG enforcement", () => {
  it("solicitation → rfp allowed (normal flow)", () => {
    expect(isTransitionAllowed("solicitation", "rfp")).toBe(true);
  });

  it("solicitation → estimating allowed (skip RFP for repeat customers)", () => {
    expect(isTransitionAllowed("solicitation", "estimating")).toBe(true);
  });

  it("rfp → proposal_pending_approval allowed", () => {
    expect(isTransitionAllowed("rfp", "proposal_pending_approval")).toBe(true);
  });

  it("estimating → proposal_pending_approval allowed (normal flow)", () => {
    expect(isTransitionAllowed("estimating", "proposal_pending_approval")).toBe(true);
  });

  it("proposal_pending_approval → proposal_sent allowed", () => {
    expect(isTransitionAllowed("proposal_pending_approval", "proposal_sent")).toBe(true);
  });

  it("proposal_sent → follow_up allowed (natural next step)", () => {
    expect(isTransitionAllowed("proposal_sent", "follow_up")).toBe(true);
  });

  it("follow_up → won allowed (client says yes)", () => {
    expect(isTransitionAllowed("follow_up", "won")).toBe(true);
  });

  // Repeat-customer verbal-yes shortcuts. WARN_TRANSITIONS flags these
  // at the UI level so misclicks get a soft prompt.
  it("solicitation → won allowed (repeat-customer verbal-yes path)", () => {
    expect(isTransitionAllowed("solicitation", "won")).toBe(true);
  });

  it("estimating → won allowed (mid-estimate verbal yes)", () => {
    expect(isTransitionAllowed("estimating", "won")).toBe(true);
  });

  // Terminal → solicitation is the "re-engage" path — replaces v1.0's
  // reopened. A won that comes back to us or a lost we want to re-bid
  // starts fresh at the top of the funnel.
  it("won → solicitation allowed (re-engage a closed customer)", () => {
    expect(isTransitionAllowed("won", "solicitation")).toBe(true);
  });

  it("lost → solicitation allowed (re-bid path)", () => {
    expect(isTransitionAllowed("lost", "solicitation")).toBe(true);
  });

  it("won → estimating REJECTED (must re-solicit first)", () => {
    expect(isTransitionAllowed("won", "estimating")).toBe(false);
  });

  it("every active status can go to follow_up", () => {
    const active: OpportunityStatus[] = [
      "solicitation",
      "rfp",
      "estimating",
      "proposal_pending_approval",
      "proposal_sent",
    ];
    for (const s of active) {
      // solicitation → follow_up is allowed per constants
      expect(isTransitionAllowed(s, "follow_up")).toBe(true);
    }
  });

  it("follow_up can move back into pipeline states", () => {
    expect(isTransitionAllowed("follow_up", "estimating")).toBe(true);
    expect(isTransitionAllowed("follow_up", "proposal_pending_approval")).toBe(true);
    expect(isTransitionAllowed("follow_up", "proposal_sent")).toBe(true);
  });

  it("rejects unknown from status", () => {
    expect(isTransitionAllowed(asStatus("invalid_status"), "won")).toBe(false);
  });

  it("rejects unknown to status", () => {
    expect(isTransitionAllowed("solicitation", asStatus("invalid_status"))).toBe(false);
  });

  // Guard against regressions: v1.0 values must be REJECTED as targets
  // now that the migration is done — code shouldn't accept a stale flow.
  it("rejects v1.0 target statuses (inquiry, negotiating, on_hold, no_bid, reopened)", () => {
    for (const bad of ["inquiry", "negotiating", "on_hold", "no_bid", "reopened"]) {
      expect(isTransitionAllowed("solicitation", asStatus(bad))).toBe(false);
    }
  });
});

describe("allowedNextStatuses — list of valid next states", () => {
  it("returns the documented next states for solicitation", () => {
    const next = allowedNextStatuses("solicitation");
    expect(next).toContain("rfp");
    expect(next).toContain("estimating");
    expect(next).toContain("follow_up");
    expect(next).toContain("lost");
  });

  it("won only allows solicitation (re-engage path)", () => {
    expect(allowedNextStatuses("won")).toEqual(["solicitation"]);
  });

  it("lost only allows solicitation (re-bid path)", () => {
    expect(allowedNextStatuses("lost")).toEqual(["solicitation"]);
  });

  it("returns empty array for unknown status", () => {
    expect(allowedNextStatuses(asStatus("garbage"))).toEqual([]);
  });
});

describe("shouldWarnTransition — UX warn-only transitions", () => {
  it("warns on solicitation → lost (early kill)", () => {
    expect(shouldWarnTransition("solicitation", "lost")).toBe(true);
  });

  it("warns on solicitation → won (very early close)", () => {
    expect(shouldWarnTransition("solicitation", "won")).toBe(true);
  });

  it("warns on estimating → won (mid-funnel close)", () => {
    expect(shouldWarnTransition("estimating", "won")).toBe(true);
  });

  it("warns on proposal_sent → estimating (scope re-bid)", () => {
    expect(shouldWarnTransition("proposal_sent", "estimating")).toBe(true);
  });

  it("warns on won → solicitation (re-engage — soft confirm)", () => {
    expect(shouldWarnTransition("won", "solicitation")).toBe(true);
  });

  it("does NOT warn on normal forward motion", () => {
    expect(shouldWarnTransition("solicitation", "rfp")).toBe(false);
    expect(shouldWarnTransition("rfp", "estimating")).toBe(false);
    expect(shouldWarnTransition("estimating", "proposal_pending_approval")).toBe(false);
    expect(shouldWarnTransition("proposal_pending_approval", "proposal_sent")).toBe(false);
    expect(shouldWarnTransition("proposal_sent", "follow_up")).toBe(false);
    expect(shouldWarnTransition("follow_up", "won")).toBe(false);
  });
});

describe("constants — v1.1 invariants", () => {
  it("TERMINAL_STATUSES contains exactly won/lost", () => {
    expect(TERMINAL_STATUSES.has("won")).toBe(true);
    expect(TERMINAL_STATUSES.has("lost")).toBe(true);
    // no_bid distinction preserved via lost_reason column — not a status
    expect(TERMINAL_STATUSES.has("no_bid")).toBe(false);
    expect(TERMINAL_STATUSES.has("follow_up")).toBe(false);
  });

  it("PROBABILITY_PRESERVING_STATUSES contains follow_up", () => {
    expect(PROBABILITY_PRESERVING_STATUSES.has("follow_up")).toBe(true);
  });

  it("OPEN_OPP_STATUSES excludes terminal states", () => {
    expect(OPEN_OPP_STATUSES).not.toContain("won");
    expect(OPEN_OPP_STATUSES).not.toContain("lost");
  });

  it("OPEN_OPP_STATUSES includes the 6 active Pre-Contract statuses", () => {
    expect(OPEN_OPP_STATUSES).toContain("solicitation");
    expect(OPEN_OPP_STATUSES).toContain("rfp");
    expect(OPEN_OPP_STATUSES).toContain("estimating");
    expect(OPEN_OPP_STATUSES).toContain("proposal_pending_approval");
    expect(OPEN_OPP_STATUSES).toContain("proposal_sent");
    expect(OPEN_OPP_STATUSES).toContain("follow_up");
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

  it("ALLOWED_TRANSITIONS covers every v1.1 status as a from", () => {
    const allStatuses: OpportunityStatus[] = [
      "solicitation",
      "rfp",
      "estimating",
      "proposal_pending_approval",
      "proposal_sent",
      "follow_up",
      "won",
      "lost",
    ];
    for (const s of allStatuses) {
      expect(ALLOWED_TRANSITIONS[s]).toBeDefined();
      expect(ALLOWED_TRANSITIONS[s]!.length).toBeGreaterThan(0);
    }
  });
});
