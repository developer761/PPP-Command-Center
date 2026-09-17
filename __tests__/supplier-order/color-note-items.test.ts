import { describe, it, expect } from "vitest";
import {
  colorNoteLines,
  customItemLabel,
  inBuyList,
  isOnOrder,
  itemKey,
  nextCustomColorId,
  orderableQty,
} from "@/lib/supplier-order/color-note-items";

/** Verbatim from WO 00316248 — the colors exist nowhere else on the job. */
const KATIE = [
  "Customer notes: Siding: HC-6 Windham Cream - Low Lustre",
  "Trim: OC-95 Navajo White - Soft Gloss",
  "Shutters, Doors, and Iron Railings: 447 Holiday Wreath - Satin",
].join("\n");

describe("each color in Color Notes is offered on its own", () => {
  it("WO 00316248: three colors, three lines, wrapper label gone", () => {
    expect(colorNoteLines(KATIE)).toEqual([
      "Siding: HC-6 Windham Cream - Low Lustre",
      "Trim: OC-95 Navajo White - Soft Gloss",
      "Shutters, Doors, and Iron Railings: 447 Holiday Wreath - Satin",
    ]);
  });

  it("…and the same colors written as ONE sentence-joined line", () => {
    // How Katie actually quoted WO 00316248. Split on a period only where a new
    // "Surface: color" starts, so one click still buys one color.
    const oneLine =
      "Customer notes: Siding: HC-6 Windham Cream, Low Lustre. Trim: OC-95 Navajo White, Soft Gloss. Shutters: 447 Holiday Wreath, Satin.";
    expect(colorNoteLines(oneLine)).toEqual([
      "Siding: HC-6 Windham Cream, Low Lustre",
      "Trim: OC-95 Navajo White, Soft Gloss",
      "Shutters: 447 Holiday Wreath, Satin",
    ]);
  });

  it("a sentence that merely contains a period is left whole", () => {
    const prose = "Customer notes: Use approx. 2 gal on the porch ceiling. It was painted last year.";
    expect(colorNoteLines(prose)).toEqual([
      // Untouched, full stop and all — nothing here names a surface to buy for.
      "Use approx. 2 gal on the porch ceiling. It was painted last year.",
    ]);
  });

  it("orphan-surface colors the form wrote are offered too — they reach the vendor no other way", () => {
    const raw = "Kitchen:\nCabinets: White Dove (OC-17) — Satin\nDoor: Super White (OC-152)\nCustomer notes: match the hall";
    expect(colorNoteLines(raw)).toEqual([
      "Cabinets: White Dove (OC-17) — Satin",
      "Door: Super White (OC-152)",
      "match the hall",
    ]);
  });

  it("never offers the unstorable-finish trailer the submit route writes", () => {
    // Real shape from app/api/customer-form/submit/[token]/route.ts. "High-Gloss"
    // is a finish, not something a vendor sells — and the header is bookkeeping.
    const raw = [
      "Kitchen:",
      "Cabinets: White Dove (OC-17) — Satin",
      "",
      "Finish not available in the Salesforce list — recorded here:",
      "  High-Gloss",
      "  Matte",
    ].join("\n");
    expect(colorNoteLines(raw)).toEqual(["Cabinets: White Dove (OC-17) — Satin"]);
  });

  it("a customer's own words after that trailer survive", () => {
    const raw = [
      "Finish not available in the Salesforce list — recorded here:",
      "  High-Gloss",
      "Customer notes: Front door: 447 Holiday Wreath",
    ].join("\n");
    expect(colorNoteLines(raw)).toEqual(["Front door: 447 Holiday Wreath"]);
  });

  it("never offers the truncation marker", () => {
    expect(colorNoteLines("Customer notes: Walls: SW 7005\n[…truncated — customer notes exceeded 30000 chars]"))
      .toEqual(["Walls: SW 7005"]);
  });

  it("drops bullets, headings of any length, separators and CRLF", () => {
    const raw = [
      "Exterior of the main house including the detached garage and the shed:",
      "Exterior (2nd floor: rear):",
      "- Siding: HC-6",
      "--",
      "...",
      "*",
      "• Trim: OC-95",
      "2) Door: 447",
    ].join("\r\n");
    expect(colorNoteLines(raw)).toEqual(["Siding: HC-6", "Trim: OC-95", "Door: 447"]);
  });

  it("nothing to offer when there are no notes", () => {
    expect(colorNoteLines(null)).toEqual([]);
    expect(colorNoteLines("  \n ")).toEqual([]);
  });

  it("the same color written twice is offered once", () => {
    expect(colorNoteLines("Trim: OC-95\ntrim:  OC-95")).toEqual(["Trim: OC-95"]);
  });
});

describe("the order knows what has already been added", () => {
  it("matches regardless of case and spacing", () => {
    const items = [{ label: "Trim:  oc-95 navajo white" }];
    expect(isOnOrder(items, "Trim: OC-95 Navajo White")).toBe(true);
    expect(isOnOrder(items, "Siding: HC-6")).toBe(false);
  });

  it("a very long line still matches after it is stored", () => {
    // build-state caps a label at 300 chars. Folding the same way keeps the row
    // marked "on order" after a reload instead of inviting a duplicate add.
    const long = "Siding: " + "Windham Cream ".repeat(40);
    expect(itemKey(long)).toBe(itemKey(long.slice(0, 300)));
    expect(isOnOrder([{ label: long.slice(0, 300) }], long)).toBe(true);
  });

  it("an empty line never counts as added", () => {
    expect(isOnOrder([{ label: "" }], "   ")).toBe(false);
  });
});

describe("the room travels with the color", () => {
  it("one room's door paint does not mark another room's", () => {
    // The color form writes "Door: Super White (OC-152)" into EVERY room that
    // picked it. Unqualified, adding the Kitchen's marked Hall and Bedroom as
    // ordered too, and one door's paint covered three rooms.
    const line = "Door: Super White (OC-152)";
    const kitchen = customItemLabel("Kitchen", line);
    const hall = customItemLabel("Hall", line);
    expect(kitchen).toBe("Kitchen · Door: Super White (OC-152)");
    expect(isOnOrder([{ label: kitchen }], hall)).toBe(false);
    expect(isOnOrder([{ label: kitchen }], kitchen)).toBe(true);
  });

  it("does not repeat a room the note already names", () => {
    expect(customItemLabel("Exterior", "Exterior siding: HC-6")).toBe("Exterior siding: HC-6");
    expect(customItemLabel(null, "Siding: HC-6")).toBe("Siding: HC-6");
  });
});

describe("a color the buy-list already covers", () => {
  const estimates = [{ colorName: "Windham Cream", colorCode: "HC-6" }];

  it("is recognised by code and by name", () => {
    expect(inBuyList("Siding: HC-6 Windham Cream - Low Lustre", estimates)).toBe(true);
    expect(inBuyList("Siding: windham cream", estimates)).toBe(true);
  });

  it("does not match a different code that merely starts the same", () => {
    expect(inBuyList("Trim: HC-62 Something", estimates)).toBe(false);
    expect(inBuyList("Trim: OC-95 Navajo White", estimates)).toBe(false);
  });

  it("ignores a color with no usable code or name", () => {
    expect(inBuyList("Trim: OC-95", [{ colorName: "Ivy", colorCode: null }])).toBe(false);
  });
});

describe("quantities are whole units, rounded up", () => {
  it("half a gallon is a gallon, not zero", () => {
    expect(orderableQty("0.5")).toBe(1);
    expect(orderableQty("2.1")).toBe(3);
    expect(orderableQty("0")).toBe(1);
    expect(orderableQty("")).toBe(1);
    expect(orderableQty("abc")).toBe(1);
    expect(orderableQty("-4")).toBe(1);
    expect(orderableQty(3)).toBe(3);
  });

  it("a typo cannot order a hundred gallons", () => {
    // 99 is the ceiling the persistence boundary already applies; before this
    // a typed 999 held until the page was reloaded, and the draft built in
    // between is what gets emailed.
    expect(orderableQty("999")).toBe(99);
    expect(orderableQty(1e9)).toBe(99);
  });
});

describe("custom item ids stay unique", () => {
  it("removing one and adding a similar label does not reuse the survivor's id", () => {
    const survivor = { id: nextCustomColorId([{ id: "cc-0-x" }], "Trim: OC-95") };
    const fresh = nextCustomColorId([survivor], "Trim: OC-95");
    expect(fresh).not.toBe(survivor.id);
  });

  it("an id is produced even for a label with no letters", () => {
    expect(nextCustomColorId([], "  — ")).toBe("cc-0-item");
  });
});
