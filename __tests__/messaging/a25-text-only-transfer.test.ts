import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A25 — "Honor a stated communication preference."
 *
 * The intent guide for `transferred` already SAYS this: "NOT for a text-only
 * preference either: A25 says somebody who asks to be texted rather than
 * called should keep being TEXTED, and handing them off is the defect that
 * rule exists to stop."
 *
 * Nothing enforced it. With the customer's words "text only please, don't
 * call", `transferred` was allowed and sent "I'm passing you over to our
 * office now" — the one thing they asked us not to do.
 *
 * statedChannelPreference had existed and been tested all along;
 * record-inbound.ts uses it and the validator never did.
 */
const ctx = (customerText: string) => ({
  customerText,
  customerMessages: [],
  knownFields: { address: true, inquiryScope: true },
  addressGap: null,
  templateAsks: () => false,
  flowStage: 2,
}) as never;

const act = (customerText: string, intent: string) =>
  validateAction({ intent, confidence: 0.97, freeText: "" }, ctx(customerText));

describe("A25 — a text-only customer is not handed to the office", () => {
  it.each([
    "text only please, don't call",
    "don't ring me, just text",
  ])("refuses transferred after %j", (said) => {
    const v = act(said, "transferred");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("transferred_a_text_only_customer");
  });

  /**
   * This is about abandoning the CHANNEL, not about never ending. A
   * text-only customer who declines the work has still declined it.
   */
  it.each(["lost", "bailout", "acknowledge", "schedule_follow_up"])(
    "leaves %s alone", (intent) => {
      expect(act("text only please, don't call", intent).ok).toBe(true);
    },
  );

  /**
   * email_only is the OPPOSITE case: we cannot send email, so the office is
   * exactly where it belongs. Getting this backwards would strand them.
   */
  it("still transfers an email-only customer", () => {
    expect(act("email only please", "transferred").ok).toBe(true);
  });

  /**
   * A phone preference needs a callback time captured first — A25's other
   * half — which the RENDERER owns via phoneBranch. The validator cannot see
   * the callback, so refusing here would strand somebody who asked to be
   * rung. Deliberately untouched, and pinned so it stays that way.
   */
  it("leaves a phone preference to the renderer's callback branch", () => {
    expect(act("please call me instead", "transferred").ok).toBe(true);
  });

  it("does nothing when no preference was stated", () => {
    expect(act("we need to talk to someone at the office", "transferred").ok).toBe(true);
  });

  /**
   * A KNOWN GAP, recorded rather than quietly fixed.
   *
   * statedChannelPreference returns null for "please don't call me, text is
   * better" — it names an alternative, so it arguably IS a text-only
   * preference, and this guard therefore misses it. The detector is also
   * used by record-inbound.ts to route real conversations, so widening it
   * needs its own scoring pass against the corpus rather than a change
   * slipped in behind an A25 fix. Asserted as-is so the day it changes,
   * this test says so.
   */
  it("misses a preference the detector does not recognise (known gap)", () => {
    expect(act("please don't call me, text is better", "transferred").ok).toBe(true);
  });
});
