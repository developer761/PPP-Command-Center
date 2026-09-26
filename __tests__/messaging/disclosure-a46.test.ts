/**
 * A46 — the bot never claims to be a person.
 *
 * Both strings are APPROVED FINAL TEXT and the spec says to build against
 * them "byte for byte, straight apostrophes included", so they are asserted
 * as exact literals rather than by shape. A test that matched loosely would
 * let a tidied apostrophe or a reflowed clause through, which is precisely
 * what "byte for byte" rules out.
 */
import { describe, it, expect } from "vitest";
import {
  DISCLOSURE_IN_HOURS, DISCLOSURE_OUT_OF_HOURS,
  DISCLOSURE_IN_HOURS_ES, DISCLOSURE_OUT_OF_HOURS_ES,
  disclosureMove, applyDisclosure, alreadyDisclosed,
} from "@/lib/messaging/disclosure";
import { renderMessage, isSilent } from "@/lib/messaging/render";
import { END_INTENTS, CONTINUE_INTENTS } from "@/lib/messaging/agent-output";

describe("A46 — the approved strings, byte for byte", () => {
  it("in hours", () => {
    expect(DISCLOSURE_IN_HOURS).toBe(
      "I'm an AI assistant, but I can take your project details and get you set up with an estimator. Would you prefer to speak with a member of our team?"
    );
  });

  it("out of hours", () => {
    expect(DISCLOSURE_OUT_OF_HOURS).toBe(
      "I'm an AI assistant, but I can take your project details and pass them along once we open."
    );
  });

  it("uses STRAIGHT apostrophes, which the spec calls out explicitly", () => {
    for (const s of [DISCLOSURE_IN_HOURS, DISCLOSURE_OUT_OF_HOURS]) {
      expect(s).toContain("I'm");
      expect(s).not.toContain("’");   // the typographic apostrophe
    }
  });

  /**
   * Spec: "The approved wording is a statement plus the reply already being
   * sent, so it contributes no ask of its own. Do not reintroduce an offer or
   * a question into the prefix — and no callback either."
   */
  it("the out-of-hours line carries NO ask and offers no callback", () => {
    expect(DISCLOSURE_OUT_OF_HOURS).not.toContain("?");
    expect(DISCLOSURE_OUT_OF_HOURS).not.toMatch(/\bcall\b|\bcallback\b|\bwould you\b/i);
  });

  it("the in-hours line DOES ask, which is correct — it is the whole message", () => {
    expect(DISCLOSURE_IN_HOURS).toContain("?");
    // Exactly one question, so a bare "yes" is never ambiguous (A22).
    expect(DISCLOSURE_IN_HOURS.split("?").length - 1).toBe(1);
  });

  it("neither string ever denies being a bot", () => {
    for (const s of [DISCLOSURE_IN_HOURS, DISCLOSURE_OUT_OF_HOURS,
                     DISCLOSURE_IN_HOURS_ES, DISCLOSURE_OUT_OF_HOURS_ES]) {
      expect(s).not.toMatch(/real person|a person, not|no soy un (?:bot|robot)/i);
      expect(s).toMatch(/AI assistant|inteligencia artificial/i);
    }
  });
});

describe("A46 — which wording fires when", () => {
  it("answers whenever asked, whatever the clock says", () => {
    expect(disclosureMove({ askedIfBot: true, outOfHours: false, alreadyDisclosed: false })).toBe("answer");
    expect(disclosureMove({ askedIfBot: true, outOfHours: true, alreadyDisclosed: true })).toBe("answer");
  });

  it("says NOTHING unprompted during business hours", () => {
    // Spec: "Nothing in the opener announces the bot during business hours."
    expect(disclosureMove({ askedIfBot: false, outOfHours: false, alreadyDisclosed: false })).toBeNull();
  });

  it("prefixes out of hours, on the first reply only", () => {
    expect(disclosureMove({ askedIfBot: false, outOfHours: true, alreadyDisclosed: false })).toBe("prefix");
    // "not on every message. Once the exchange is running, later replies
    // carry no prefix."
    expect(disclosureMove({ askedIfBot: false, outOfHours: true, alreadyDisclosed: true })).toBeNull();
  });
});

describe("A46 — what the customer actually receives", () => {
  it("puts the line in front of the reply that was going out anyway", () => {
    const out = applyDisclosure("prefix", "What are you looking to have painted?");
    expect(out).toBe(`${DISCLOSURE_OUT_OF_HOURS} What are you looking to have painted?`);
    // One message, not two stacked sentences that read like a system notice.
    expect(out.startsWith(DISCLOSURE_OUT_OF_HOURS)).toBe(true);
  });

  it("replaces the reply when they asked outright", () => {
    expect(applyDisclosure("answer", "anything else")).toBe(DISCLOSURE_IN_HOURS);
  });

  it("leaves the reply alone when there is nothing to do", () => {
    expect(applyDisclosure(null, "Got it.")).toBe("Got it.");
  });

  it("answers a Spanish speaker in Spanish", () => {
    expect(applyDisclosure("answer", "x", true)).toBe(DISCLOSURE_IN_HOURS_ES);
    expect(applyDisclosure("prefix", "¿Qué desea pintar?", true))
      .toBe(`${DISCLOSURE_OUT_OF_HOURS_ES} ¿Qué desea pintar?`);
  });

  it("recognises the line already sent, in either language", () => {
    expect(alreadyDisclosed([`${DISCLOSURE_OUT_OF_HOURS} What are you looking to paint?`])).toBe(true);
    expect(alreadyDisclosed([`${DISCLOSURE_OUT_OF_HOURS_ES} ¿Qué desea pintar?`])).toBe(true);
    expect(alreadyDisclosed(["Thanks! What are you looking to paint?"])).toBe(false);
    expect(alreadyDisclosed([])).toBe(false);
  });
});

describe("A46 — being asked is not an ending", () => {
  /**
   * Spec: "Asked directly in hours, the in-hours string is sent verbatim, and
   * the conversation carries on in the same thread — the question is not an
   * ending."
   *
   * It used to be in END_INTENTS, and the template handed the conversation to
   * a person: a live lead thrown away for asking a fair question.
   */
  it("bot_suspected continues the conversation", () => {
    expect([...CONTINUE_INTENTS]).toContain("bot_suspected");
    expect([...END_INTENTS]).not.toContain("bot_suspected");
  });

  it("renders the approved string and nothing else", () => {
    for (const turn of [0, 1, 2]) {
      expect(renderMessage({ intent: "bot_suspected", turn })).toBe(DISCLOSURE_IN_HOURS);
    }
  });

  it("renders the Spanish one for a Spanish conversation", () => {
    expect(renderMessage({ intent: "bot_suspected", turn: 0, language: "es" }))
      .toBe(DISCLOSURE_IN_HOURS_ES);
  });

  it("no longer hands the conversation off", () => {
    const out = renderMessage({ intent: "bot_suspected", turn: 0 });
    expect(out).not.toMatch(/someone from our team to pick this up|take it from here/i);
  });
});

/**
 * Found while wiring A46, and it belongs to a different capability.
 *
 * Iteration 1 spec, HUMAN TAKEOVER: "the bot pings the agent, and the agent
 * enters the conversation and answers the customer directly. The bot sends no
 * handover message of its own… no sign-off, no handover line, nothing that
 * reads as an ending. There is no handover message because we do not want
 * one."
 *
 * escalate rendered "Let me get one of our team on this. Someone will follow
 * up with you shortly." and that text went into the DRAFT BODY, so a reviewer
 * approving the draft sent the customer exactly the seam the spec removes.
 */
describe("Human takeover — the bot sends nothing on the way out", () => {
  it("escalate renders no words at all", () => {
    for (const turn of [0, 1, 2]) {
      expect(renderMessage({ intent: "escalate", turn })).toBe("");
    }
    expect(renderMessage({ intent: "escalate", turn: 0, language: "es" })).toBe("");
  });

  it("and is silent on purpose, not an accidentally empty template", () => {
    // A turn that renders nothing and is NOT deliberately silent is treated
    // as a dropped turn, so this has to be the deliberate kind.
    expect(isSilent({ intent: "escalate" })).toBe(true);
  });
});
