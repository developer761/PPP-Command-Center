import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A decline must never be answered — or recorded — as an acceptance.
 *
 * Found while probing the NURTURE track, which had five scenarios to the new
 * lead track's sixty-six. `accepted` was legal after every form of decline,
 * so "we went with someone else" could be answered:
 *
 *   "That's great to hear! I'll let the office know so they can get started."
 *
 * Two harms, and the second is quieter. The message reads as though nobody
 * listened. And the conversation is recorded as ACCEPTED when it is lost —
 * the same failure outcomeForExit exists to stop, where "every exit wrote
 * success" made a bot that drives people away look like a bot that books.
 */
const ctx = (customerText: string) => ({
  customerText, track: "nurture",
  knownFields: { inquiryScope: true }, addressGap: null,
  templateAsks: () => false, customerMessages: [], flowStage: 1,
}) as never;

const act = (customerText: string, intent: string) =>
  validateAction({ intent, confidence: 0.97, freeText: "" }, ctx(customerText));

describe("a declined quote is not an accepted one", () => {
  it.each([
    "we went with someone else",
    "not interested, thanks",
    "we're not moving forward",
    "no thanks, we already hired someone",
    "we'll pass for now",
  ])("refuses `accepted` after %j", (said) => {
    const v = act(said, "accepted");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("recorded_a_decline_as_acceptance");
  });

  it.each([
    "yes let's go ahead",
    "sounds good, book it in",
    "we'd like to proceed",
    "that works for us",
  ])("still accepts a real acceptance: %j", (said) => {
    expect(act(said, "accepted").ok).toBe(true);
  });

  /** The warm close is what this state is for, and must stay open. */
  it.each(["lost", "bailout", "acknowledge_negative"])(
    "leaves %s open after a decline", (intent) => {
      expect(act("we went with someone else", intent).ok).toBe(true);
    });
});
