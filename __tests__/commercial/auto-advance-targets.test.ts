import { describe, it, expect } from "vitest";
import {
  AUTO_ADVANCE_TARGETS,
  targetForProposalStatus,
  foldAutoAdvanceTargets,
  canAutoAdvance,
} from "@/lib/commercial/opportunities/auto-advance-targets";
import { stageRank } from "@/lib/commercial/opportunities/constants";
import { PROPOSAL_STATUSES, type ProposalStatus } from "@/lib/commercial/proposals/constants";

describe("auto-advance target whitelist", () => {
  it("keeps `order` identical to stageRank for the three live stages", () => {
    // Two numbers for the same concept is exactly how a forward-only engine
    // starts moving deals backwards. If stageRank's ladder is ever renumbered,
    // this fails instead of the engine quietly disagreeing with the DB guard.
    for (const key of ["estimating", "proposal", "won"] as const) {
      const t = AUTO_ADVANCE_TARGETS[key];
      expect(stageRank(t.status, t.sub_status), key).toBe(t.order);
    }
  });

  it("puts Closed above the whole ladder even though stageRank calls it terminal", () => {
    const closed = AUTO_ADVANCE_TARGETS.closed;
    // Terminal means "never a legal SOURCE" — it's still a legal target.
    expect(stageRank(closed.status, closed.sub_status)).toBeNull();
    expect(closed.order).toBe(8);
    expect(closed.requiresPostSale).toBe(true);
  });

  it("offers no target that §4b killed", () => {
    // The three dropped triggers all needed a target that simply isn't here.
    const reachable = Object.values(AUTO_ADVANCE_TARGETS).map((t) => t.status);
    expect(reachable).not.toContain("pre_construction"); // skips Start Project + debrief
    expect(reachable).not.toContain("billing"); // AIA jobs bill from 15% done
    expect(reachable).not.toContain("in_progress"); // a WO must not cross pre→post
  });

  it("never targets a LOST deal", () => {
    // Auto-advancing into lost would need a loss_reason, and the engine would
    // have to invent one — placeholder 'other' pollution in the win/loss report.
    for (const t of Object.values(AUTO_ADVANCE_TARGETS)) {
      expect(t.sub_status).not.toBe("lost");
    }
  });
});

describe("targetForProposalStatus", () => {
  it("sends a DRAFT to Estimating, not to Proposal", () => {
    // The trap: "a proposal exists" reads like the Proposal stage. It isn't —
    // advancing there fabricates a sent deal with no PDF and no approval.
    for (const s of ["draft", "pending_approval", "approved"]) {
      expect(targetForProposalStatus(s), s).toBe("estimating");
    }
  });

  it("sends a SENT proposal to Proposal and a WON one to Closed Won", () => {
    expect(targetForProposalStatus("sent")).toBe("proposal");
    expect(targetForProposalStatus("won")).toBe("won");
  });

  it("caps at won — nothing drives a deal into delivery", () => {
    expect(AUTO_ADVANCE_TARGETS[targetForProposalStatus("won")!].status).toBe("pre_sale_closed");
  });

  it("has a deliberate answer for every proposal status that exists", () => {
    // Not just "doesn't crash" — each real status is listed here on purpose, so
    // adding a ninth proposal status fails this test instead of silently
    // defaulting to 'no move' and leaving a stage that never advances.
    const expected: Record<ProposalStatus, string | null> = {
      draft: "estimating",
      pending_approval: "estimating",
      approved: "estimating",
      sent: "proposal",
      won: "won",
      lost: null, // deal-level loss is a human decision with a loss_reason
      expired: null,
      superseded: null, // an R2 replaced it; R2 carries the stage
    };
    for (const s of PROPOSAL_STATUSES) {
      expect(targetForProposalStatus(s), s).toBe(expected[s]);
    }
  });

  it("moves nothing for a dead or unrecognised proposal", () => {
    for (const s of ["rejected", "void", "lost", "expired", "", null, undefined, "nonsense"]) {
      expect(targetForProposalStatus(s), String(s)).toBeNull();
    }
  });
});

describe("foldAutoAdvanceTargets", () => {
  it("takes the furthest target so a multi-proposal deal gets ONE write", () => {
    // Three proposals: a won one, a sent one, and a fresh draft. Applying them
    // in sequence would walk the deal Estimating → Proposal → Won and write
    // three log rows for stages it was never really in.
    expect(foldAutoAdvanceTargets(["estimating", "won", "proposal"])).toBe("won");
  });

  it("is order-independent", () => {
    expect(foldAutoAdvanceTargets(["won", "estimating"])).toBe(
      foldAutoAdvanceTargets(["estimating", "won"])
    );
  });

  it("ignores triggers that fired nothing", () => {
    expect(foldAutoAdvanceTargets([null, undefined, "proposal", null])).toBe("proposal");
    expect(foldAutoAdvanceTargets([null, undefined])).toBeNull();
    expect(foldAutoAdvanceTargets([])).toBeNull();
  });

  it("does not let a stale draft drag a won deal back down", () => {
    // The ping-pong in one line: reopening a draft on a won deal must not
    // produce Estimating as the request's target.
    expect(foldAutoAdvanceTargets(["won", "estimating", "estimating"])).toBe("won");
  });
});

describe("canAutoAdvance", () => {
  it("advances a live deal forward", () => {
    expect(canAutoAdvance({ status: "qualifying", sub_status: "solicitation" }, "proposal")).toBe(true);
    expect(canAutoAdvance({ status: "estimating", sub_status: "estimating" }, "won")).toBe(true);
  });

  it("refuses to move a deal backwards", () => {
    // The regression the spec names: deal at Proposal, someone opens an R2
    // draft, a reconcile pass must LEAVE it at Proposal.
    expect(canAutoAdvance({ status: "proposal", sub_status: "sent" }, "estimating")).toBe(false);
    expect(canAutoAdvance({ status: "in_progress", sub_status: "wip_on_site" }, "won")).toBe(false);
  });

  it("refuses to move at all once the deal is already there", () => {
    expect(canAutoAdvance({ status: "proposal", sub_status: "sent" }, "proposal")).toBe(false);
  });

  it("will not resurrect a lost bid or reopen a closed job", () => {
    for (const key of ["estimating", "proposal", "won", "closed"] as const) {
      expect(canAutoAdvance({ status: "pre_sale_closed", sub_status: "lost" }, key), key).toBe(false);
      expect(canAutoAdvance({ status: "post_sale_closed", sub_status: "closed" }, key), key).toBe(false);
    }
  });

  it("refuses on a legacy or unknown status instead of guessing", () => {
    for (const s of ["won", "proposal_sent", "inquiry", "", null]) {
      expect(canAutoAdvance({ status: s, sub_status: null }, "proposal"), String(s)).toBe(false);
    }
  });

  it("lets closeout close a job that is mid-delivery", () => {
    expect(canAutoAdvance({ status: "post_sale_closed", sub_status: "closeout" }, "closed")).toBe(true);
    expect(canAutoAdvance({ status: "billing", sub_status: "substantial_completion" }, "closed")).toBe(true);
  });
});
