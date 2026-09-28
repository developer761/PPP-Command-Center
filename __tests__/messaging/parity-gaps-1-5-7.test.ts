/**
 * Hatch parity gaps 1, 5 and 7.
 *
 *   1  the availability ask names a week
 *   5  they ask US for times twice -> a person
 *   7  a returning customer is asked once, then we move on
 *
 * None is in the Iteration 1 spec. All three are behaviours Hatch has and we
 * did not, found by reading its live prompt.
 */
import { describe, it, expect } from "vitest";
import {
  weekToOffer, askAvailability, askAvailabilityEs, asksOurAvailability, isAvailabilityStandOff,
} from "@/lib/messaging/availability-ask";
import {
  returningCustomerDeclining, alreadyAskedToConfirm, returningCustomerReply,
  returningCustomerDecliningInThread,
} from "@/lib/messaging/returning-customer";
import { renderMessage, SAYS, isSilent } from "@/lib/messaging/render";
import { SAYS_ES } from "@/lib/messaging/render-es";
import { validateAction } from "@/lib/messaging/agent-output";

const NY = "America/New_York";

describe("gap 1 — the ask names a week", () => {
  // Hatch: Sunday-Wednesday "this week", Thursday-Saturday "next week".
  const cases: Array<[string, string, "this" | "next"]> = [
    ["Sunday", "2026-09-27T16:00:00Z", "this"],
    ["Monday", "2026-09-28T16:00:00Z", "this"],
    ["Wednesday", "2026-09-30T16:00:00Z", "this"],
    ["Thursday", "2026-10-01T16:00:00Z", "next"],
    ["Friday", "2026-10-02T16:00:00Z", "next"],
    ["Saturday", "2026-10-03T16:00:00Z", "next"],
  ];
  for (const [day, iso, want] of cases) {
    it(`${day} offers ${want} week`, () => {
      expect(weekToOffer(new Date(iso), NY)).toBe(want);
    });
  }

  it("reads the CUSTOMER's day, not the server's", () => {
    // Friday 00:30 UTC is still Thursday evening in New York.
    const d = new Date("2026-10-02T00:30:00Z");
    expect(weekToOffer(d, NY)).toBe("next");                       // Thu in NY
    expect(weekToOffer(d, "Asia/Tokyo")).toBe("next");             // Fri in Tokyo
    // And a Wednesday evening in LA is still Wednesday.
    expect(weekToOffer(new Date("2026-10-01T02:00:00Z"), "America/Los_Angeles")).toBe("this");
  });

  it("falls back to the generic ask without a usable zone", () => {
    expect(weekToOffer(new Date(), "Not/AZone")).toBeNull();
    expect(renderMessage({ intent: "ask_availability", turn: 0 }))
      .toBe("What days generally work best for you?");
  });

  it("renders Hatch's approved wording", () => {
    expect(renderMessage({
      intent: "ask_availability", turn: 0,
      now: new Date("2026-09-28T16:00:00Z"), customerZone: NY,
    })).toBe(askAvailability("this"));
  });

  /**
   * 🔴 NOT A15. A15 forbids offering, confirming or inventing a TIME. "a few
   * openings this week" names no day and no hour — it says we have capacity,
   * which is true and is not a slot.
   */
  it("names no day and no hour", () => {
    for (const w of ["this", "next"] as const) {
      expect(askAvailability(w)).not.toMatch(/\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b/i);
      expect(askAvailability(w)).not.toMatch(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i);
    }
  });
});

describe("gap 5 — they ask US for times", () => {
  for (const t of [
    "what times do you have",
    "what days work for you?",
    "when are you free",
    "what's your availability",
    "what have you got",
  ]) {
    it(`${JSON.stringify(t)} is asking us`, () => {
      expect(asksOurAvailability(t)).toBe(true);
    });
  }

  /** An ANSWER must never read as the stand-off. */
  for (const t of [
    "I'm free Tuesday",
    "mornings work",
    "anytime",
    "Tuesday works for me",
    "weekends are easier",
    "I need my kitchen painted",
  ]) {
    it(`${JSON.stringify(t)} is an answer, not a question`, () => {
      expect(asksOurAvailability(t)).toBe(false);
    });
  }

  it("once is reasonable, twice is the stand-off", () => {
    // Hatch says "insist", not "ask". A person would answer the first one.
    expect(isAvailabilityStandOff(["what times do you have"])).toBe(false);
    expect(isAvailabilityStandOff(["what times do you have", "no, when are you free?"])).toBe(true);
  });

  it("the validator refuses a third ask", () => {
    const r = validateAction({ intent: "ask_availability", confidence: 0.9 }, {
      customerMessages: ["what times do you have", "but what days work for you"],
      customerText: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("availability_stand_off");
  });

  it("and allows the ask when they have not asked back", () => {
    const r = validateAction({ intent: "ask_availability", confidence: 0.9 }, {
      customerMessages: ["I need my kitchen painted"], customerText: "sure",
    });
    expect(r.ok).toBe(true);
  });
});

describe("gap 7 — the returning customer", () => {
  it("needs BOTH halves: worked with us before AND would rather not repeat", () => {
    expect(returningCustomerDeclining("you painted my kitchen last year, don't you already have my address?")).toBe(true);
    expect(returningCustomerDeclining("you did my deck last time, why do you need it again?")).toBe(true);
  });

  it("a past job mentioned in passing is NOT a refusal", () => {
    // They are giving us work, not declining a field.
    expect(returningCustomerDeclining("you painted my kitchen last year and now I need the deck done")).toBe(false);
    expect(returningCustomerDeclining("we used you guys in 2024, great job")).toBe(false);
  });

  it("and neither is an ordinary objection from a new customer", () => {
    expect(returningCustomerDeclining("why do you need my address?")).toBe(false);
    expect(returningCustomerDeclining("")).toBe(false);
  });

  it("thanks them for the NEW project, says why, and asks once", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 0,
      customerText: "you painted my kitchen last year, don't you have my address?",
    });
    expect(out).toBe(returningCustomerReply());
    expect(out).toMatch(/again/i);           // thanks them for this one
    expect(out).toMatch(/still accurate/i);  // says why we ask
    expect(out.split("?").length - 1).toBe(1); // exactly one ask (A22)
  });

  it("moves on once it has asked — never a second time", () => {
    const said = ["you painted my kitchen last year, don't you have my address?"];
    expect(alreadyAskedToConfirm(said, [])).toBe(false);
    expect(alreadyAskedToConfirm(said, [returningCustomerReply()])).toBe(true);
  });

  it("does not fire for somebody who never declined", () => {
    expect(alreadyAskedToConfirm(["4821 Oak Lane"], [returningCustomerReply()])).toBe(false);
  });
});

/**
 * PARITY 7, FOUND IN THE PERSONA HUNT: THE ACKNOWLEDGEMENT NEVER FIRED.
 *
 * returningCustomerDeclining requires BOTH halves in ONE message, and render
 * only ever passed it the latest one. A real thread splits them:
 *
 *   turn 1  "we used you guys a couple years back for the upstairs"
 *   turn 3  → we ask for the address
 *   turn 4  "you already have it"
 *
 * Neither message carries both, so the check was false on every turn of every
 * real conversation and the bot just asked again — at the customer most likely
 * to buy again, which is the nag this rule exists to prevent.
 *
 * mentionsSecondProperty reads the whole thread for precisely this reason. This
 * did not, and 5,533 tests passed because every one of them put both halves in
 * the same string.
 */
describe("a returning customer says it over two turns, not one", () => {
  const before = "we used you guys a couple years back for the upstairs";
  const refuse = "you already have it";

  it("fires when the two halves arrive turns apart", () => {
    expect(returningCustomerDecliningInThread({ earlier: [before], latest: refuse })).toBe(true);
  });

  it("and the old single-message check could NOT see it", () => {
    // The regression, stated as the thing that used to happen.
    expect(returningCustomerDeclining(refuse)).toBe(false);
    expect(returningCustomerDeclining(before)).toBe(false);
  });

  it("still needs a refusal IN THE LATEST MESSAGE", () => {
    // Otherwise one old "again?" makes every later turn read as a refusal and
    // suppresses collection on somebody who is happily answering.
    expect(returningCustomerDecliningInThread({
      earlier: [before, refuse], latest: "sure, it's 12 Oak St, Garden City NY 11530",
    })).toBe(false);
  });

  it("never fires on somebody merely mentioning a past job", () => {
    expect(returningCustomerDecliningInThread({
      earlier: ["you painted my kitchen last year"], latest: "now I need the deck done",
    })).toBe(false);
  });

  it("reaches the renderer through the thread", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 3, customerText: refuse, customerMessages: [before],
    });
    expect(out).toMatch(/still accurate/);
  });
});

/**
 * "BUT MOVE ON IF THEY DON'T PROVIDE IT." — Hatch, verbatim.
 *
 * ONCE. alreadyAskedToConfirm was written for this and had NO CALLER, so a
 * customer who refused twice got the same apologetic paragraph twice — the nag,
 * delivered in the words of an apology for nagging.
 *
 * It also carried the SAME single-message scope bug, which is why capping it
 * did not work the first time: `.some(returningCustomerDeclining)` is false on
 * every real thread, so the cap never engaged.
 */
describe("the acknowledgement is sent once, not every turn", () => {
  const ACK = returningCustomerReply();
  const before = "we used you guys a couple years back for the upstairs";

  it("knows it has already been sent, over a real thread", () => {
    expect(alreadyAskedToConfirm([before, "you already have it"], [ACK])).toBe(true);
  });

  it("is false before we have sent it", () => {
    expect(alreadyAskedToConfirm([before, "you already have it"], ["What's the address for the project?"])).toBe(false);
  });

  it("so the second refusal gets a plain ask, not the paragraph again", () => {
    const second = renderMessage({
      intent: "ask_address", turn: 4,
      customerText: "I'm not typing it out again, you already have it",
      customerMessages: [before, "you already have it"],
      botMessages: ["What's the address for the project?", ACK],
    });
    expect(second).not.toBe(ACK);
    expect(second).not.toMatch(/still accurate/);
    expect(second.length).toBeGreaterThan(0);
  });

  it("and the FIRST refusal still gets it", () => {
    const first = renderMessage({
      intent: "ask_address", turn: 3, customerText: "you already have it",
      customerMessages: [before], botMessages: ["What's the address for the project?"],
    });
    expect(first).toBe(ACK);
  });
});

/**
 * THE STAND-OFF LEAKED THROUGH THE OTHER TEMPLATES.
 *
 * Hatch: "If they insist on knowing our availability before providing theirs,
 * End: Schedule Follow Up." The validator refuses ask_availability once the
 * stand-off is true — but the QUESTION is what the rule is about, and other
 * templates still carried one. Seen in the simulator after the customer had
 * asked twice:
 *
 *   BOT  "That's one for the estimator, and they'll go through it with you.
 *         What days suit you best?"
 *
 * defer_to_estimator is the RIGHT intent — the estimator does own the calendar
 * — so the intent stays and the trailing ask goes.
 */
describe("once they have asked us twice, nothing asks them a third time", () => {
  const asked = {
    intent: "defer_to_estimator" as const, turn: 1,
    customerText: "no, just tell me what times you have and I'll pick one",
  };

  it("drops the trailing timing question", () => {
    const out = renderMessage({ ...asked, availabilityStandOff: true });
    expect(out).not.toMatch(/\?\s*$/);
    expect(out).not.toMatch(/what (?:days|times|sort of days)/i);
  });

  it("but still answers them — it never goes silent", () => {
    const out = renderMessage({ ...asked, availabilityStandOff: true });
    expect(out.length).toBeGreaterThan(20);
    expect(out).toMatch(/estimator|office/i);
  });

  it("leaves the ordinary turn alone when there is no stand-off", () => {
    const out = renderMessage(asked);
    expect(out).toMatch(/\?\s*$/);
  });

  it("never strips a question that is not about timing", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 1, customerText: "what times do you have?",
      availabilityStandOff: true,
    });
    expect(out).toMatch(/\?\s*$/);
    expect(out).toMatch(/address|property/i);
  });

  it("keeps the message rather than emptying it", () => {
    // A turn whose ONLY sentence is a timing question keeps it: a silent turn
    // is worse than a third ask.
    const out = renderMessage({
      intent: "ask_availability", turn: 1, customerText: "ok",
      availabilityStandOff: true,
    });
    expect(out.length).toBeGreaterThan(0);
  });
});

/**
 * NO TEMPLATE MAY CLAIM WE HAVE AVAILABILITY.
 *
 * askAvailability was Hatch's sentence verbatim — "We have a few openings THIS
 * WEEK to meet with you, what would work best for you?" — and the bot has no
 * calendar to know that. The system prompt says it outright: "You never quote
 * a price and you never offer an appointment time. The office does both."
 *
 * The contradiction was total: our own validator refuses the MODEL for writing
 * that exact sentence (invented_availability, "names 'this week' with no
 * verified availability behind it"), while the TEMPLATE sent it, because
 * templates do not go through the rapport check.
 *
 * Found by reading an imported Hatch thread and recognising our own wording in
 * it. Every test passed while it was there, which is why this sweep exists.
 */
const CLAIMS_AVAILABILITY =
  /\b(?:we|i)\s+(?:have|have got|ve got|do have)\b[^.?!]{0,40}\b(?:opening|openings|availability|slots?|spaces?|times?)\b|\bwe\s+(?:are|re)\s+(?:free|available)\b/i;

describe("no template tells the customer what our calendar holds", () => {
  it("the week-aware ask names the week and claims nothing", () => {
    for (const week of ["this", "next"] as const) {
      const out = askAvailability(week);
      expect(out, out).not.toMatch(CLAIMS_AVAILABILITY);
      expect(out).toMatch(new RegExp(`${week} week`, "i"));
      expect(out).toMatch(/\?$/);
    }
  });

  it("and so does the Spanish one", () => {
    for (const week of ["this", "next"] as const) {
      const out = askAvailabilityEs(week);
      expect(out, out).not.toMatch(/\btenemos\b[^.?!]{0,40}\b(?:espacios|disponibilidad|citas)\b/i);
      expect(out).toMatch(/semana/i);
    }
  });

  /**
   * The sweep, over every template in the system rather than the one that was
   * wrong. A claim about our calendar is the same defect wherever it appears.
   */
  it("no template anywhere claims an opening", () => {
    const offenders: string[] = [];
    for (const table of [SAYS, SAYS_ES]) {
      for (const [intent, variants] of Object.entries(table)) {
        for (const v of (variants as string[] | undefined) ?? []) {
          if (CLAIMS_AVAILABILITY.test(v)) offenders.push(`${intent}: ${v}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

/**
 * EVERY TEMPLATE, AGAINST EVERY CLAIM THE BOT CANNOT BACK.
 *
 * The availability claim got in because it was nobody's idea of a bug: it was
 * Hatch's own sentence, copied for parity, and it named no day and no price so
 * neither existing sweep saw it. This one is written from the general shape —
 * a template must not assert anything the bot has no way to know.
 *
 * SILENT intents are skipped and that matters: SAYS.escalate still holds "Let
 * me get one of our team on this. Someone will follow up with you shortly.",
 * the handover line the Iteration 1 spec says must never be sent. It is
 * unreachable — renderMessage returns "" for escalate — and the test below
 * asserts that rather than trusting it.
 */
describe("no template asserts something the bot cannot know", () => {
  const RISKS: [string, RegExp][] = [
    ["claims our availability", /\b(?:we|i)\s+(?:have|ve got|do have)\b[^.?!]{0,40}\b(?:opening|openings|availability|slots?|spaces?)\b/i],
    ["promises a timeframe", /\b(?:today|tomorrow|within (?:the )?(?:hour|24|48)|this afternoon|right away|shortly|by (?:the )?end of (?:the )?day)\b/i],
    ["quotes a price", /\$|\b\d+\s*(?:dollars|usd)\b/i],
    ["names a weekday", /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i],
    ["guarantees", /\b(?:guarantee\w*|definitely)\b/i],
  ];

  it("holds for every sendable template in both languages", () => {
    const offenders: string[] = [];
    for (const [table, name] of [[SAYS, "SAYS"], [SAYS_ES, "SAYS_ES"]] as const) {
      for (const [intent, variants] of Object.entries(table)) {
        // A silent intent never reaches a customer; asserted separately below.
        if (isSilent({ intent: intent as never })) continue;
        for (const v of (variants as string[] | undefined) ?? []) {
          for (const [why, re] of RISKS) {
            if (re.test(v)) offenders.push(`${name}.${intent} ${why}: ${v}`);
          }
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  /**
   * The spec: "The bot sends nothing on the way out — no sign-off, no handover
   * line, nothing that reads as an ending." Its template still carries one, so
   * the guarantee is that it cannot render, not that the words are gone.
   */
  it("and the handover line escalate still holds can never render", () => {
    expect(SAYS.escalate.join(" ")).toMatch(/follow up with you shortly/i);
    expect(renderMessage({ intent: "escalate", turn: 1, customerText: "get me a person" })).toBe("");
    expect(isSilent({ intent: "escalate" })).toBe(true);
  });
});

/**
 * A TEMPLATE MAY NOT ASK STEP FOUR'S QUESTION AT STEP ONE.
 *
 * Second time the same shape has appeared: a rule enforced per-INTENT, walked
 * round by another intent's TEMPLATE. The first was the availability
 * stand-off. This is the ORDER.
 *
 * Seen in the simulator on a customer's very first message:
 *
 *   customer  "my budget is about $2000 for the kitchen and two bedrooms…
 *              does that work?"
 *   BOT       "The estimator will confirm that with you directly. In the
 *              meantime, what days generally work best on your end?"
 *
 * ask_availability asking that identical thing was refused the same turn —
 * "belongs to step 4 but only 1 of the required information has been
 * collected" — while defer_to_estimator carried it straight through.
 */
describe("the order rule survives templates that are not flow intents", () => {
  const defer = { intent: "defer_to_estimator" as const, turn: 1, customerText: "does that work?" };

  it("drops the trailing timing question before the availability step", () => {
    for (const flowStage of [0, 1, 2]) {
      const out = renderMessage({ ...defer, flowStage });
      expect(out, `stage ${flowStage}`).not.toMatch(/what days|what sort of days/i);
      expect(out.length, `stage ${flowStage}`).toBeGreaterThan(20);
    }
  });

  it("asks it once the flow has got there", () => {
    expect(renderMessage({ ...defer, flowStage: 3 })).toMatch(/what days/i);
  });

  it("leaves nurture alone, which has no collection flow", () => {
    expect(renderMessage({ ...defer, track: "nurture", flowStage: 0 }).length).toBeGreaterThan(20);
  });

  it("says nothing different when the caller does not track a stage", () => {
    expect(renderMessage({ ...defer })).toMatch(/what days/i);
  });
});
