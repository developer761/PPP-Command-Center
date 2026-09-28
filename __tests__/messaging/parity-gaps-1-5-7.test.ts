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
  weekToOffer, askAvailability, asksOurAvailability, isAvailabilityStandOff,
} from "@/lib/messaging/availability-ask";
import {
  returningCustomerDeclining, alreadyAskedToConfirm, returningCustomerReply,
  returningCustomerDecliningInThread,
} from "@/lib/messaging/returning-customer";
import { renderMessage } from "@/lib/messaging/render";
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
