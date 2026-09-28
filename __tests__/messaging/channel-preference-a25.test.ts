/**
 * A25 — honour a stated communication preference.
 *
 * The rule is critical and binding, and before this it had no implementation
 * at all: nothing in lib/ or app/ referenced A25. Worse than absent, the
 * intent guide pointed the other way — `transferred` read "Use this for a
 * text-only preference", instructing a handoff exactly where Kate says the
 * handoff IS the defect.
 */
import { describe, it, expect } from "vitest";
import { END_STATES } from "@/lib/messaging/db";
import {
  statedChannelPreference, phoneBranch, holdsCallbackTime,
} from "@/lib/messaging/channel-preference";
import { INTENT_GUIDE } from "@/lib/messaging/agent-output";

describe("A25 — reading the channel somebody asked for", () => {
  const cases: Array<[string, ReturnType<typeof statedChannelPreference>]> = [
    // EMAIL ONLY — stop texting, carry on by email.
    ["Please email me instead of texting", "email_only"],
    ["Can you just email me going forward", "email_only"],
    ["stop texting me, use email please", "email_only"],
    ["I'd rather you emailed me", "email_only"],

    // TEXT ONLY — keep texting. Ending here is the defect.
    ["Text only please, I can't take calls", "text_only"],
    ["Don't call me, just text", "text_only"],

    // PHONE — hand to a human, after capturing when.
    ["Can you give me a call?", "phone"],
    ["I'd rather speak to someone", "phone"],
    ["please call me back", "phone"],
  ];

  for (const [text, want] of cases) {
    it(`${JSON.stringify(text)} -> ${want}`, () => {
      expect(statedChannelPreference(text)).toBe(want);
    });
  }
});

describe("A25 — what is NOT a channel preference", () => {
  /**
   * Kate: "THE PREFERENCE IS A CHANNEL, NOT A QUOTE FORMAT. Someone asking to
   * be emailed instead of texted is this rule. Someone asking for the QUOTE
   * ITSELF by text is an A7 off-site reason — different thing."
   *
   * These matter more than the positives. Inventing an email-only preference
   * STOPS TEXTING a live lead on evidence that was never there.
   */
  const notAPreference = [
    "Can you just email me the quote?",          // A7, quote delivery
    "Just text me the estimate when it's ready", // A7 as well
    "Could you email over the pricing instead",  // still the quote
    "I need my kitchen painted",                 // nothing to do with channel
    "Sounds good, thanks",
    "I'll email you the photos tonight",         // THEY are emailing US
    "",
  ];

  for (const text of notAPreference) {
    it(`${JSON.stringify(text)} states no preference`, () => {
      expect(statedChannelPreference(text)).toBeNull();
    });
  }

  it("a plain reply by text is not a declared text-only preference", () => {
    // Kate: "wanting to carry on THIS conversation by text rather than take
    // calls is neither." An exclusivity word is required.
    expect(statedChannelPreference("yeah text is fine")).toBeNull();
    expect(statedChannelPreference("texting works")).toBeNull();
  });
});

describe("A25 — the phone branch captures WHEN before it ends", () => {
  // Kate, 2026-09-18: "the bot must GATHER THEIR CALLBACK TIME PREFERENCE
  // FIRST if it does not already have it. Ending without capturing when to
  // call is the defect."
  it("asks for a callback time when we hold none", () => {
    expect(phoneBranch({})).toBe("ask_callback_time");
    expect(phoneBranch({ unreachableStartHour: null, availability: "  " }))
      .toBe("ask_callback_time");
  });

  it("hands straight over when a reachability constraint is already on file", () => {
    expect(holdsCallbackTime({ unreachableStartHour: 9 })).toBe(true);
    expect(phoneBranch({ unreachableStartHour: 9 })).toBe("hand_to_human");
  });

  it("hands straight over when availability was captured", () => {
    expect(phoneBranch({ availability: "weekday mornings" })).toBe("hand_to_human");
  });

  it("treats hour 0 as a real constraint, not as missing", () => {
    // A falsy-number bug here would re-ask somebody who already answered,
    // which is an A11 redundant ask.
    expect(holdsCallbackTime({ unreachableStartHour: 0 })).toBe(true);
  });
});

describe("A25 — the intent guide no longer contradicts the rule", () => {
  it("does not tell the model to transfer a text-only preference", () => {
    // The original read "Use this for a text-only preference, ...". Kate:
    // "the text-only and email-only branches CONTINUE the conversation in the
    // channel the customer named."
    expect(INTENT_GUIDE.transferred).not.toMatch(/use this for a text-only preference/i);
  });

  it("says plainly that a text-only preference keeps texting", () => {
    expect(INTENT_GUIDE.transferred).toMatch(/text-only/i);
    expect(INTENT_GUIDE.transferred).toMatch(/A25/);
  });
});

/**
 * THE SCREEN A RATER READS HAD THE OLD RULE ON IT.
 *
 * agent-output's intent guide was corrected when Kate ruled that a text-only
 * preference is NOT a handoff, and check-rules-are-wired forbids the old
 * wording there. END_STATES — the list shown on the Chatbot screen, which is
 * what somebody GRADING a conversation reads — still said:
 *
 *   Transferred: "Text-only preference, another language, or asked to meet at
 *                 the office."
 *
 * Both halves stopped being true. A25's correction covers the first; A30
 * covers the second, and the system prompt says it outright: "Do NOT choose
 * `transferred` because of the language."
 *
 * A rater reading that would expect a handoff for Spanish and mark a correct
 * answer wrong — the grading equivalent of a bug in the bot.
 */
describe("what the grading screen says a transfer is", () => {
  const transferred = END_STATES.find((e) => e.key === "transferred");

  it("no longer OPENS by listing a text-only preference as a cause", () => {
    // The old string began "Text-only preference, another language, ...". The
    // new one may still say the words — it has to, to say they are NOT causes
    // — so the assertion is about the claim, not the vocabulary.
    expect(transferred?.when).not.toMatch(/^Text-only preference/i);
    expect(transferred?.when).not.toMatch(/Text-only preference, another language/i);
  });

  it("no longer says another language is a cause", () => {
    expect(transferred?.when).not.toMatch(/,\s*another language/i);
  });

  it("says plainly that neither one is", () => {
    expect(transferred?.when).toMatch(/NOT a text-only preference/i);
    expect(transferred?.when).toMatch(/spanish/i);
  });

  it("keeps Hatch's label, which is what makes a parallel run comparable", () => {
    expect(transferred?.label).toBe("Transferred");
  });
});

/**
 * THE GUIDE THE MODEL READS AND THE DEFINITION THE OFFICE READS MUST AGREE.
 *
 * END_STATES says bailout covers "Wrong person, chose another company,
 * something negative, or vulgar language". The INTENT_GUIDE said only "they
 * have said they are not going ahead".
 *
 * Played in the simulator: "stop wasting my time you idiots, this is garbage"
 * came back as `discard`, which the guide describes as "not a real lead" —
 * a fair reading of what it was given. Both endings are silent and both hand
 * to a person, so nothing visible went wrong. The OUTCOME LABEL was wrong,
 * and "Ended in the right state" is one of the rules conversations are graded
 * on, so a mislabelled ending is a wrong row in every outcome report.
 */
describe("the intent guide agrees with the outcome definitions", () => {
  it("tells the model that abuse is a bailout", () => {
    expect(INTENT_GUIDE.bailout).toMatch(/abusive|vulgar/i);
  });

  it("and the office's definition still says so too", () => {
    const bailout = END_STATES.find((e) => e.key === "bailout");
    expect(bailout?.when).toMatch(/vulgar/i);
  });

  it("keeps discard about what it is actually for", () => {
    // "Not an estimate request, or work we do not cover" — not a tone.
    expect(INTENT_GUIDE.discard).not.toMatch(/abusive|vulgar/i);
  });
});
