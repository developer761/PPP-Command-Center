import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";
import { territoryFor, SERVICED_STATES } from "@/lib/messaging/territory";
import { renderMessage, SAYS } from "@/lib/messaging/render";
import { shouldEscalate } from "@/lib/messaging/agent-output";

/**
 * A2, 37 breaches, critical: "Validate the zip against the service area
 * BEFORE promising coverage."
 *
 * "Serviceability is a LOOKUP, not a judgement, and it runs in this ORDER:
 * (1) the state must be one of NJ, CA, CT, FL, NY, CO; (2) the zip must
 * resolve to a Zip_Code__c row; (3) that row's Service_Territory__r.IsActive
 * must be TRUE and the territory must not be named 'Out of Area'."
 */

const row = (over: Partial<Parameters<typeof territoryFor>[0] & object> = {}) => ({
  zip: "11530", state: "NY", city: "Garden City", county: "Nassau",
  territoryName: "NY Nassau North", territoryActive: true, ...over,
});

describe("the lookup, in the order the rule states it", () => {
  it("covers exactly the six states", () => {
    expect([...SERVICED_STATES].sort()).toEqual(["CA", "CO", "CT", "FL", "NJ", "NY"]);
  });

  it("refuses a state outside the six whatever the record says", () => {
    // "a zip outside those states is NOT serviced no matter what its record
    // says" — including a record claiming an active territory.
    const v = territoryFor(row({ state: "TX", territoryName: "NY Nassau North", territoryActive: true }));
    expect(v.serviced).toBe(false);
    if (!v.serviced) expect(v.why).toContain("TX");
  });

  it("refuses a zip that resolves to nothing", () => {
    expect(territoryFor(null).serviced).toBe(false);
  });

  it("refuses an inactive territory", () => {
    expect(territoryFor(row({ territoryActive: false })).serviced).toBe(false);
  });

  it("refuses one named Out of Area", () => {
    expect(territoryFor(row({ territoryName: "Out of Area" })).serviced).toBe(false);
  });

  it("services an active territory in a covered state", () => {
    expect(territoryFor(row()).serviced).toBe(true);
  });
});

/**
 * "🔴 Marketing_Active__c IS NOT A SERVICEABILITY TEST. A zip whose TERRITORY
 * is active is bookable whether Marketing_Active__c is TRUE or FALSE.
 * Marketing-inactive means we do not MARKET there, not that we do not SERVE
 * there."
 */
describe("marketing is not serviceability", () => {
  it("has no field for it at all", () => {
    // Structural rather than remembered: there is nothing to read, so nothing
    // can accidentally start reading it.
    expect(Object.keys(row())).not.toContain("marketingActive");
    // The function NAMES it in a comment saying not to use it, which is the
    // point. What must not exist is a READ of it, so the comments come out
    // before looking.
    const code = String(territoryFor)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ");
    expect(code).not.toMatch(/marketing/i);
  });
});

/**
 * The two responses, which are different situations needing opposite
 * handling. The single blanket sentence they replace did neither.
 */
describe("what the customer is told", () => {
  it("an unknown or inactive zip buys a moment and hands off", () => {
    const out = renderMessage({ intent: "checking_availability", turn: 0 });
    expect(out).toMatch(/checking availability/i);
    // "then hand off — a human must check with the estimator before any
    // coverage is promised."
    expect(shouldEscalate({ intent: "checking_availability", confidence: 1 } as never)).toBe(true);
  });

  it("an out-of-state project names the zip and the state, and ASKS", () => {
    const out = renderMessage({
      intent: "area_not_serviced", turn: 0,
      known: { zip: "19977", state: "Delaware" },
    });
    expect(out).toContain("19977");
    expect(out).toContain("Delaware");
    // The zip on file is often stale — one of Kate's findings is a customer
    // giving a New Jersey address while FL 33308 sat on the record. Closing
    // on the record's word loses a lead we do cover.
    expect(out.trim().endsWith("?")).toBe(true);
  });

  it("renders nothing rather than naming the wrong state", () => {
    expect(renderMessage({ intent: "area_not_serviced", turn: 0 })).toBe("");
    expect(renderMessage({ intent: "area_not_serviced", turn: 0, known: { zip: "19977" } })).toBe("");
  });
});

/**
 * "🔴 NEVER NAME THE SERVICE-AREA CHECK TO THE CUSTOMER (Kate, 2026-09-10).
 * Saying anything like 'let me check that zip against our service area'
 * signals we are not local, which costs us the lead even when the answer is
 * yes. The validation is ours to run silently."
 *
 * The easiest rule in the set to breach by accident, because the honest
 * phrasing is the forbidden one.
 */
describe("the check is never named to the customer", () => {
  const NAMES_THE_CHECK =
    /service area|coverage area|areas? we (?:cover|service)|whether we (?:cover|service)|check (?:your |the )?zip|in our area|if we service|serviceab/i;

  const all = Object.entries(SAYS).flatMap(([intent, variants]) =>
    variants.map((text, i) => ({ intent, i, text })));

  it("has templates to check", () => {
    expect(all.length).toBeGreaterThan(30);
  });

  it.each(all.filter((t) => t.text.trim()))("$intent [$i] does not name it", ({ text }) => {
    expect({ text, names: NAMES_THE_CHECK.test(text) }).toEqual({ text, names: false });
  });

  it("the detector works, so the sweep above means something", () => {
    expect(NAMES_THE_CHECK.test("Let me check that zip against our service area.")).toBe(true);
    expect(NAMES_THE_CHECK.test("Unfortunately that's outside the area we cover.")).toBe(true);
    expect(NAMES_THE_CHECK.test("Just a moment, I'm checking availability.")).toBe(false);
  });
});

/**
 * A2 IN THE REJECTING DIRECTION, WHICH NOTHING GUARDED.
 *
 * The validator already stopped anything PROMISING coverage before the zip
 * said we had it. Nothing stopped the opposite — telling a customer we do NOT
 * cover them while our own table said we do.
 *
 * Found in the simulator on 2026-09-27: a customer wrote "I need my whole
 * house exterior painted, I am at 4821 Oak Lane, Dallas TX 75201" and the
 * model chose area_not_serviced, a TERMINAL outcome, at 82% from the text
 * alone. It was allowed at every value of serviceArea, "serviced" included.
 *
 * Production is more exposed than the sandbox was: the sandbox held no zip so
 * the template rendered empty, but a real conversation holds one. A customer
 * on a serviced Long Island zip who mentions a property in Texas could be
 * told "The zip I have on file is 11530, and unfortunately we do not currently
 * serve your area" — rejected for good, using the zip that proves otherwise.
 */
describe("the bot may not end on geography unless the LOOKUP says so", () => {
  const act = { intent: "area_not_serviced", confidence: 0.97, freeText: "" };
  const ctx = (serviceArea?: string | null) => ({
    track: "new_lead" as const, stage: 1, priorIntents: ["ask_project_details"],
    knownFields: { inquiryScope: true },
    customerText: "I am at 4821 Oak Lane, Dallas TX 75201",
    serviceArea: serviceArea as never,
  });

  it("REFUSES it when the zip on file is inside the service area", () => {
    const v = validateAction(act, ctx("serviced"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toMatch(/INSIDE the service area/);
  });

  /**
   * A2, verbatim: an unreadable map "answers needs_a_person, never 'not
   * serviced', because telling a customer we do not cover them on a failed
   * lookup is the harm A2 exists to prevent."
   */
  it("REFUSES it when our own lookup could not answer", () => {
    const v = validateAction(act, ctx("needs_a_person"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toMatch(/never 'not serviced'|unreadable/);
  });

  it("ALLOWS it when the lookup says out of state — the one case it is for", () => {
    expect(validateAction(act, ctx("out_of_state")).ok).toBe(true);
  });

  it("stays allowed for a caller that does not track the lookup at all", () => {
    // Undefined means "we do not know", not "we do cover them". The template
    // only speaks when a zip and state are held, and agent-run escalates on an
    // intent that renders nothing — which is A2's needs_a_person answer.
    expect(validateAction(act, ctx(undefined)).ok).toBe(true);
    expect(validateAction(act, ctx(null)).ok).toBe(true);
  });

  it("does not disturb the promising direction it was already guarding", () => {
    for (const intent of ["ask_availability", "success", "present_offsite_quote"]) {
      expect(validateAction({ ...act, intent }, ctx("out_of_state")).ok).toBe(false);
    }
  });
});
