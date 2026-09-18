import { describe, it, expect } from "vitest";
import { resolveSurfaceColor } from "@/lib/materials/room-color-source";
import type { RetainedPick } from "@/lib/customer-form/retained-picks";

/**
 * Which source names the color for a surface in Rooms & Colors (R4.9 / R4.10),
 * and the decision Karan settled on 2026-09-18: **the customer wins**.
 *
 * It used to be Salesforce, for the four standard surfaces, so a rep's later
 * correction was not masked. But the order and the vendor email have always
 * read the customer's payload first — so the screen showed the rep's
 * correction, the store was sent the customer's original, and nothing said the
 * two disagreed.
 *
 * This file used to read `components/materials-view.tsx` as TEXT and assert
 * that it contained `if (STANDARD_SURFACES.includes(surface)) return true;`.
 * It could only ever pin the shape of the code, never its answer: when the
 * rule was reversed it went red for the wrong reason, and it would have stayed
 * green through any rewrite that kept the same words. The rule now lives in a
 * function, and this asks it questions.
 */

const pick = (over: Partial<RetainedPick> = {}): RetainedPick => ({
  surface: "Walls",
  colorId: "a02CUSTOMER",
  colorName: "Chantilly Lace",
  colorCode: "OC-65",
  finish: "Eggshell",
  skipped: false,
  ...over,
});

describe("the customer's pick wins", () => {
  it("even on a standard surface Salesforce could hold perfectly well", () => {
    const a = resolveSurfaceColor({ retained: pick(), salesforceColorId: "a02REP", salesforceFinish: "Flat" });
    expect(a.source).toBe("customer");
    expect(a.colorId).toBe("a02CUSTOMER");
    expect(a.finish).toBe("Eggshell");
  });

  it("and the vendor email agrees, because both read the payload first", () => {
    // The whole point of the change: one rule in both places. The builder's
    // own resolution is `customerPick?.colorId ?? slot.existingColorId`, and
    // this must not diverge from it again.
    const a = resolveSurfaceColor({ retained: pick(), salesforceColorId: "a02REP" });
    const whatTheVendorGets = pick().colorId ?? "a02REP";
    expect(a.colorId).toBe(whatTheVendorGets);
  });

  it("but Salesforce's different answer is carried, not discarded", () => {
    // A rep's correction is a real signal. It stops winning; it must not stop
    // being visible, or a correction simply vanishes.
    const a = resolveSurfaceColor({ retained: pick(), salesforceColorId: "a02REP" });
    expect(a.salesforceColorId).toBe("a02REP");
  });

  it("and says nothing when the two agree", () => {
    const a = resolveSurfaceColor({ retained: pick({ colorId: "a02SAME" }), salesforceColorId: "a02SAME" });
    expect(a.salesforceColorId).toBeNull();
  });
});

describe("a skip is an answer", () => {
  it("wins over any Salesforce color, on any surface", () => {
    // Salesforce cannot record "don't paint this", so a blank field there is
    // indistinguishable from "nobody picked yet". Reading it back is what put
    // Super White on the Kitchen cabinets the customer opted OUT of
    // (WO 00308360).
    const a = resolveSurfaceColor({
      retained: pick({ surface: "Cabinets", skipped: true, colorId: null, colorName: null }),
      salesforceColorId: "a02SHARED",
    });
    expect(a.source).toBe("skipped");
    expect(a.colorId).toBeNull();
    expect(a.salesforceColorId).toBeNull();
  });

  it("is checked before the color, so a skip with a stale colorId still skips", () => {
    const a = resolveSurfaceColor({ retained: pick({ skipped: true }), salesforceColorId: "a02REP" });
    expect(a.source).toBe("skipped");
  });
});

describe("when the customer never answered this surface", () => {
  it("Color Notes is the next resort — submissions predating retention", () => {
    const a = resolveSurfaceColor({
      fromNotes: { colorName: "Henderson Buff", colorCode: "HC-15", finish: "Satin" },
      salesforceColorId: "a02SHARED",
    });
    expect(a.source).toBe("notes");
    expect(a.colorName).toBe("Henderson Buff");
    // The shared ColorOther__c may belong to a different orphan surface, so it
    // is reported rather than used — this is WO 00306643's Bathroom.
    expect(a.salesforceColorId).toBe("a02SHARED");
  });

  it("and Salesforce still renders a line nobody used the form on", () => {
    // The common case on older work orders: a rep typed the colors straight
    // into Salesforce. Preferring the payload everywhere must not blank these.
    const a = resolveSurfaceColor({ salesforceColorId: "a02REP", salesforceFinish: "Semi-Gloss" });
    expect(a.source).toBe("salesforce");
    expect(a.colorId).toBe("a02REP");
    expect(a.finish).toBe("Semi-Gloss");
    expect(a.salesforceColorId).toBeNull();
  });

  it("and an empty surface stays empty rather than inventing a color", () => {
    const a = resolveSurfaceColor({});
    expect(a.source).toBe("none");
    expect(a.colorId).toBeNull();
    expect(a.colorName).toBeNull();
  });

  it("a retained row with no color and no skip is not an answer either", () => {
    // The customer opened the form and left this surface alone.
    const a = resolveSurfaceColor({
      retained: pick({ colorId: null, colorName: null }),
      salesforceColorId: "a02REP",
    });
    expect(a.source).toBe("salesforce");
    expect(a.colorId).toBe("a02REP");
  });
});
