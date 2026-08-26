import { describe, it, expect } from "vitest";
import { approvalRequestRecipients } from "@/lib/notifications/commercial-events";

/**
 * Brendan 2026-08-26: "I don't see the approvals I send in my notifications."
 *
 * He is both the estimator who sends proposals and one of the people who
 * approves them — normal in a shop this size. The rule was "notify everyone but
 * the requester", with a single exception for when the requester was the ONLY
 * approver. So the day a second approver was added, Brendan's own requests
 * stopped appearing in his bell: the item was still his to action, and the
 * platform had quietly decided he didn't need to know.
 *
 * This has now been wrong twice (2026-08-17 and again here), which is why the
 * rule lives in one exported function instead of inline in a fan-out loop.
 */
const BRENDAN = "u-brendan";
const STEPH = "u-stephanie";
const KATIE = "u-katie";

describe("who is told a proposal needs approval", () => {
  it("an approver sees their OWN request, even with other approvers", () => {
    // The exact regression Brendan hit.
    const { recipients, actorIsApprover } = approvalRequestRecipients(
      [BRENDAN, STEPH, KATIE],
      BRENDAN
    );
    expect(actorIsApprover).toBe(true);
    expect(recipients).toContain(BRENDAN);
    expect(recipients).toContain(STEPH);
    expect(recipients).toContain(KATIE);
  });

  it("still works when they are the only approver", () => {
    const { recipients } = approvalRequestRecipients([BRENDAN], BRENDAN);
    expect(recipients).toEqual([BRENDAN]);
  });

  it("a NON-approver requester is not told about their own action", () => {
    // Kim sends it; she can't approve it, so it isn't in her queue.
    const { recipients, actorIsApprover } = approvalRequestRecipients(
      [BRENDAN, STEPH],
      "u-kim"
    );
    expect(actorIsApprover).toBe(false);
    expect(recipients).toEqual([BRENDAN, STEPH]);
  });

  it("never tells nobody — a gated proposal in silence is the worst outcome", () => {
    // Degenerate data (the only approver is somehow not in the list) must still
    // reach someone, or the proposal sits in pending_approval forever.
    expect(approvalRequestRecipients([STEPH], STEPH).recipients).toEqual([STEPH]);
    expect(approvalRequestRecipients([], null).recipients).toEqual([]);
  });

  it("no acting user (a system action) tells every approver", () => {
    expect(approvalRequestRecipients([BRENDAN, STEPH], null).recipients).toEqual([
      BRENDAN,
      STEPH,
    ]);
  });
});
