import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage, isSilent } from "@/lib/messaging/render";
import { saidWrongNumber } from "@/lib/messaging/customer-asks";

/**
 * A WRONG NUMBER IS THE WRONG PERSON, AND KATE'S LIST SAYS WHERE THAT ENDS.
 *
 * END_STATES: Bailout — "Wrong person, chose another company, something
 * negative, or vulgar language." Found by the corpus audit 2026-10-16:
 * "Wrong number" went to the agent like any other text and could come back
 * `acknowledge`, rendering "Perfect, thanks." — to a stranger — with the
 * follow-up cadence still running behind it.
 */
const ctx = (customerText: string) => ({
  customerText,
  knownFields: { inquiryScope: true },
  addressGap: null,
  templateAsks: () => false,
  customerMessages: [],
}) as never;

describe("recognising a wrong number", () => {
  it.each([
    "Wrong number",
    "wrong number sorry",
    "Wrong #",
    "You have the wrong number",
    "I think you have the wrong number.",
    "you've got the wrong person",
    "wrong person, I'm not Tom",
    "Número equivocado",
    "numero equivocado",
    "se equivocó de número",
    "no one here by that name",
  ])("reads %j as a wrong number", (t) => {
    expect(saidWrongNumber(t)).toBe(true);
  });

  /** A customer CORRECTING their number is a live lead, not a stranger. */
  it.each([
    "the number on the door is wrong",
    "I gave you the wrong number, it's 516-555-0134",
    "sorry I put the wrong number on the form, use 5165550134",
    "the estimate has the wrong number of rooms",
    "please don't stop the work halfway",
    "can you remove the old wallpaper",
  ])("does not read %j as a wrong number", (t) => {
    expect(saidWrongNumber(t)).toBe(false);
  });
});

describe("a wrong number ends as bailout", () => {
  it.each(["acknowledge", "ask_project_details", "discard", "lost"])(
    "refuses %s on \"Wrong number\"",
    (intent) => {
      const v = validateAction({ intent, confidence: 0.95, freeText: "" }, ctx("Wrong number"));
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.reason).toBe("wrong_number_not_bailout");
    },
  );

  it("accepts bailout", () => {
    expect(validateAction({ intent: "bailout", confidence: 0.95, freeText: "" }, ctx("Wrong number")).ok)
      .toBe(true);
  });

  /** Nobody wants a cheerful sign-off to a stranger — the reason discard was silent. */
  it("says nothing to the stranger", () => {
    for (const language of ["en", "es"] as const) {
      const input = { intent: "bailout" as const, customerText: "wrong number", language };
      expect(isSilent(input)).toBe(true);
      expect(renderMessage(input)).toBe("");
    }
  });

  it("still signs off to a customer who declined", () => {
    const input = { intent: "bailout" as const, customerText: "no thanks, we went with someone else" };
    expect(isSilent(input)).toBe(false);
    expect(renderMessage(input).length).toBeGreaterThan(0);
  });
});
