import { describe, it, expect } from "vitest";
import { retainedPicksByLine, pickIsAnswered } from "@/lib/customer-form/retained-picks";

/**
 * R4.9 / R4.10. Salesforce has four colour fields per line item plus ONE shared
 * ColorOther__c, so a room with two "orphan" surfaces is lossy the moment it's
 * written — and reading it back produced two different wrong answers, both of
 * which Kate hit on real work orders:
 *
 *   WO 00306643 · Bathroom (Walls;Ceiling;Cabinets;Door) — two orphans, so
 *     ColorOther__c is deliberately blank and both colours go to Color Notes.
 *     Every orphan chip read that blank field and rendered "—".
 *   WO 00308360 · Kitchen (Walls;Cabinets;Door) — Cabinets SKIPPED, Door
 *     picked. ColorOther__c holds the Door's colour, and every orphan chip read
 *     it, painting Super White onto a surface the customer opted out of.
 *
 * The payloads below are the real ones, copied from production.
 */

const BATHROOM = {
  lineItems: [{
    id: "1WLWj00000234qjOAA",
    surfaces: [
      { finish: "Semi-Gloss", colorId: "a026g00000XQ5STAA1", skipped: false, surface: "Walls", colorCode: "2108-50", colorName: "2108-50 Silver Fox" },
      { finish: "Eggshell", colorId: "a026g00000XQ5Z4AAL", skipped: false, surface: "Ceiling", colorCode: "HC-14", colorName: "HC-14 Princeton Gold" },
      { finish: "Semi-Gloss", colorId: "a026g00000XQ5Z5AAL", skipped: false, surface: "Cabinets", colorCode: "HC-15", colorName: "HC-15 Henderson Buff" },
      { finish: "Semi-Gloss", colorId: "a026g00000XQ5SSAA1", skipped: false, surface: "Door", colorCode: "2108-40", colorName: "2108-40 Stardust" },
    ],
  }],
};

const KITCHEN = {
  lineItems: [{
    id: "1WLWj0000024o0IOAQ",
    surfaces: [
      { finish: "Eggshell", colorId: "a026g00000XQ5Z4AAL", skipped: false, surface: "Walls", colorCode: "HC-14", colorName: "HC-14 Princeton Gold" },
      { finish: null, colorId: null, skipped: true, surface: "Cabinets", colorCode: null, colorName: null },
      { finish: "Semi-Gloss", colorId: "a026g00000XQ79xAAD", skipped: false, surface: "Door", colorCode: "Super White", colorName: "Super White" },
    ],
  }],
};

describe("retainedPicksByLine", () => {
  it("keeps both orphan colours that Salesforce couldn't hold (Symptom A)", () => {
    const picks = retainedPicksByLine(BATHROOM).get("1WLWj00000234qjOAA")!;
    const bySurface = new Map(picks.map((p) => [p.surface, p]));
    expect(bySurface.get("Cabinets")?.colorName).toBe("HC-15 Henderson Buff");
    expect(bySurface.get("Door")?.colorName).toBe("2108-40 Stardust");
    // Different colours — the whole point. ColorOther__c can hold only one.
    expect(bySurface.get("Cabinets")?.colorId).not.toBe(bySurface.get("Door")?.colorId);
  });

  it("distinguishes a skipped surface from a picked one (Symptom B)", () => {
    const picks = retainedPicksByLine(KITCHEN).get("1WLWj0000024o0IOAQ")!;
    const bySurface = new Map(picks.map((p) => [p.surface, p]));
    expect(bySurface.get("Cabinets")?.skipped).toBe(true);
    expect(bySurface.get("Cabinets")?.colorId).toBeNull();
    expect(bySurface.get("Door")?.colorName).toBe("Super White");
    // A skip IS an answer — it must suppress the shared-slot fallback, or
    // Super White lands on Cabinets again.
    expect(pickIsAnswered(bySurface.get("Cabinets")!)).toBe(true);
  });

  it("treats an untouched surface as unanswered so Salesforce can still fill it", () => {
    // A rep who types a colour into Salesforce after a partial submission must
    // not have it hidden by an empty pick.
    expect(pickIsAnswered({ surface: "Trim", colorId: null, colorName: null, colorCode: null, finish: null, skipped: false })).toBe(false);
  });

  it("survives payloads written by older builds", () => {
    // This JSON is years of accumulated writes read by every future build. A
    // malformed entry must be dropped, never throw — the alternative is a work
    // order page that 500s because one historical submission had a null.
    expect(retainedPicksByLine(null).size).toBe(0);
    expect(retainedPicksByLine("nonsense").size).toBe(0);
    expect(retainedPicksByLine({ lineItems: "not an array" }).size).toBe(0);
    expect(retainedPicksByLine({ lineItems: [{ id: 42, surfaces: [] }] }).size).toBe(0);
    const partial = retainedPicksByLine({
      lineItems: [{ id: "x", surfaces: [{ surface: "Walls" }, { surface: "" }, null, { colorId: "c" }] }],
    });
    // Only the one entry with a usable surface label survives.
    expect(partial.get("x")).toHaveLength(1);
    expect(partial.get("x")![0]).toMatchObject({ surface: "Walls", colorId: null, skipped: false });
  });
});
