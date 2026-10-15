import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";
import { declinesTheWork } from "@/lib/messaging/parking";

/**
 * A17 — "Not moving forward means stop pursuing."
 *
 * After "We're not moving forward", ask_availability, ask_contact and
 * schedule_follow_up were ALL still open and every pursuing sentence was
 * allowed. Kate's corrective is one word: "stopped pursuing".
 */
const ctx = (customerText: string) => ({
  customerText,
  knownFields: { address: true, inquiryScope: true },
  addressGap: null,
  templateAsks: () => false,
  customerMessages: [],
  flowStage: 3,
}) as never;

const act = (customerText: string, intent: string) =>
  validateAction({ intent, confidence: 0.97, freeText: "" }, ctx(customerText));

describe("A17 — chasing stops when they say no", () => {
  const declines = [
    "We're not moving forward",
    "Not interested, thanks",
    "No thanks, we already hired someone",
    "we're going to hold off",
  ];

  it.each(declines)("refuses the collecting intents after %j", (said) => {
    for (const intent of ["ask_availability", "ask_contact", "ask_address"]) {
      const v = act(said, intent);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.reason).toBe("pursued_after_a_decline");
    }
  });

  /**
   * The warm close is the POINT of the rule, not collateral. Breaking this
   * would leave a declining customer with nothing to receive at all.
   */
  it.each(declines)("keeps the warm close open after %j", (said) => {
    for (const intent of ["lost", "bailout", "acknowledge_negative"]) {
      expect(act(said, intent).ok).toBe(true);
    }
  });
});

/**
 * The decline test lives in parking.ts because telling a decline from a park
 * is what that file exists to do. These pin the two corrections made to it.
 */
describe("what counts as a decline", () => {
  it.each([
    "We're not moving forward",
    "we're going to hold off",
    "we'll pass for now",
    "we don't need it anymore",
  ])("now recognises %j", (t) => {
    expect(declinesTheWork(t)).toBe(true);
  });

  /**
   * NARROWING THE JOB USES THE SAME WORDS AS DECLINING IT, and the two fail
   * in opposite directions: reading a narrowing as a decline abandons a live
   * job. A real decline names no work they still want.
   */
  it.each([
    "we decided not to paint the exterior, just inside",
    "no thanks to the cabinets, just the rooms",
    "not the ceilings, only the walls",
  ])("does not read the narrowing %j as a decline", (t) => {
    expect(declinesTheWork(t)).toBe(false);
  });

  it("keeps chasing available after a narrowing", () => {
    expect(act("we decided not to paint the exterior, just inside", "ask_contact").ok).toBe(true);
  });
});
