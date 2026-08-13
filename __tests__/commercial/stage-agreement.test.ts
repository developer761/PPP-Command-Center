import { describe, it, expect } from "vitest";
import {
  PRE_CONTRACT_COLUMNS,
  POST_CONTRACT_COLUMNS,
  columnKeyForOpp,
  oppStatusDisplayLabel,
} from "@/lib/commercial/opportunities/kanban-columns";
import { nextStep } from "@/lib/commercial/opportunities/attention";
import { probabilityFor } from "@/lib/commercial/opportunities/constants";

/**
 * THE WALKTHROUGH, as a test.
 *
 * Karan reported the same thing twice today: *"I put the status to RFP and it
 * changes but it always says Status updated to Qualifying... the whole flow
 * seems broken."* Both times the structure was fine and the FLOW was not —
 * four surfaces each derived the stage their own way and disagreed.
 *
 * So this walks a deal down the whole ladder and asserts the surfaces agree at
 * every stop, rather than asserting any one of them in isolation.
 */

// Every (status, sub_status) a deal can actually sit in, in ladder order.
const LADDER: { status: string; sub: string; column: string }[] = [
  { status: "qualifying", sub: "solicitation", column: "qualifying" },
  { status: "qualifying", sub: "rfp", column: "rfp" },
  { status: "estimating", sub: "estimating", column: "estimating" },
  { status: "estimating", sub: "proposal_pending_approval", column: "pending_approval" },
  { status: "proposal", sub: "sent", column: "sent" },
  { status: "pre_sale_closed", sub: "won", column: "won" },
  { status: "pre_sale_closed", sub: "lost", column: "lost" },
  { status: "pre_construction", sub: "coordination", column: "pre_construction" },
  { status: "in_progress", sub: "wip_on_site", column: "in_progress" },
  { status: "billing", sub: "substantial_completion", column: "billing" },
  { status: "post_sale_closed", sub: "closed", column: "post_sale_closed" },
];

const ALL_COLUMNS = [...PRE_CONTRACT_COLUMNS, ...POST_CONTRACT_COLUMNS];

describe("every stage lands on exactly one column", () => {
  for (const step of LADDER) {
    it(`${step.status}/${step.sub} → ${step.column}`, () => {
      expect(columnKeyForOpp(step.status, step.sub)).toBe(step.column);
    });
  }

  it("the legacy (qualifying, estimating) tuple resolves forward, not back", () => {
    // The exact bug Karan hit: picking Estimating sent the deal BACKWARDS on
    // screen, because two tuples meant "we are pricing it" and only one was
    // mapped.
    expect(columnKeyForOpp("qualifying", "estimating")).toBe("estimating");
  });

  it("dropped sub-statuses fold forward rather than vanishing", () => {
    // Follow-Up was dropped as a stage (Brendan). An old row carrying it is
    // still a proposal that is out.
    expect(columnKeyForOpp("proposal", "follow_up")).toBe("sent");
  });

  it("a junk sub-status on a closed deal reads as LOST, never as a win", () => {
    // A stray Lost is visible and harmless; a junk row rendering as a WIN
    // silently inflates the board and every won-deal rollup.
    expect(columnKeyForOpp("pre_sale_closed", "garbage")).toBe("lost");
  });
});

describe("the label a person sees names the stage they picked", () => {
  for (const step of LADDER) {
    it(`${step.status}/${step.sub} reads as its column's label`, () => {
      // This is the "Status updated to Qualifying" bug: the toast, the chip and
      // the board must all say the same word.
      //
      // The ONE deliberate exception: "Closed Won" / "Closed Lost" name the
      // COLUMN — the bucket — while the deal itself says "Won" / "Lost",
      // because on a decided deal the outcome is the useful word. That call
      // predates this test and is pinned in kanban-columns.test.ts; asserting
      // the general rule over it would be this test overruling a decision
      // rather than catching a drift.
      const expected =
        step.status === "pre_sale_closed"
          ? step.sub === "won" ? "Won" : "Lost"
          : ALL_COLUMNS.find((c) => c.key === step.column)!.label;
      expect(oppStatusDisplayLabel(step.status, step.sub)).toBe(expected);
    });
  }
});

describe("every open stage offers a next step, and terminal ones don't", () => {
  const step = (status: string, sub: string, proposal: { id: string; status: string } | null, counts: { proposalCount: number; sentProposalCount: number }) =>
    nextStep({ oppId: "o1", accountId: "a1", status, subStatus: sub, proposal, approvedNotSentCount: 0, ...counts });

  it("a bid with nothing priced is told to price it", () => {
    expect(step("qualifying", "rfp", null, { proposalCount: 0, sentProposalCount: 0 })?.label)
      .toBe("Build a proposal");
  });

  it("each proposal state names the action, not the state", () => {
    const at = (s: string) =>
      step("estimating", "estimating", { id: "p1", status: s }, { proposalCount: 1, sentProposalCount: 0 })?.label;
    expect(at("draft")).toBe("Send it for approval");
    expect(at("pending_approval")).toBe("Mark it approved");
    expect(at("approved")).toBe("Send it to the GC");
  });

  it("the approval step opens the PROPOSAL, not the tab it lives in", () => {
    // Karan, precisely: "it should be like mark it as approved and then it
    // brings you to the proposal for mark as approved."
    const s = step("estimating", "proposal_pending_approval", { id: "p1", status: "pending_approval" }, { proposalCount: 1, sentProposalCount: 0 });
    expect(s?.href).toContain("/proposal/p1");
  });

  it("delivery stages each point at the work", () => {
    expect(step("pre_sale_closed", "won", null, { proposalCount: 1, sentProposalCount: 1 })?.label).toBe("Start the job");
    expect(step("pre_construction", "coordination", null, { proposalCount: 1, sentProposalCount: 1 })?.label).toBe("Write the work order");
    expect(step("in_progress", "wip_on_site", null, { proposalCount: 1, sentProposalCount: 1 })?.label).toBe("Bill the work");
    expect(step("billing", "substantial_completion", null, { proposalCount: 1, sentProposalCount: 1 })?.label).toBe("Close it out");
  });

  it("a finished or lost deal is not nagged", () => {
    expect(step("post_sale_closed", "closed", null, { proposalCount: 1, sentProposalCount: 1 })).toBeNull();
    expect(step("pre_sale_closed", "lost", null, { proposalCount: 1, sentProposalCount: 1 })).toBeNull();
  });
});

describe("stage odds only ever move forward down the ladder", () => {
  it("never decreases as a deal progresses toward won", () => {
    const upToWon = LADDER.filter((s) => s.column !== "lost" && s.column !== "post_sale_closed");
    const odds = upToWon.map((s) => probabilityFor(s.status, s.sub));
    for (let i = 1; i < odds.length; i++) {
      expect(odds[i], `${upToWon[i].column} (${odds[i]}%) must not be below ${upToWon[i - 1].column} (${odds[i - 1]}%)`)
        .toBeGreaterThanOrEqual(odds[i - 1]);
    }
  });

  it("a lost deal is worth nothing and a won one is worth all of it", () => {
    expect(probabilityFor("pre_sale_closed", "lost")).toBe(0);
    expect(probabilityFor("pre_sale_closed", "won")).toBe(100);
  });
});
