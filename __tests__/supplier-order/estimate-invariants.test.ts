import { describe, it, expect } from "vitest";
import {
  COVERAGE_CONFIG,
  estimateOrderGallons,
  summarizeOrder,
  formatOrderQuantity,
  overrideTotal,
  applyQuantityOverrides,
  quantityKey,
  GALLONS_PER_BUCKET,
  type RoomTakeoff,
  type GallonEstimate,
} from "@/lib/supplier-order/estimate-gallons";

/**
 * Properties the estimator has to hold whatever the rules say.
 *
 * The rules themselves are pinned by example elsewhere — a 15x20 room, a
 * bathroom, doors, trim across rooms. Examples only cover the cases somebody
 * thought of, and this file's whole job is the ones nobody did: every rule
 * added this month (1.5 coats, the bathroom split and its floors, the trim
 * rate and its 2-room floor, doors and windows priced from their own faces)
 * is a branch that can fire on a shape no test names.
 *
 * Deterministic pseudo-random input, so a failure is reproducible from the
 * seed printed with it rather than being a flake.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ROOM_LABELS = [
  "Living Room", "Bedroom", "Kitchen", "Bathroom", "Powder Rm", "Hallway",
  "Master Bath", "Dining Room", "Study", "Pool bathhouse", "", "Unit 2 Bath",
];
const SURFACES: Array<{ label: string; kind: RoomTakeoff["surfaces"][number]["kind"] }> = [
  { label: "Walls", kind: "walls" },
  { label: "Ceiling", kind: "ceiling" },
  { label: "Trim", kind: "trim" },
  { label: "Door", kind: "trim" },
  { label: "Window", kind: "trim" },
  { label: "Cabinets", kind: "unsized" },
  { label: "Floor", kind: "floor" },
];

function randomJob(rand: () => number): RoomTakeoff[] {
  const rooms: RoomTakeoff[] = [];
  const n = 1 + Math.floor(rand() * 8);
  for (let i = 0; i < n; i++) {
    const w = Math.floor(rand() * 30);
    const l = Math.floor(rand() * 30);
    const surfaces = SURFACES.filter(() => rand() < 0.45).map((s) => ({
      kind: s.kind,
      surfaceLabel: s.label,
      // A small color pool, so colors really are shared across rooms.
      colorId: `c${Math.floor(rand() * 3)}`,
      colorName: "Some White",
      colorCode: "OC-17",
      finish: rand() < 0.5 ? "Eggshell" : null,
    }));
    rooms.push({
      woliId: `woli-${i}`,
      roomLabel: ROOM_LABELS[Math.floor(rand() * ROOM_LABELS.length)],
      floorAreaSqft: rand() < 0.15 ? 0 : w * l,
      wallSurfaceAreaSqft: rand() < 0.3 ? Math.floor(rand() * 900) : 0,
      perimeterLf: rand() < 0.2 ? 0 : 2 * (w + l),
      heightFt: rand() < 0.2 ? 0 : 8 + Math.floor(rand() * 4),
      doors: Math.floor(rand() * 4),
      windows: Math.floor(rand() * 4),
      closets: Math.floor(rand() * 2),
      coats: rand() < 0.25 ? 1 + Math.floor(rand() * 3) : 0,
      paintDoorFaces: rand() < 0.3,
      surfaces,
    });
  }
  return rooms;
}

/** Containers on the order, in gallons, for a sanity ceiling. */
const gallonsOf = (e: GallonEstimate) =>
  overrideTotal({ buckets: e.buckets, cans: e.cans, unit: e.unit }) * (e.unit === "qt" ? 0.25 : 1);

describe("whatever the rules do, these must hold", () => {
  it("1000 random jobs produce only finite, sane, orderable numbers", () => {
    // Every assertion below lives inside `for (const e of out)`. If the
    // estimator returned nothing at all — for every seed — this test would
    // pass completely, having checked nothing. 9 of these seeds legitimately
    // produce zero lines, so that is not hypothetical. Count what was actually
    // examined and assert on the count.
    let linesChecked = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const rand = rng(seed);
      const job = randomJob(rand);
      const out = estimateOrderGallons(job);
      linesChecked += out.length;
      for (const e of out) {
        const where = `seed ${seed}, color ${e.colorId}`;
        expect(Number.isFinite(e.buckets), where).toBe(true);
        expect(Number.isFinite(e.cans), where).toBe(true);
        expect(Number.isFinite(e.totalSqft), where).toBe(true);
        expect(e.buckets, where).toBeGreaterThanOrEqual(0);
        expect(e.cans, where).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(e.buckets), where).toBe(true);
        expect(Number.isInteger(e.cans), where).toBe(true);
        // A single color line can never exceed the estimator's own rail. The
        // bound used to be 495 gal against a reachable maximum of 99, so it
        // would have passed a five-fold error.
        expect(gallonsOf(e), where).toBeLessThanOrEqual(COVERAGE_CONFIG.maxGallonsPerLine);
        // Whatever it prints, it prints something a person can read — a
        // number, or one of the deliberate words ("TBD", "needs review").
        // Never a NaN, an undefined or an empty cell.
        const printed = formatOrderQuantity(e);
        expect(printed, where).toBeTruthy();
        expect(printed, where).not.toMatch(/NaN|undefined|Infinity|null/);
      }
      // No duplicate lines: one row per (color, finish, bathroom-or-not).
      const keys = out.map((e) => quantityKey(e.colorId, e.finish, e.isBathroom));
      expect(new Set(keys).size, `seed ${seed}`).toBe(keys.length);
    }
    // The proof this measured something. ~3 lines a job across 1000 jobs.
    expect(linesChecked).toBeGreaterThan(1000);
  });

  it("a bigger room never orders less paint", () => {
    // Every rule added this month either replaces a number (a default) or
    // raises one (a floor). A replacement that is not also a floor shows up
    // here as a bigger room ordering less — which is how the bathroom cap was
    // found, and the only kind of arithmetic mistake that costs a second trip
    // to the store.
    for (const label of ["Bedroom", "Bathroom", "Powder Rm", "Kitchen", "Hallway"]) {
      let previous = 0;
      for (const side of [5, 7, 9, 12, 15, 18, 22, 28]) {
        const [e] = estimateOrderGallons([
          {
            woliId: "w", roomLabel: label,
            floorAreaSqft: side * side, wallSurfaceAreaSqft: 0, perimeterLf: 4 * side, heightFt: 8,
            doors: 1, windows: 1, closets: 0, coats: 0, paintDoorFaces: false,
            surfaces: [{ kind: "walls", surfaceLabel: "Walls", colorId: "c", colorName: "W", colorCode: null, finish: "Eggshell" }],
          },
        ]);
        const g = gallonsOf(e);
        expect(g, `${label} at ${side}x${side} ordered less than the smaller room`).toBeGreaterThanOrEqual(previous);
        previous = g;
      }
    }
  });

  it("adding a room never shrinks the order", () => {
    const base: RoomTakeoff = {
      woliId: "w1", roomLabel: "Bedroom",
      floorAreaSqft: 180, wallSurfaceAreaSqft: 0, perimeterLf: 54, heightFt: 8,
      doors: 1, windows: 1, closets: 0, coats: 0, paintDoorFaces: false,
      surfaces: [{ kind: "walls", surfaceLabel: "Walls", colorId: "c", colorName: "W", colorCode: null, finish: "Eggshell" }],
    };
    for (const label of ["Bedroom 2", "Bathroom", "Kitchen"]) {
      const one = estimateOrderGallons([base]).reduce((a, e) => a + gallonsOf(e), 0);
      const two = estimateOrderGallons([base, { ...base, woliId: "w2", roomLabel: label }])
        .reduce((a, e) => a + gallonsOf(e), 0);
      expect(two, `adding ${label} shrank the order`).toBeGreaterThanOrEqual(one);
    }
  });

  it("garbage measurements are capped and flagged, not bought", () => {
    // A rep's stray keystroke in Sq_Footage__c used to compute 445 gal and go
    // straight to the vendor: typed quantities are clamped at three
    // boundaries, the estimate at none.
    const [e] = estimateOrderGallons([
      {
        woliId: "w", roomLabel: "Living Room",
        floorAreaSqft: 9_999_999, wallSurfaceAreaSqft: 0, perimeterLf: 60, heightFt: 8,
        doors: 0, windows: 0, closets: 0, coats: 0, paintDoorFaces: false,
        // A CEILING: its area is the floor area, so the garbage number reaches
        // the gallons directly. (Walls are derived from perimeter x height, so
        // a huge floor area alone does not move them — which is why the first
        // version of this test passed without the cap doing anything.)
        surfaces: [{ kind: "ceiling", surfaceLabel: "Ceiling", colorId: "c", colorName: "W", colorCode: null, finish: null }],
      },
    ]);
    expect(e.buckets * GALLONS_PER_BUCKET + e.cans).toBeLessThanOrEqual(99);
    expect(e.defaultedNote ?? "").toMatch(/typo|check/i);
  });

  it("the job total is the sum of the lines it shows", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const out = estimateOrderGallons(randomJob(rng(seed)));
      const totals = summarizeOrder(out);
      const cans = out.filter((e) => (e.unit ?? "gal") === "gal").reduce((a, e) => a + e.cans, 0);
      const quarts = out.filter((e) => e.unit === "qt").reduce((a, e) => a + e.cans, 0);
      expect(totals.cans, `seed ${seed}`).toBe(cans);
      expect(totals.quarts, `seed ${seed}`).toBe(quarts);
    }
  });

  it("a typed quantity always wins, on every line, in every job", () => {
    // The bathroom split made a line's identity more complicated. Whatever the
    // shape, what the estimator typed is what comes out.
    for (let seed = 1; seed <= 300; seed++) {
      const out = estimateOrderGallons(randomJob(rng(seed)));
      if (out.length === 0) continue;
      const overrides = new Map(
        out.map((e, i) => [quantityKey(e.colorId, e.finish, e.isBathroom), { buckets: 0, cans: (i % 9) + 1, unit: "gal" as const }])
      );
      const applied = applyQuantityOverrides(out, overrides);
      applied.forEach((e, i) => {
        expect(e.cans, `seed ${seed} line ${i}`).toBe((i % 9) + 1);
        expect(e.excluded ?? false, `seed ${seed} line ${i}`).toBe(false);
      });
    }
  });
});
