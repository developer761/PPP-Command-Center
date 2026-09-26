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
