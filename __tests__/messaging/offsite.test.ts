import { describe, it, expect } from "vitest";
import { jobRoute, roomCount } from "@/lib/messaging/offsite";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A6 and A7: 164 breaches between them, both critical, and both caused by one
 * template trying to be two sentences.
 *
 *   A6 OFFSITE REQUIRED — the JOB routes off-site. PRESENT the quick quote as
 *   the plan. A reason is FORBIDDEN ("A6 mandates none").
 *
 *   A7 OFFSITE OFFERED — the job routes ONSITE, the customer qualifies anyway.
 *   OFFER it as an option. A reason is MANDATED, and this is A32's only
 *   exception in the whole system.
 *
 * "A6 is REQUIRED and states the quick quote as the plan; A7 is OPTIONAL and
 * asks. Different sentences, different situations."
 */

describe("Kate's JOB ROUTING LOOKUP, as a table", () => {
  it.each([
    // exterior | windows, shutters, doors, small sheds | OFFSITE ok
    ["I need my windows painted", "offsite"],
    ["just the front door and shutters painted", "offsite"],
    ["a small shed in the back yard to paint", "offsite"],
    // exterior | HOME WALLS, any size | ONSITE always
    ["paint the exterior of my house", "onsite"],
    ["paint the siding on the whole home", "onsite"],
    ["looking to paint my whole house", "onsite"],
    // interior | FEWER THAN TWO full rooms | OFFSITE ok
    ["one bedroom to paint", "offsite"],
    ["we want a quote on painting a small bedroom", "offsite"],
    // interior | two or more full rooms | ONSITE
    ["paint living room and dining room", "onsite"],
    ["paint 3 bedrooms and a bathroom", "onsite"],
    ["need 2 bedrooms painted in our home", "onsite"],
  ])("%j routes %s", (scope, route) => {
    expect(jobRoute(scope, null)?.route).toBe(route);
  });

  it("a hallway is NOT a full room", () => {
    // Stated inside the lookup itself. A hallway-only job is under two full
    // rooms, so it routes off-site rather than being unroutable.
    expect(roomCount("just the hallway")).toBe(0);
    expect(jobRoute("just the hallway painted", null)?.route).toBe("offsite");
    expect(jobRoute("paint the hallway and the stairwell", null)?.route).toBe("offsite");
  });

  it("kitchen cabinets are ONSITE, except in the Queens area", () => {
    expect(jobRoute("kitchen cabinets refinished", null)?.route).toBe("onsite");
    expect(jobRoute("kitchen cabinets refinished", "NY Nassau")?.route).toBe("onsite");
    expect(jobRoute("kitchen cabinets refinished", "NY Queens")?.route).toBe("offsite");
  });

  it("home walls beat a small item named alongside them", () => {
    // The walls still need the visit whatever else is in the sentence.
    expect(jobRoute("paint the siding and the shutters", null)?.route).toBe("onsite");
  });
});

/**
 * UNKNOWN IS THE COMMON ANSWER, AND IT MUST STAY THAT WAY.
 *
 * Neither rule may fire on a guess: A6 forces a presentation and A7 needs the
 * job to route onsite, so inventing a route sends one of two opposite
 * sentences with total confidence. Kate says the same thing from the other
 * side: "NEVER route from the SIZE field on the record. 'Exterior: Small' is
 * not a trigger — ask what the job IS."
 */
describe("what it refuses to route", () => {
  it.each([
    "exterior paint",                 // which exterior row? unanswerable
    "painting",
    "Exterior: Small",                // the size field, explicitly banned
    "",
  ])("returns unknown for %j", (scope) => {
    expect(jobRoute(scope, null)).toBeNull();
  });

  /**
   * Real messages from Kate's corpus that an earlier version routed WRONGLY.
   * Bare "home" and "house" matched the exterior-walls row, so scheduling and
   * small talk came back as exterior wall jobs.
   */
  it.each([
    "Sure, I'm home all day, please let me know before coming",
    "I believe it was Michael who came to my house the last time thanks a lot",
    "Available Monday-Wednesday 7th-9th. And the next week.",
  ])("does not route %j, which is not a description of work", (text) => {
    expect(jobRoute(text, null)).toBeNull();
  });
});

const act = (intent: string, ctx: Record<string, unknown>) =>
  validateAction({ intent, confidence: 0.9 } as never, ctx as never);

describe("the job decides which rule applies, not the model", () => {
  it("refuses an OFFER when the job routes off-site", () => {
    // That would run the in-person booking flow A6 exists to replace, and
    // carry A7's mandatory reason into a turn where A32 forbids one.
    const v = act("offer_offsite_quote", { jobRoute: "offsite" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("wrong_offsite_rule");
      expect(v.detail).toContain("PRESENTED");
    }
  });

  it("refuses a PRESENTATION when the job routes on-site", () => {
    // That promises a quote PPP will not give without seeing the work.
    const v = act("present_offsite_quote", { jobRoute: "onsite" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("wrong_offsite_rule");
  });

  it("allows each one when the route agrees", () => {
    expect(act("present_offsite_quote", { jobRoute: "offsite" }).ok).toBe(true);
    expect(act("offer_offsite_quote", { jobRoute: "onsite" }).ok).toBe(true);
  });

  it("refuses neither when the route is unknown", () => {
    // Both rules are gated on knowing what the job is, and a caller that does
    // not track scope must behave as it always has.
    expect(act("present_offsite_quote", {}).ok).toBe(true);
    expect(act("offer_offsite_quote", {}).ok).toBe(true);
  });
});

describe("the two sentences are genuinely different", () => {
  const reason = "you're not able to be at the property";

  it("A6 presents it as the plan and asks text or email", () => {
    const out = renderMessage({ intent: "present_offsite_quote", turn: 0 });
    expect(out).toMatch(/quick quote/i);
    expect(out).toMatch(/text or email/i);
  });

  it("A6 carries NO reason — the rule forbids one", () => {
    for (let turn = 0; turn < 4; turn++) {
      const out = renderMessage({ intent: "present_offsite_quote", turn });
      expect(out).not.toMatch(/\bsince\b|\bbecause\b|\bso we can\b|\bnormally\b/i);
    }
  });

  it("A7 says the job would normally be seen in person, then gives the reason", () => {
    const out = renderMessage({ intent: "offer_offsite_quote", turn: 0, offsiteReason: reason });
    expect(out).toMatch(/in person/i);
    expect(out).toContain(reason);
  });

  it("A7 renders NOTHING without its reason", () => {
    // A7 without its justification is A6 said in the wrong situation. An
    // empty render escalates to a person, which is the right answer.
    expect(renderMessage({ intent: "offer_offsite_quote", turn: 0 })).toBe("");
  });

  it("the reason comes from the slot, not from anything the model wrote", () => {
    // The justification for departing from the normal route is system text.
    // Rapport is prepended as rapport and can never land inside the clause.
    const out = renderMessage({
      intent: "offer_offsite_quote", turn: 0, offsiteReason: reason, freeText: "Got it.",
    });
    expect(out).toContain(`but since ${reason},`);
    expect(out.indexOf("Got it.")).toBeLessThan(out.indexOf("but since"));
  });

  it("and a model that tries to write its own reason has it dropped first", () => {
    // A32's filter runs on rapport before the renderer ever sees it, so the
    // model cannot smuggle a justification in through the one free field.
    const v = validateAction(
      { intent: "offer_offsite_quote", confidence: 0.9, freeText: "Since your place is small, this is easier" } as never,
      { jobRoute: "onsite" } as never
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.action.freeText ?? "").toBe("");
  });
});
