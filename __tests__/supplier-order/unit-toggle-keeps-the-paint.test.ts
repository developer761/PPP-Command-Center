import { describe, it, expect } from "vitest";
import {
  convertUnit,
  gallonsOfOverride,
  unitCanHold,
  conversionShortfallGal,
  containerCount,
  overrideTotal,
  stepContainers,
  GALLONS_PER_BUCKET,
  QUARTS_PER_GALLON,
  type PaintUnit,
} from "@/lib/supplier-order/estimate-gallons";

/**
 * Pressing "Gal" on a 2-pail line ordered 2 gallons.
 *
 * Ten gallons of paint became two, on the screen and in the vendor's email,
 * with nothing to show anything had happened. The toggle was reading the line
 * as a CONTAINER COUNT (2) and handing it to `packageForUnit`, whose argument
 * means gallons for a pail and quarts for a quart — so the number survived and
 * the volume did not. It arrived with the fix for a dead "−" button, which is
 * the same conflation from the other side.
 *
 * Three different questions now have three different functions:
 *   containerCount   — how many things do I carry out of the store  (+/- steps this)
 *   overrideTotal    — the number the email prints for this unit
 *   gallonsOfOverride— how much paint this actually is              (the toggle converts this)
 */

const UNITS: PaintUnit[] = ["gal", "qt", "bucket"];

describe("changing the unit does not change how much paint was ordered", () => {
  it("2 pails is 10 gallons is 40 quarts, in every direction", () => {
    const twoPails = { buckets: 0, cans: 2, unit: "bucket" as PaintUnit };
    expect(gallonsOfOverride(twoPails)).toBe(10);
    expect(convertUnit(twoPails, "gal")).toEqual({ buckets: 0, cans: 10, unit: "gal" });
    expect(convertUnit(twoPails, "qt")).toEqual({ buckets: 0, cans: 40, unit: "qt" });

    const tenGal = { buckets: 0, cans: 10, unit: "gal" as PaintUnit };
    expect(convertUnit(tenGal, "bucket")).toEqual({ buckets: 0, cans: 2, unit: "bucket" });
    expect(convertUnit(tenGal, "qt")).toEqual({ buckets: 0, cans: 40, unit: "qt" });

    const fortyQt = { buckets: 0, cans: 40, unit: "qt" as PaintUnit };
    expect(convertUnit(fortyQt, "gal")).toEqual({ buckets: 0, cans: 10, unit: "gal" });
    expect(convertUnit(fortyQt, "bucket")).toEqual({ buckets: 0, cans: 2, unit: "bucket" });
  });

  it("never loses more than one container, and never loses all of it", () => {
    // Pails round DOWN (Karan 2026-09-18: "round down always"), so a
    // conversion CAN come back with less paint — deliberately. What it must
    // never do is round away more than the container it is rounding to, or
    // round a real order down to nothing.
    let conversionsChecked = 0;
    let shortfalls = 0;
    for (const from of UNITS) {
      for (const to of UNITS) {
        for (const n of [1, 2, 3, 5, 7, 12, 40, 99]) {
          const start = { buckets: 0, cans: n, unit: from };
          const where = `${n} ${from} -> ${to}`;
          if (!unitCanHold(start, to)) continue;
          const there = convertUnit(start, to);
          conversionsChecked++;
          expect(there.cans, where).toBeGreaterThan(0);
          const lost = gallonsOfOverride(start) - gallonsOfOverride(there);
          const oneContainer = to === "bucket" ? GALLONS_PER_BUCKET : to === "qt" ? 1 / QUARTS_PER_GALLON : 1;
          expect(lost, where).toBeLessThan(oneContainer);
          if (lost > 0) shortfalls++;
        }
      }
    }
    // The proof this measured something: a loop that converted nothing, or
    // that never rounded down at all, would pass every assertion above.
    expect(conversionsChecked).toBeGreaterThan(50);
    expect(shortfalls).toBeGreaterThan(0);
  });

  it("names the gallons a pail conversion leaves behind", () => {
    // 7 gallons is one pail and two gallons of stock. The estimator is told
    // the number rather than left to notice it.
    expect(conversionShortfallGal({ buckets: 0, cans: 7, unit: "gal" }, "bucket")).toBe(2);
    expect(conversionShortfallGal({ buckets: 0, cans: 10, unit: "gal" }, "bucket")).toBe(0);
    expect(conversionShortfallGal({ buckets: 0, cans: 3, unit: "gal" }, "bucket")).toBe(0);
  });

  it("refuses only the conversions that would lose paint", () => {
    // 40 gallons is 160 quarts; the rail is 99 containers.
    expect(unitCanHold({ buckets: 0, cans: 40, unit: "gal" }, "qt")).toBe(false);
    expect(unitCanHold({ buckets: 0, cans: 40, unit: "gal" }, "bucket")).toBe(true);
    expect(unitCanHold({ buckets: 0, cans: 24, unit: "gal" }, "qt")).toBe(true);
    expect(unitCanHold({ buckets: 0, cans: 25, unit: "gal" }, "qt")).toBe(false);
    // Coming DOWN in container count is always expressible.
    expect(unitCanHold({ buckets: 0, cans: 99, unit: "qt" }, "gal")).toBe(true);
    expect(unitCanHold({ buckets: 0, cans: 99, unit: "bucket" }, "bucket")).toBe(true);
  });

  it("a part-pail rounds DOWN — but never to none", () => {
    // Karan 2026-09-18. A pail is five gallons of a mixed color; the spare
    // gallons of an over-bought pail sit on a shelf forever, and the crew
    // carries stock for a two-gallon remainder.
    expect(convertUnit({ buckets: 0, cans: 6, unit: "gal" }, "bucket").cans).toBe(1);
    expect(convertUnit({ buckets: 0, cans: 9, unit: "gal" }, "bucket").cans).toBe(1);
    expect(convertUnit({ buckets: 0, cans: 10, unit: "gal" }, "bucket").cans).toBe(2);
    expect(convertUnit({ buckets: 0, cans: 14, unit: "gal" }, "bucket").cans).toBe(2);
    // …and the floor: rounding down must never mean ordering nothing.
    expect(convertUnit({ buckets: 0, cans: 1, unit: "gal" }, "bucket").cans).toBe(1);
    expect(convertUnit({ buckets: 0, cans: 4, unit: "gal" }, "bucket").cans).toBe(1);
    expect(convertUnit({ buckets: 0, cans: 0, unit: "gal" }, "bucket").cans).toBe(0);
    // A single quart is still a pail's worth of nothing — but it is not zero.
    expect(convertUnit({ buckets: 0, cans: 1, unit: "qt" }, "gal").cans).toBe(1);
    expect(convertUnit({ buckets: 0, cans: 3, unit: "qt" }, "gal").cans).toBe(1);
    expect(convertUnit({ buckets: 0, cans: 5, unit: "qt" }, "gal").cans).toBe(2);
  });

  it("nothing stays nothing, and nothing exceeds the 99 every other path clamps to", () => {
    for (const to of UNITS) {
      expect(convertUnit({ buckets: 0, cans: 0, unit: "gal" }, to).cans).toBe(0);
      expect(convertUnit({ buckets: 0, cans: 99, unit: "bucket" }, to).cans).toBeLessThanOrEqual(99);
    }
  });

  it("reads a legacy bucket+can pair as its real volume", () => {
    // Older saved payloads still carry `buckets` alongside `cans`.
    expect(gallonsOfOverride({ buckets: 2, cans: 3, unit: "gal" })).toBe(13);
    // 13 gallons is two pails and three gallons of stock — rounded down.
    expect(convertUnit({ buckets: 2, cans: 3, unit: "gal" }, "bucket").cans).toBe(2);
  });
});

describe("the three questions stay different", () => {
  it("containers, printed total and gallons disagree on purpose", () => {
    const twoPails = { buckets: 0, cans: 2, unit: "bucket" as PaintUnit };
    expect(containerCount(twoPails)).toBe(2);                       // two things to carry
    expect(overrideTotal(twoPails)).toBe(2 * GALLONS_PER_BUCKET);   // what the email prints
    expect(gallonsOfOverride(twoPails)).toBe(10);                   // how much paint

    const fourQt = { buckets: 0, cans: 4, unit: "qt" as PaintUnit };
    expect(containerCount(fourQt)).toBe(4);
    expect(overrideTotal(fourQt)).toBe(4);                          // quarts, listed as quarts
    expect(gallonsOfOverride(fourQt)).toBe(4 / QUARTS_PER_GALLON);  // one gallon of paint
  });

  it("the stepper still steps containers after a toggle", () => {
    // The two fixes have to coexist: "−" on a pail line removes a pail, and
    // the toggle still converts. Each broke the other once.
    const pails = convertUnit({ buckets: 0, cans: 10, unit: "gal" }, "bucket");
    expect(stepContainers(pails, -1)).toEqual({ buckets: 0, cans: 1, unit: "bucket" });
    expect(stepContainers(pails, +1)).toEqual({ buckets: 0, cans: 3, unit: "bucket" });
  });
});
