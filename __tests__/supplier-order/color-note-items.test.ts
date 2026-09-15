import { describe, it, expect } from "vitest";
import { colorNoteLines, isOnOrder, nextCustomColorId } from "@/lib/supplier-order/color-note-items";

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

  it("orphan-surface colors the form wrote are offered too — they reach the vendor no other way", () => {
    const raw = "Kitchen:\nCabinets: White Dove (OC-17) — Satin\nDoor: Super White (OC-152)\nCustomer notes: match the hall";
    expect(colorNoteLines(raw)).toEqual([
      "Cabinets: White Dove (OC-17) — Satin",
      "Door: Super White (OC-152)",
      "match the hall",
    ]);
  });

  it("drops bullets, bare headings, separators and CRLF", () => {
    const raw = "Exterior:\r\n- Siding: HC-6\r\n--\r\n• Trim: OC-95\r\n2) Door: 447";
    expect(colorNoteLines(raw)).toEqual(["Siding: HC-6", "Trim: OC-95", "Door: 447"]);
  });

  it("never offers the don't-paint bookkeeping", () => {
    const raw = 'Customer selected "Don\'t paint this surface" on Ceiling. Customer notes: Walls: SW 7005';
    expect(colorNoteLines(raw)).toEqual(["Walls: SW 7005"]);
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
    const items = [{ id: "a", label: "Trim:  oc-95 navajo white" }];
    expect(isOnOrder(items, "Trim: OC-95 Navajo White")).toBe(true);
    expect(isOnOrder(items, "Siding: HC-6")).toBe(false);
  });
});

describe("custom item ids stay unique", () => {
  it("removing one and adding a similar label does not reuse the survivor's id", () => {
    // The old scheme: `cc-${items.length}-${label.length}-${slug}`. Two items,
    // remove the first, add "Trim: OC-95" again → length 1 → the survivor's id.
    const survivor = { id: nextCustomColorId([{ id: "cc-0-x" }], "Trim: OC-95") };
    const after = [survivor];
    const fresh = nextCustomColorId(after, "Trim: OC-95");
    expect(fresh).not.toBe(survivor.id);
  });

  it("an id is produced even for a label with no letters", () => {
    expect(nextCustomColorId([], "  — ")).toBe("cc-0-item");
  });
});
