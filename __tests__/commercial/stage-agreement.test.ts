import { describe, it, expect } from "vitest";
import {
  PRE_CONTRACT_COLUMNS,
  POST_CONTRACT_COLUMNS,
  columnKeyForOpp,
  oppStatusDisplayLabel,
} from "@/lib/commercial/opportunities/kanban-columns";
import { nextStep, attentionFor } from "@/lib/commercial/opportunities/attention";
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
    // Read from the stage each state belongs to — the deal leads, so a
    // proposal ahead of its deal is a different question (see below).
    expect(step("estimating", "estimating", { id: "p1", status: "draft" }, { proposalCount: 1, sentProposalCount: 0 })?.label)
      .toBe("Send it for approval");
    expect(step("estimating", "proposal_pending_approval", { id: "p1", status: "pending_approval" }, { proposalCount: 1, sentProposalCount: 0 })?.label)
      .toBe("Mark it approved");
    expect(step("estimating", "proposal_pending_approval", { id: "p1", status: "approved" }, { proposalCount: 1, sentProposalCount: 0 })?.label)
      .toBe("Send it to the GC");
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

/**
 * Karan, 2026-08-12: *"if I manually move a status back and forth this button
 * stays there, which is misleading — 'Send it for approval'."*
 *
 * The pre-sale branches read ONLY the proposal, so a deal somebody had dragged
 * to Sent still said "Send it for approval" because the proposal was never
 * taken out of draft. The one instruction on screen contradicted the stage
 * printed directly above it.
 */
describe("the next step follows the deal when a human moved it", () => {
  const step = (status: string, sub: string, proposalStatus: string | null, counts?: { proposalCount?: number; sentProposalCount?: number }) =>
    nextStep({
      oppId: "o1",
      accountId: "a1",
      status,
      subStatus: sub,
      proposal: proposalStatus ? { id: "p1", status: proposalStatus } : null,
      proposalCount: counts?.proposalCount ?? (proposalStatus ? 1 : 0),
      sentProposalCount: counts?.sentProposalCount ?? 0,
      approvedNotSentCount: 0,
    });

  it("a deal dragged to Sent asks for the ANSWER, not for approval", () => {
    // The exact report. Proposal still draft; the deal is out with the GC.
    expect(step("proposal", "sent", "draft")?.label).toBe("Mark won or lost");
  });

  it("holds at Sent through every stale proposal state", () => {
    for (const ps of ["draft", "pending_approval", "approved", null]) {
      expect(step("proposal", "sent", ps)?.label, `proposal=${ps}`).toBe("Mark won or lost");
    }
  });

  it("moved BACK to Qualifying, it never says 'Send it for approval'", () => {
    // Karan 2026-08-13, and the reason this file is worth reading: the version
    // of this test written the day before ASSERTED "Send it for approval"
    // here. It codified the exact contradiction he then reported — the bar
    // reading Qualifying with a button offering to send a proposal for
    // approval underneath it.
    const s = step("qualifying", "solicitation", "draft")!;
    expect(s.label).not.toBe("Send it for approval");
    expect(s.label).toBe("Move it to Estimating");
  });

  it("when paperwork runs ahead, it offers to catch the DEAL up", () => {
    // The deal's stage is a person's statement; the proposal is an artifact.
    // Auto-advance already drags the deal forward when an artifact moves, so a
    // deal sitting behind its paperwork means a human put it there — and the
    // answer to that is never to ignore them. The step brings the deal up,
    // which is actionable and can't disagree with the bar.
    expect(step("qualifying", "rfp", "sent", { sentProposalCount: 1 })?.label).toBe("Move it to Sent");
    expect(step("qualifying", "rfp", "pending_approval")?.label).toBe("Move it to Pending Approval");
  });

  it("the catch-up step pre-picks the stage it names", () => {
    // Otherwise "Move it to Sent" lands on an unset dropdown and the person
    // has to work out what the button meant.
    const s = step("qualifying", "rfp", "pending_approval")!;
    const u = new URL(s.href, "https://x.test");
    expect(u.searchParams.get("to")).toBe("estimating");
    expect(u.searchParams.get("to_sub")).toBe("proposal_pending_approval");
  });

  it("an approved proposal sitting unsent outranks the stage it's parked at", () => {
    // The deal being parked at Pending Approval doesn't change the fact that a
    // signed-off proposal hasn't gone to the GC.
    expect(step("estimating", "proposal_pending_approval", "approved")?.label).toBe("Send it to the GC");
  });

  it("a deal with no proposal at all still says so, wherever it sits", () => {
    expect(step("qualifying", "rfp", null)?.label).toBe("Build a proposal");
    expect(step("estimating", "estimating", null)?.label).toBe("Build a proposal");
  });
});

/**
 * The same staleness in the WARNINGS, which Karan predicted: "this button and
 * probably the other ones". Two rules read only the proposal, so one fired
 * against a deal the user had moved and the other stayed silent for it.
 */
describe("warnings consult the deal, not just its proposal", () => {
  const warn = (status: string, sub: string, over: Record<string, unknown> = {}) =>
    attentionFor({
      oppId: "o1",
      status,
      subStatus: sub,
      proposalCount: 1,
      sentProposalCount: 0,
      approvedNotSentCount: 0,
      followUpAt: null,
      ...over,
    } as never).map((a) => a.key);

  it("stops insisting 'the GC hasn't seen it' once the deal says Sent", () => {
    // A GC often gets the PDF by email or in person before anyone updates the
    // proposal record. Contradicting the person's own stage change is the
    // exact thing that was reported.
    expect(warn("estimating", "proposal_pending_approval", { approvedNotSentCount: 1 }))
      .toContain("approved_not_sent");
    expect(warn("proposal", "sent", { approvedNotSentCount: 1 }))
      .not.toContain("approved_not_sent");
  });

  it("nudges for a follow-up on a deal moved to Sent by hand", () => {
    // The false negative: the bid most likely to be forgotten was the one the
    // platform said nothing about, because no proposal was marked sent.
    expect(warn("proposal", "sent")).toContain("no_follow_up");
    // …and stays quiet once one is booked.
    expect(warn("proposal", "sent", { followUpAt: "2026-09-01" })).not.toContain("no_follow_up");
  });

  it("still nudges the ordinary case, where the proposal was marked sent", () => {
    expect(warn("qualifying", "rfp", { sentProposalCount: 1 })).toContain("no_follow_up");
  });
});
