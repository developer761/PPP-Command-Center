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

/**
 * ── A LIKE IS NOT A REASON TO STOP ──────────────────────────────────────
 *
 * Kate's Iteration 1 spec, in its own words: "No conversation ends on a
 * reaction while the required flow is incomplete." It also says what the
 * failure costs — Hatch read a reaction as text, the bot answered its own
 * question, and "one conversation ended that way and lost a full exterior
 * repaint".
 *
 * Two things were wrong and they compounded. `lastAskedForInfo` was passed by
 * the sandbox and not by production, so every real reaction took the
 * "informational" branch and was told to end as Msg Liked/Loved. And
 * `msg_liked_loved` sat in no completeness set, so that ending was allowed
 * with nothing collected — and it sends no message, so there was not even a
 * reply to notice.
 */
describe("a reaction cannot close an unfinished conversation", () => {
  it("refuses Msg Liked/Loved while legs are outstanding", () => {
    const res = validateAction(act("msg_liked_loved"), {
      customerText: "👍",
      priorIntents: ["ask_project_details", "ask_address"],
    } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("reaction_ended_an_open_conversation");
    expect(res.detail).toMatch(/still outstanding/i);
  });

  it("names which legs are still owed, so the retry can be right", () => {
    const res = validateAction(act("msg_liked_loved"), {
      customerText: "❤️",
      priorIntents: ["ask_project_details"],
    } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Not "you cannot do that" — the missing fields by name.
    expect(res.detail.length).toBeGreaterThan(30);
  });

  it("allows it once the flow is complete", () => {
    // A like on a finished conversation IS a silent ending, and should stay
    // one — answering it is one more message to somebody signing off.
    const res = validateAction(act("msg_liked_loved"), {
      customerText: "👍",
      priorIntents: [
        "ask_project_details", "ask_address", "ask_contact", "ask_availability",
      ],
    } as never);
    expect(res.ok).toBe(true);
  });
});

/**
 * The input that decides what a reaction MEANS. Production did not pass it,
 * so it defaulted to false and every reaction read as agreement.
 */
describe("what a reaction means depends on what we just asked", () => {
  it("is not an answer when the last message asked for something", () => {
    expect(reactionResponse(normalizeInbound("Liked “What's the address?”"), true))
      .toMatchObject({ treatAs: "not_an_answer" });
  });

  it("is agreement when the last message was informational", () => {
    expect(reactionResponse(normalizeInbound("Liked “We'll see you Tuesday.”"), false))
      .toMatchObject({ treatAs: "confirmation" });
  });
});

/**
 * ── THE THIRD BRANCH: A YES/NO QUESTION ─────────────────────────────────
 *
 * Kate's spec: "A reaction on a yes/no question is the answer: like or heart
 * means yes, thumbs-down means no. Acknowledge and advance. On an open
 * question it is not an answer — rephrase."
 *
 * There were two branches, not three — informational or a question — so
 * "Would you like us to send the quote over instead?" answered with a heart
 * was read as agreement with a statement, and the yes was never recorded.
 */
describe("a reaction on a yes/no question", () => {
  const react = (text: string, askedForInfo: boolean, yesNo: boolean) =>
    reactionResponse(normalizeInbound(text), askedForInfo, yesNo);

  it("is the answer, and the conversation advances", () => {
    const r = react("Liked “Would you like us to send it over?”", false, true);
    expect(r.treatAs).toBe("answers_yes_no");
    expect(r.guidance).toMatch(/that is a yes/i);
    expect(r.guidance).toMatch(/move to the next step/i);
  });

  it("does not end the conversation on it", () => {
    // msg_liked_loved is silent, so ending here loses the yes AND says
    // nothing — the failure that cost a full exterior repaint.
    expect(react("Loved “Shall we book you in?”", false, true).guidance)
      .toMatch(/do not end the conversation/i);
  });

  it("is still not an answer on an OPEN question", () => {
    expect(react("Liked “What's the address?”", true, false).treatAs).toBe("not_an_answer");
  });

  it("beats the open-question branch when both could apply", () => {
    // An ask_ intent whose sentence happens to be a yes/no question is still
    // a question the reaction answers.
    expect(react("Liked “Is 9am ok?”", true, true).treatAs).toBe("answers_yes_no");
  });

  it("is never agreement when the reaction is negative", () => {
    // The negative branch returns first, whatever was asked.
    expect(react("Disliked “Shall we book you in?”", false, true).treatAs).toBe("not_an_answer");
  });
});
