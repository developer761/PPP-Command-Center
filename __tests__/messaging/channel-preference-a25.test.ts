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
import { removeFromCadence, readsAsADisposition } from "@/lib/messaging/call-signals";
import { END_STATES } from "@/lib/messaging/db";
import {
  statedChannelPreference, phoneBranch, holdsCallbackTime,
  callbackIsInHours, CALLBACK_WINDOW,
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

/**
 * ── A TIME NOBODY IS THERE FOR IS NOT A CAPTURED TIME ───────────────────
 *
 * Kate, 2026-09-28, spelling the cadence out:
 *
 *   "customer states they want to continue booking convo via call rather
 *    than text/email > bot captures the call back time > if call back time
 *    is within business hours, state 'we will reach out then', if call back
 *    time is outside of business hours, state business hours + ask if there
 *    is a time that works for them within that timeframe."
 *
 * So holding "call me at 11pm" is holding a time, and handing that to a
 * person as though it were bookable is the same defect as capturing nothing.
 */
describe("a callback time outside the office window", () => {
  it("asks for one inside the hours, rather than handing over", () => {
    expect(phoneBranch({ requestedHour: 23 })).toBe("callback_outside_hours");
    expect(phoneBranch({ requestedHour: 7 })).toBe("callback_outside_hours");
  });

  it("hands over when the hour is one we could call in", () => {
    expect(phoneBranch({ requestedHour: 9 })).toBe("hand_to_human");
    expect(phoneBranch({ requestedHour: 18 })).toBe("hand_to_human");
  });

  it("treats a named hour as a captured time, so it does not ask twice", () => {
    // "Call me at 6" used to leave holdsCallbackTime false, so the branch
    // asked "what's a good time to reach you?" — the A11 redundant ask this
    // whole branch exists to avoid.
    expect(holdsCallbackTime({ requestedHour: 18 })).toBe(true);
    expect(phoneBranch({ requestedHour: 18 })).not.toBe("ask_callback_time");
  });

  it("still asks when they named no hour at all", () => {
    // null is "nothing to check", NOT "outside". A missing answer must not
    // become a correction.
    expect(callbackIsInHours(null)).toBeNull();
    expect(callbackIsInHours(undefined)).toBeNull();
    expect(phoneBranch({})).toBe("ask_callback_time");
  });

  it("closes the window at the hour the office shuts", () => {
    // 8pm is when it ends, so a call placed at 8pm is not one we can promise.
    expect(callbackIsInHours(CALLBACK_WINDOW.endHour)).toBe(false);
    expect(callbackIsInHours(CALLBACK_WINDOW.startHour)).toBe(true);
  });
});

/**
 * ── THE NOTIFICATION A25 OWES, WHICH DID NOT EXIST ──────────────────────
 *
 * The spec: "the bot continues the conversation in that channel and sends a
 * notification to the team to remove them from the Salesforce call cadence",
 * and, settled 24 September, "this stays a notification and an agent removes
 * them in Salesforce — build the signal, not the cadence edit."
 *
 * `statedChannelPreference` was built and tested and had zero production
 * callers, and there was no signal kind for it — so a customer saying "stop
 * calling me, just text" stayed in the call cadence indefinitely.
 */
describe("the remove-from-cadence notification", () => {
  const sig = (preference: "text_only" | "email_only") =>
    removeFromCadence({ conversationId: "c1", leadId: "00Q1", preference });

  it("is its own kind, not a pause", () => {
    /**
     * The spec says so outright, because the two have already been read as
     * one: "A pause is temporary; A25 is permanent… Do not implement one as
     * the other."
     */
    expect(sig("text_only").kind).toBe("remove_from_cadence");
    expect(sig("text_only").kind).not.toBe("pause_calling");
  });

  it("carries the lead and the conversation, and nothing else", () => {
    // The spec names three fields and no more.
    expect(Object.keys(sig("email_only")).sort())
      .toEqual(["conversationId", "kind", "leadId", "note"]);
  });

  it("names the channel they asked for", () => {
    expect(sig("email_only").note).toMatch(/by email/i);
    expect(sig("text_only").note).toMatch(/by text/i);
  });

  it("does not read as a verdict on the lead", () => {
    // They have said how they want to be contacted, not that they are
    // uninterested. "A notification that reads as 'this lead is done' is the
    // failure to avoid."
    const note = sig("text_only").note;
    expect(readsAsADisposition(note)).toBe(false);
    expect(note).toMatch(/still in conversation/i);
  });

  it("says a person makes the change, not the bot", () => {
    // Iteration 1 builds the signal, never the cadence edit.
    expect(sig("text_only").note).toMatch(/Salesforce/);
    expect(sig("text_only").note).toMatch(/someone needs to/i);
  });
});

/**
 * THE INVERSION, 2026-10-05.
 *
 * statedChannelPreference asked "is there a text word AND an exclusivity
 * word", counting "don't" as exclusivity. So a customer asking to be CALLED
 * was recorded as wanting TEXT:
 *
 *   "please call me instead of texting"    -> text_only
 *   "stop texting me and call me instead"  -> text_only
 *   "dont text me just call me"            -> text_only
 *
 * Worse than useless: a stated preference outranks the default, and A25's
 * notification would have told the team to take them off the CALL cadence —
 * the one channel they had just asked for. Found while wiring Kate's ruling
 * that this case routes to a person.
 *
 * Each of these names TWO channels and means opposite things by them, which
 * is the whole difficulty. Pinned individually because a single regex change
 * can flip any one of them on its own.
 */
describe("a refusal of one channel is never a request for it", () => {
  it.each([
    ["dont text me just call me", "phone"],
    ["don't text me, just call me", "phone"],
    ["stop texting me and call me instead", "phone"],
    ["please call me instead of texting", "phone"],
    ["stop calling me, just text", "text_only"],
    ["dont call me just email me", "email_only"],
    ["email me instead of texting", "email_only"],
    ["text me rather than calling", "text_only"],
    ["stop texting me, use email please", "email_only"],
  ])("%j -> %s", (said, expected) => {
    expect(statedChannelPreference(said)).toBe(expected);
  });

  /** Naming a channel is not asking for it. */
  it.each([
    "I'll email you the photos tonight",
    "sounds good",
    "yes that works",
    "can you just email me the quote",
  ])("%j states no preference", (said) => {
    expect(statedChannelPreference(said)).toBeNull();
  });

  /**
   * A refusal with no alternative is an OPT-OUT, not a preference. Returning
   * one here would quietly downgrade it; compliance.ts owns that call.
   */
  it("a bare refusal names no preference", () => {
    expect(statedChannelPreference("stop texting me")).toBeNull();
    expect(statedChannelPreference("no more emails please")).toBeNull();
  });
});
