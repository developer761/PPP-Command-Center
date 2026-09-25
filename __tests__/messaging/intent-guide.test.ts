import { describe, it, expect } from "vitest";
import { intentGuideFor, intentsForTrack, INTENT_GUIDE } from "@/lib/messaging/agent-output";

/**
 * The tool schema used to hand the model the enum and nothing else —
 * twenty-five bare names under "What to do next." So it had to infer what
 * schedule_follow_up and transferred meant from the strings, and playing a
 * customer in the simulator showed it does not:
 *
 *   "dont text me just call me"  ->  ask_availability, refused out_of_order,
 *                                    and the customer got nothing.
 *   "Hola... No hablo ingles."   ->  answered in English, no transfer.
 *
 * Kate has a tag for both. A callback "ended as Schedule Follow-up rather
 * than continuing to text"; another language "today this means transferring".
 */
describe("every intent tells the model what it is for", () => {
  it.each(["new_lead", "nurture"] as const)("%s has guidance for every intent it may choose", (track) => {
    const missing = intentsForTrack(track).filter((i) => !INTENT_GUIDE[i]?.trim());
    expect(missing, `intents with no guidance on ${track}`).toEqual([]);
  });

  it.each(["new_lead", "nurture"] as const)("%s renders one line per intent", (track) => {
    const lines = intentGuideFor(track).split("\n");
    expect(lines).toHaveLength(intentsForTrack(track).length);
    expect(intentGuideFor(track)).not.toContain("no guidance written");
  });

  /** The two Kate wrote tags for, which were the two being chosen wrongly. */
  it("says a callback stops the texting rather than continuing it", () => {
    expect(INTENT_GUIDE.schedule_follow_up).toMatch(/call/i);
    expect(INTENT_GUIDE.schedule_follow_up).toMatch(/stop texting|end here/i);
  });

  it("says another language is handed to the office", () => {
    expect(INTENT_GUIDE.transferred).toMatch(/language/i);
  });

  /**
   * A9, verbatim: "Summarize scope/project details in the bot's OWN WORDS —
   * but ONLY scope pulled FROM FILE. Never restate scope the customer just
   * typed in chat."
   */
  it("says confirm_scope reads the record back, never the customer", () => {
    expect(INTENT_GUIDE.confirm_scope).toMatch(/record/i);
    expect(INTENT_GUIDE.confirm_scope).toMatch(/never/i);
  });

  it("does not leak a price or a time into the guidance", () => {
    for (const [intent, line] of Object.entries(INTENT_GUIDE)) {
      expect(line, intent).not.toMatch(/\$|\b\d{1,2}\s*(?:am|pm)\b/i);
    }
  });
});
