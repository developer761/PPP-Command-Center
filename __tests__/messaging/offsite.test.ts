import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { jobRoute, roomCount, isCommercial, offsiteReasonFor } from "@/lib/messaging/offsite";
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
    // NOT ANY MORE, AND THE RULE IS WHAT CHANGED. Kate's 2026-09-25 A6 names
    // "the corridors, the stairwells" among the shared spaces that make a job
    // commercial, and commercial routes ONSITE above the lookup. A hallway on
    // its own is still nobody's shared space and still routes off-site.
    expect(jobRoute("paint the hallway and the stairwell", null)?.route).toBe("onsite");
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

/**
 * A6, REWRITTEN BY KATE ON 2026-09-25 TO MAKE PHONE PRICING LAND MORE OFTEN.
 *
 * The card gained a commercial gate above the lookup, two new component rows
 * (wallpaper and drywall), and an explicit rule for reading a job with more
 * than one component in it. Every expectation below is taken from her own
 * words, and the two worked examples are quoted verbatim from the card.
 */
describe("A6 as rewritten 2026-09-25", () => {
  const route = (t: string, area: string | null = null) => jobRoute(t, area)?.route ?? "ask";

  it("routes Kate's two worked examples the way the card does", () => {
    // "'Kitchen cabinets in Queens plus one accent wall' is OFF-SITE;
    //  'cabinets plus three rooms' is ONSITE."
    expect(route("paint the kitchen cabinets plus one accent wall", "Queens")).toBe("offsite");
    expect(route("paint the cabinets plus three rooms", "Queens")).toBe("onsite");
  });

  it("sends commercial onsite whatever the scope", () => {
    for (const t of [
      "we are a dentists office and need the interior painted",
      "paint our store front",
      "the restaurant needs one room painted",
      "paint the lobby of our building",
      "the common areas and corridors need painting",
      "repaint the stairwells",
    ]) expect(route(t), t).toBe("onsite");
  });

  /**
   * "THE TRIGGER IS THE SPACE, NEVER THE BUILDING. The words co-op, condo,
   * tenant and apartment DO NOT fire this gate and must never be treated as
   * commercial signals — they describe where someone lives."
   */
  it("does not treat somebody's home as commercial", () => {
    for (const t of [
      "paint my condo living room",
      "I am a tenant and want my bedroom painted",
      "paint my apartment bedroom",
      "paint my co-op kitchen",
      // And a home office is a room in a house, which is neither commercial
      // nor the exterior of one.
      "paint my home office",
    ]) expect(route(t), t).toBe("offsite");
  });

  it("reads the two new rows", () => {
    expect(route("hang wallpaper on one accent wall")).toBe("offsite");
    expect(route("wallpaper for all the walls in the den")).toBe("onsite");
    expect(route("patch a few holes in the drywall")).toBe("offsite");
    expect(route("replace the drywall board in the basement")).toBe("onsite");
  });

  /**
   * "PATCHES IS THE WHOLE DRYWALL TEST... 'scraping and repair of the ceiling
   * and walls due to water damage' is more than patches and routes ONSITE on
   * its own, before the interior row is even read."
   */
  it("routes more-than-patches onsite on its own", () => {
    expect(route("scraping and repair of the ceiling and walls due to water damage")).toBe("onsite");
  });

  /** "PARTIAL-ROOM WORK COUNTS AS FEWER THAN TWO FULL ROOMS." */
  it("counts partial-room work as fewer than two full rooms", () => {
    expect(route("just the ceiling only in the den")).toBe("offsite");
    expect(route("paint the trim only")).toBe("offsite");
  });

  /** "A ROOM WORD ON A CABINET JOB IS NOT A SECOND COMPONENT." */
  it("does not count the room word on a cabinet job", () => {
    expect(route("refinish the bathroom cabinets", "Queens")).toBe("offsite");
  });

  /**
   * "UNRESOLVED IS NOT ONSITE. Where the lookup is run and a fact is missing,
   * the answer is ASK for that fact — the lookup has not returned ONSITE, it
   * has not returned at all."
   */
  it("asks rather than defaulting to onsite when a fact is missing", () => {
    for (const t of ["paint the interior", "wallpaper in the den", "paint the exterior"]) {
      expect(route(t), t).toBe("ask");
    }
  });

  /** \bpaint has no word boundary inside "repaint" — the same bug as scope.ts. */
  it("reads a job the customer described as a repaint", () => {
    expect(route("repaint the whole house exterior")).toBe("onsite");
    expect(route("repaint one bedroom")).toBe("offsite");
  });
});

/**
 * A6 [6] IS A NEVER, AND IT NOW HAS A BRANCH.
 *
 * Found while answering Kate's question 2 from her own rule text rather than
 * asking her. NOT_COMMERCIAL was declared in offsite.ts and referenced NOWHERE
 * — a guard whose comment claimed it stopped a future edit from adding
 * residential words to the commercial list, enforcing nothing.
 *
 * A6 [6], verbatim: co-op, condo, tenant and apartment "DO NOT fire this gate
 * and must never be treated as commercial signals — they describe where someone
 * lives. Only a NAMED SHARED SPACE does."
 */
describe("the words that describe where somebody lives never route a job", () => {
  it("does not route a landlord's own building commercial on 'tenants'", () => {
    // Matched COMMERCIAL_OURS on "our building" and went commercial — on the
    // strength of two words A6 names as residential.
    expect(isCommercial("the tenants in our building are complaining")).toBe(false);
  });

  it("but an explicit commercial property word is still decisive", () => {
    expect(isCommercial("the tenants of our dental office")).toBe(true);
  });

  it("and a NAMED SHARED SPACE beats the veto, which is the multi-unit clause", () => {
    // A6 [5]: common areas of a residential building are commercial.
    expect(isCommercial("our building's lobby and corridors")).toBe(true);
    expect(isCommercial("the lobby of our condo building")).toBe(true);
  });

  it("leaves a condo owner's own room residential", () => {
    expect(isCommercial("my condo living room")).toBe(false);
    expect(isCommercial("repaint my apartment bedroom")).toBe(false);
  });

  /**
   * DELIBERATELY UNCHANGED, AND FLAGGED FOR KATE (question 2).
   *
   * "our building" with no residential word and no named space still routes
   * commercial. A3 [3] lists "our building" among the phrases that establish
   * commercial; A6 [6] says the trigger is the space and never the building.
   * They disagree, and the two errors are not symmetrical: reading it as
   * commercial costs an estimator visit, while reading it as residential can
   * send a commercial job down a path A6 says must never price it.
   */
  it("still treats a bare 'our building' as commercial, on the safe side", () => {
    expect(isCommercial("we need our building painted")).toBe(true);
  });
});

/**
 * ONE MISSING WORD TOOK OUT THREE RULES.
 *
 * Played in the simulator on 2026-09-27, a returning customer:
 *
 *   customer  "we used you guys a couple years back for the upstairs, now I
 *              need the hallway and two bedrooms redone"
 *   BOT       "Good to hear from you again! We can provide a quick quote for
 *              this project. Do you prefer text or email?"
 *
 * A remote quote on a TWO-ROOM interior job, which A6 says must be seen in
 * person, and whose converse forbids offering one at all.
 *
 * The cause was vocabulary. "redone" matched no work word, so:
 *   · no scope was captured   → the stage never advanced and A13 had nothing
 *                               to protect
 *   · jobRoute returned null  → A6 could not route the job
 *   · so the converse could not refuse the offer
 *
 * (?:re)?do\b cannot reach "redone": after "do" comes an "n", so there is no
 * word boundary. "redo" matched and "redone" did not.
 */
describe("a job described without a painting verb still routes", () => {
  it("routes two rooms on-site however the customer phrases it", () => {
    for (const t of [
      "the hallway and two bedrooms redone",
      "two bedrooms redone",
      "I need the hallway and two bedrooms done",
      "three rooms redone",
      "my kitchen and living room redone",
      "paint two bedrooms",
    ]) {
      expect(jobRoute(t)?.route, t).toBe("onsite");
    }
  });

  it("routes the nouns that only ever describe work", () => {
    // Exterior walls are onsite always; cabinets are onsite outside Queens.
    expect(jobRoute("the whole house exterior")?.route).toBe("onsite");
    expect(jobRoute("kitchen cabinets")?.route).toBe("onsite");
  });

  it("and a single room is still off-site eligible", () => {
    expect(jobRoute("paint my bedroom")?.route).toBe("offsite");
    expect(jobRoute("just the ceiling")?.route).toBe("offsite");
  });

  /**
   * THE GATE STILL REFUSES WHAT IT EXISTS TO REFUSE. Routing a scheduling
   * message is "answering a question nobody asked", and these are the exact
   * strings the corpus produced.
   */
  it("never routes scheduling or pleasantries", () => {
    for (const t of [
      "I'm home all day, please let me know before coming",
      "Available Monday",
      "it was Michael who came to my house the last time",
      "sounds good thanks",
      "Tuesday works",
      "ok",
      "call me at 3",
    ]) {
      expect(jobRoute(t), t).toBeNull();
    }
  });
});

/**
 * THE SPANISH A7 QUALIFIER WAS WIDER THAN KATE'S RULE.
 *
 * A7's third qualifier is that the customer ASKS to be quoted from photos
 * they supplied. The English pattern says so throughout — "quote it from",
 * "can you just quote", "go off the pictures". Its Spanish sibling matched a
 * bare mention of photos, so a lead who merely attached some, or apologised
 * for them, qualified for a remote quote on a job that should be seen —
 * citing a reason they never gave.
 *
 * Sending photos is what nearly every lead does. Asking us to price off them
 * is the qualifier.
 */
describe("the Spanish photo qualifier needs the ask, not the photos", () => {
  it.each([
    "Le mande fotos de la cocina",
    "Perdon por las fotos borrosas",
    "Aqui estan las fotos del bano",
    "Ya le envie unas imagenes del exterior",
  ])("does not qualify a bare mention: %j", (text) => {
    expect(offsiteReasonFor(text, "es")).toBeNull();
  });

  it.each([
    "Me puede cotizar con las fotos que le mande?",
    "Puede darme un presupuesto de las fotos?",
    "Quiero un precio con las fotos que ya tiene",
    "Puede estimar el costo con las medidas que le di?",
  ])("qualifies a genuine ask: %j", (text) => {
    expect(offsiteReasonFor(text, "es")).toBe("tenemos fotos con las que podemos trabajar");
  });

  /** The English half is untouched, and was always the stricter of the two. */
  it("still qualifies the English ask", () => {
    expect(offsiteReasonFor("can you quote it from the pictures I sent?", "en"))
      .toBe("you've got photos we can work from");
  });
});

/**
 * AND THE TWO HALVES OF A QUALIFIER CANNOT DRIFT APART.
 *
 * They were two arrays, index-paired, read as A7_TRIGGERS_ES[i].test(t) with
 * nothing asserting the lengths matched. Both were seven. An eighth English
 * qualifier — a thing Kate can ask for at any time — would make the Spanish
 * entry undefined and throw on .test, inside an agent turn.
 */
describe("every A7 qualifier has both languages on one object", () => {
  it("has no second index-paired list left to drift", () => {
    const src = readFileSync("lib/messaging/offsite.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/A7_TRIGGERS_ES\s*\[/);
    expect(src).not.toMatch(/const\s+A7_TRIGGERS_ES\b/);
  });

  it("never throws on any input, whatever the qualifier count", () => {
    for (const t of ["", "hello", "no puedo estar", "x".repeat(400), "¿?", "fotos"]) {
      expect(() => offsiteReasonFor(t, "es")).not.toThrow();
      expect(() => offsiteReasonFor(t, "en")).not.toThrow();
    }
  });
});
