import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extraGroupOf, groupExtras, EXTRA_GROUPS } from "@/lib/supplier-order/extras-groups";

/**
 * Two items from the raw materials-meeting notes that my summary had turned
 * into "ask Jason" when they were actually work on our side:
 *
 *   "Extras organize is like caulk should be stacked, rolls etc"
 *   "Caulk we'll order individual tubes or a whole case"
 *
 * The first is grouping. The second is a UNIT, not a quantity — a case is a
 * different SKU at the counter, not twelve tubes.
 */

/** The 20 active sundries in production, verbatim, on 2026-09-08. */
const CATALOGUE = [
  "3M 2\" 2090 Blue Tape",
  "3M 1 1/2\" 2090 Blue Tape",
  "3' Roll Building Paper",
  "12x400 ft .31 Plastic",
  "9x400 ft .31 plastic",
  "DAP Dynaflex 230 White",
  "DAP Alex Plus White Caulk 10oz",
  "DAP Alex Flex White 10 oz Caulk",
  "DAP Alex Fast Dry White 10oz",
  "Easy Sand 20",
  "Easy Sand 45",
  "Plaster of Paris 25lb bag",
  "5 Gal USG Green Joint Compound",
  "5 Gal Blue Top Compound",
  "9\" 5 Pack Tray Liners",
  "4 Qt Tray Liner",
  "4 inch microfiber roller covers 1/2 nap",
  "4 inch microfiber roller covers 3/8 nap",
  "9 inch microfiber 9/16 (4 pack)",
  "9 inch microfiber 9/16",
];

describe("the sundries catalogue groups", () => {
  it("puts all four caulks together", () => {
    // Three of the four are named "DAP …" with no "caulk" in them, so a rule
    // looking only for the word misses them.
    const caulk = CATALOGUE.filter((n) => extraGroupOf(n) === "Caulk");
    expect(caulk).toHaveLength(4);
    expect(caulk.every((n) => n.startsWith("DAP"))).toBe(true);
  });

  it("puts all four roller covers together", () => {
    expect(CATALOGUE.filter((n) => extraGroupOf(n) === "Roller covers")).toHaveLength(4);
  });

  it("does not let a roller cover fall into masking", () => {
    // "9 inch microfiber 9/16 (4 pack)" contains "pack"; ordering matters.
    expect(extraGroupOf("9 inch microfiber 9/16 (4 pack)")).toBe("Roller covers");
  });

  it("groups every real product — nothing lands in Other", () => {
    // "Other" is a silent dumping ground: an item goes there and nobody
    // notices until a worker cannot find it.
    const orphans = CATALOGUE.filter((n) => extraGroupOf(n) === "Other");
    expect(orphans, "these need a rule in extraGroupOf").toEqual([]);
  });

  it("covers the whole catalogue with no item counted twice", () => {
    const grouped = groupExtras(CATALOGUE.map((name) => ({ name })));
    expect(grouped.flatMap((g) => g.items)).toHaveLength(CATALOGUE.length);
    expect(grouped.every((g) => g.items.length > 0)).toBe(true);
  });

  it("keeps the groups in a fixed order", () => {
    const grouped = groupExtras(CATALOGUE.map((name) => ({ name })));
    const order = grouped.map((g) => g.group);
    expect(order).toEqual([...order].sort((a, b) => EXTRA_GROUPS.indexOf(a) - EXTRA_GROUPS.indexOf(b)));
  });
});

describe("caulk can be ordered by the case", () => {
  const view = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");

  it("changes the UNIT, not the quantity", () => {
    expect(view).toMatch(/setExtraUnit\(c\.id, ev\.target\.value\)/);
    expect(view).toMatch(/<option value="case">case<\/option>/);
  });

  it("is offered only where the product is sold in tubes", () => {
    // Nothing else PPP orders comes by the case; a unit toggle on tape would
    // be a control that produces an unfillable line.
    expect(view).toMatch(/c\.unit === "tube" &&/);
  });

  it("the catalogue is rendered grouped", () => {
    expect(view).toMatch(/groupExtras\(filteredCatalog\)/);
  });
});
