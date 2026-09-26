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
