import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";
import { normalizeInbound, reactionResponse } from "@/lib/messaging/inbound-normalize";

const act = (intent: string) => ({ intent, freeText: "", confidence: 0.95, reasoning: "" });

/**
 * Karan sent a thumbs-down and got the same question reworded back.
 *
 * The classification was right and the guidance was right. What was missing
 * was an ACTION: the only outlets for a customer who reacted badly were
 * re-asking or escalating, so it re-asked — and the renderer's variant
 * rotation made a repeat look like a rephrase while being the same question.
 */
describe("a customer who reacts badly", () => {
  it("is not asked the same thing again, however it is worded", () => {
    const res = validateAction(act("ask_project_details"), {
      negativeReaction: true, lastIntent: "ask_project_details",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("repeated_after_negative");
  });

  it("can be acknowledged instead", () => {
    expect(validateAction(act("acknowledge_negative"), {
      negativeReaction: true, lastIntent: "ask_project_details",
    }).ok).toBe(true);
  });

  it("can be handed to a person instead", () => {
    expect(validateAction(act("escalate"), {
      negativeReaction: true, lastIntent: "ask_project_details",
    }).ok).toBe(true);
  });

  it("can still be moved forward with a different question", () => {
    expect(validateAction(act("ask_address"), {
      negativeReaction: true, lastIntent: "ask_project_details", stage: 1,
    }).ok).toBe(true);
  });

  /** Repeating a question is normal when nobody objected to it. */
  it("does not block a repeat when there was no negative reaction", () => {
    expect(validateAction(act("ask_project_details"), { lastIntent: "ask_project_details" }).ok).toBe(true);
  });

  it("says something that does not re-ask", () => {
    for (const turn of [0, 1, 2]) {
      const out = renderMessage({ intent: "acknowledge_negative", turn });
      expect(out.length).toBeGreaterThan(0);
      expect(out, out).not.toMatch(/painted|address|email/i);
    }
  });
});

describe("what the model is told a customer sent", () => {
  it("recognises a bare thumbs-down as negative", () => {
    const n = normalizeInbound("👎");
    expect(n.reaction?.sentiment).toBe("negative");
    expect(reactionResponse(n, true).treatAs).toBe("not_an_answer");
  });

  /**
   * An angry face reported as "thumbs down" is a false statement about the
   * conversation, and anger and mild irritation call for different replies.
   */
  it("does not describe an angry face as a thumbs-down", () => {
    expect(normalizeInbound("😡").description).toMatch(/angry/i);
    expect(normalizeInbound("😡").description).not.toMatch(/thumbs down/i);
    expect(normalizeInbound("🙄").description).toMatch(/exasperated/i);
    expect(normalizeInbound("👎").description).toMatch(/thumbs down/i);
  });

  it("still reads them all as negative", () => {
    for (const e of ["👎", "😡", "🙄", "😤", "🤬"]) {
      expect(normalizeInbound(e).reaction?.sentiment, e).toBe("negative");
    }
  });

  it("never treats a negative reaction as agreement", () => {
    // Reading a thumbs-down on "checking our schedule" as a yes is worse than
    // reading it as nothing at all.
    expect(reactionResponse(normalizeInbound("👎"), false).treatAs).toBe("not_an_answer");
  });
});
