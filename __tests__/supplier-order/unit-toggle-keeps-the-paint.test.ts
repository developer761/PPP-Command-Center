import { describe, it, expect } from "vitest";
import {
  convertUnit,
  gallonsOfOverride,
  unitCanHold,
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

  it("a round trip never comes back with less paint than it left with", () => {
    // Rounding UP is deliberate: a gallon short is a second trip to the store,
    // a gallon over is a gallon on the shelf. So the round trip may grow — it
    // must never shrink. The one way it could is the 99-container rail, and
    // that is exactly what `unitCanHold` refuses before it happens.
    let conversionsChecked = 0;
    let refusals = 0;
    for (const from of UNITS) {
      for (const to of UNITS) {
        for (const n of [1, 2, 3, 5, 7, 12, 40, 99]) {
          const start = { buckets: 0, cans: n, unit: from };
          const where = `${n} ${from} -> ${to} -> ${from}`;
          if (!unitCanHold(start, to)) {
            // Refused, so the line keeps the volume it had. Prove the refusal
            // was warranted rather than trusting it.
            expect(gallonsOfOverride(convertUnit(start, to)), where).toBeLessThan(gallonsOfOverride(start));
            refusals++;
            continue;
          }
          const there = convertUnit(start, to);
          conversionsChecked++;
          expect(gallonsOfOverride(there), where).toBeGreaterThanOrEqual(gallonsOfOverride(start));
          if (unitCanHold(there, from)) {
            expect(gallonsOfOverride(convertUnit(there, from)), where).toBeGreaterThanOrEqual(gallonsOfOverride(start));
          }
        }
      }
    }
    // The proof this measured something: a loop that refused everything, or
    // converted nothing, would pass every assertion above.
    expect(conversionsChecked).toBeGreaterThan(50);
    expect(refusals).toBeGreaterThan(0);
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

  it("a part-pail rounds up to a whole pail, never down to none", () => {
    expect(convertUnit({ buckets: 0, cans: 1, unit: "gal" }, "bucket").cans).toBe(1);
    expect(convertUnit({ buckets: 0, cans: 6, unit: "gal" }, "bucket").cans).toBe(2);
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
    expect(convertUnit({ buckets: 2, cans: 3, unit: "gal" }, "bucket").cans).toBe(3);
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
