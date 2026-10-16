import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A8 — "carried on with a covered job instead of discarding it."
 *
 * `discard` was allowed on every core PPP service, and the customer is told
 * "I don't believe this is something we take on." A lead asking for exactly
 * what the company sells, turned away.
 *
 * ── THE DISCRIMINATOR ───────────────────────────────────────────────────
 *
 * discard has two legitimate uses — work outside the service list, and a
 * wrong number — so refusing it whenever nothing out-of-scope is named would
 * break the second. The pair that separates them:
 *
 *   the CURRENT message describes work   (scopeFromCustomer on the text)
 *   and names nothing we do not do        (mentionsWorkWeDoNotDo)
 */
const ctx = (customerText: string) => ({
  customerText,
  knownFields: { inquiryScope: true },
  addressGap: null,
  templateAsks: () => false,
  customerMessages: [],
  flowStage: 1,
}) as never;

const discard = (customerText: string) =>
  validateAction({ intent: "discard", confidence: 0.97, freeText: "" }, ctx(customerText));

describe("A8 — the bot does not turn away work PPP does", () => {
  it.each([
    "I need my living room painted",
    "I want my kitchen cabinets refinished",
    "Can you power wash my patio",
    "I need wallpaper hung in the hall",
    "I need skim coating in the bedroom",
  ])("refuses discard on %j", (t) => {
    const v = discard(t);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("discarded_work_we_cover");
  });

  /** Work genuinely outside the list — discard is the honest answer. */
  it.each([
    "Can you reupholster my sofa",
    "I need my roof replaced",
  ])("still discards %j", (t) => {
    expect(discard(t).ok).toBe(true);
  });

  /**
   * Junk describes no work at all, so the first half of the test is false
   * and discard stays available. Breaking this would leave junk
   * conversations with nowhere to go.
   *
   * "wrong number mate" WAS HERE, and since 2026-10-16 it ends as bailout
   * instead — Kate's END_STATES give "Wrong person" to Bailout, and
   * wrong-number-bailout.test.ts holds that. What this case protected is
   * still true: the A8 check does not refuse a discard for it. The wrong
   * number rule does, for a different reason, so it is asserted as THAT
   * reason rather than dropped.
   */
  it.each(["who is this?", "stop", "Is this Joe's Pizza?"])("still discards junk: %j", (t) => {
    expect(discard(t).ok).toBe(true);
  });

  it("refuses discard on a wrong number for the wrong-number reason, not A8's", () => {
    const v = discard("wrong number mate");
    expect(v.ok === false && v.reason).toBe("wrong_number_not_bailout");
  });

  /**
   * THE NARROWING address-dodged.test.ts FORCED, kept as its own case.
   *
   * The first version read ctx.scopeFromCustomer — a CONVERSATION-level fact
   * — and combined it with this turn's text. A customer who gave their scope
   * three turns ago and then asked about times was treated as describing
   * covered work in a message describing none. It now reads the scope out of
   * the CURRENT message, which is what was actually verified.
   */
  it("does not fire on a message that describes no work, whatever came before", () => {
    expect(discard("what times do you have available this week?").ok).toBe(true);
  });
});
