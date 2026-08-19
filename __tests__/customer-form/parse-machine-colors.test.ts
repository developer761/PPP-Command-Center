import { describe, it, expect } from "vitest";
import { parseMachineColorLines } from "@/lib/customer-form/notes";

/**
 * When a room has 2+ surfaces with no dedicated Salesforce colour field
 * (Cabinets AND Closet), the submit route puts their colours in
 * ColorNotes__c and leaves the single shared ColorOther__c blank — one field
 * can't hold two colours. Every screen that showed those surfaces read only
 * that blank field, so the room displayed as having no colours picked and the
 * team chased the customer for what they'd already sent.
 *
 * These assert the parser against the exact strings the writer produces.
 */
describe("parseMachineColorLines", () => {
  it("reads back what the submit route writes", () => {
    const notes = "Dining Room:\nCabinets: White Dove (OC-17) — Satin\nCloset: Simply White (OC-117) — Semi-Gloss\n\nCustomer notes:\nplease be careful with the piano";
    expect(parseMachineColorLines(notes)).toEqual([
      { surface: "Cabinets", colorName: "White Dove", colorCode: "OC-17", finish: "Satin" },
      { surface: "Closet", colorName: "Simply White", colorCode: "OC-117", finish: "Semi-Gloss" },
    ]);
  });

  it("handles a colour with no code", () => {
    expect(parseMachineColorLines("Cabinets: Custom Match — Eggshell")).toEqual([
      { surface: "Cabinets", colorName: "Custom Match", colorCode: null, finish: "Eggshell" },
    ]);
  });

  it("keeps a parenthetical that isn't a colour code attached to the name", () => {
    // The code pattern caps at 15 chars precisely so descriptive parentheticals
    // aren't mistaken for codes and silently stripped off the colour name.
    const [p] = parseMachineColorLines("Cabinets: White (matched to existing trim) — Satin");
    expect(p.colorName).toBe("White (matched to existing trim)");
    expect(p.colorCode).toBeNull();
  });

  it("splits the finish from the right so an em dash in a name survives", () => {
    const [p] = parseMachineColorLines("Door: Black — Iron (2132-10) — Semi-Gloss");
    expect(p.colorName).toBe("Black — Iron");
    expect(p.colorCode).toBe("2132-10");
    expect(p.finish).toBe("Semi-Gloss");
  });

  it("ignores the crew's own typed notes", () => {
    // A rep typing "Cabinets: needs sanding before paint" matches the surface
    // prefix exactly. Treating it as a colour would put "needs sanding before
    // paint" on screen as the colour name — and into a vendor's order.
    expect(parseMachineColorLines("Cabinets: needs sanding before paint")).toEqual([]);
  });

  it("ignores the 'don't paint' lines", () => {
    expect(parseMachineColorLines('Customer selected "Don\'t paint this surface" on Cabinets.')).toEqual([]);
  });

  it("returns nothing for empty or absent notes", () => {
    expect(parseMachineColorLines(null)).toEqual([]);
    expect(parseMachineColorLines("")).toEqual([]);
    expect(parseMachineColorLines("   ")).toEqual([]);
  });
});
