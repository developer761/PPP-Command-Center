/**
 * Verification for the paint gallons calculator — mirrors PPP's spec
 * (ppp-salesforce-reference/estimating/paint-gallons-calculator.md, Katie).
 *
 *   npx tsx scripts/verify-gallon-estimate.ts
 *
 * Coverage 375, +10% buffer, 2 coats, 5-gal bucket packaging, opening
 * deductions + trim casings. Includes Katie's worked example.
 */
import {
  estimateOrderGallons,
  packageGallons,
  classifySurface,
  formatOrderQuantity,
  formatBucketsCans,
  summarizeOrder,
  COVERAGE_CONFIG,
  type RoomTakeoff,
  type RoomSurface,
} from "../lib/supplier-order/estimate-gallons";
import { isValidCoverageValue, MAX_COVERAGE_VALUES } from "../lib/supplier-order/coverage-validation";
import { isJobComplete } from "../lib/wo-progress/completion";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function surf(kind: RoomSurface["kind"], colorId: string, label: string, finish: string | null = null): RoomSurface {
  return { kind, surfaceLabel: label, colorId, colorName: colorId, colorCode: null, finish };
}
function room(p: Partial<RoomTakeoff> & { woliId: string; surfaces: RoomSurface[] }): RoomTakeoff {
  return {
    woliId: p.woliId,
    roomLabel: p.roomLabel ?? "Room",
    floorAreaSqft: p.floorAreaSqft ?? 0,
    wallSurfaceAreaSqft: p.wallSurfaceAreaSqft ?? 0,
    perimeterLf: p.perimeterLf ?? 0,
    heightFt: p.heightFt ?? 0,
    doors: p.doors ?? 0,
    windows: p.windows ?? 0,
    closets: p.closets ?? 0,
    coats: p.coats ?? 0,
    paintDoorFaces: p.paintDoorFaces ?? false,
    surfaces: p.surfaces,
  };
}

console.log("classifySurface:");
check("Ceiling→ceiling", classifySurface("Ceiling") === "ceiling");
check("Walls→walls", classifySurface("Walls") === "walls");
check("Trim→trim", classifySurface("Trim") === "trim");
check("Door→trim", classifySurface("Door") === "trim");
check("Window→trim", classifySurface("Window") === "trim");
check("Floor→floor", classifySurface("Floor") === "floor");
check("Accent Wall→unsized", classifySurface("Accent Wall") === "unsized");
check("Cabinets→unsized", classifySurface("Cabinets") === "unsized");
check("Closet→unsized", classifySurface("Closet") === "unsized");

console.log("\npackageGallons (Katie's examples):");
const pk = (g: number) => packageGallons(g);
check("3.0 → 3 cans", pk(3.0).buckets === 0 && pk(3.0).cans === 3, JSON.stringify(pk(3.0)));
check("4.0 → 4 cans", pk(4.0).buckets === 0 && pk(4.0).cans === 4, JSON.stringify(pk(4.0)));
check("4.5 → 1 bucket", pk(4.5).buckets === 1 && pk(4.5).cans === 0, JSON.stringify(pk(4.5)));
check("6.2 → 1 bucket + 2 cans", pk(6.2).buckets === 1 && pk(6.2).cans === 2, JSON.stringify(pk(6.2)));
check("9.5 → 2 buckets", pk(9.5).buckets === 2 && pk(9.5).cans === 0, JSON.stringify(pk(9.5)));
check("14 → 2 buckets + 4 cans", pk(14).buckets === 2 && pk(14).cans === 4, JSON.stringify(pk(14)));

console.log("\nKatie's worked example — 12×12×8, 1 door(face)/2 windows/1 closet:");
{
  const r = room({
    woliId: "w1", roomLabel: "Bedroom",
    floorAreaSqft: 144, perimeterLf: 48, heightFt: 8,
    doors: 1, windows: 2, closets: 1, coats: 2, paintDoorFaces: true,
    surfaces: [
      surf("ceiling", "CW", "Ceiling", "Flat"),
      surf("walls", "WL", "Walls", "Eggshell"),
      surf("trim", "TR", "Trim", "Semi-Gloss"),
    ],
  });
  const out = estimateOrderGallons([r]);
  const by = (id: string) => out.find((e) => e.colorId === id);
  // ceiling 288 sqft → 0.845 gal → 1 can ; walls 608 → 1.78 → 2 ; trim 96.5 → 0.28 → 1
  check("ceiling = 1 gal (1 can)", by("CW")?.cans === 1 && by("CW")?.buckets === 0, JSON.stringify(by("CW")));
  check("ceiling totalSqft = 288", by("CW")?.totalSqft === 288, `${by("CW")?.totalSqft}`);
  check("walls = 2 gal (2 cans)", by("WL")?.cans === 2 && by("WL")?.buckets === 0, JSON.stringify(by("WL")));
  check("walls totalSqft = 608", by("WL")?.totalSqft === 608, `${by("WL")?.totalSqft}`);
  check("trim = 1 gal (1 can)", by("TR")?.cans === 1 && by("TR")?.buckets === 0, JSON.stringify(by("TR")));
  check("trim totalSqft ≈ 97", by("TR")?.totalSqft === 97, `${by("TR")?.totalSqft}`); // 96.5 rounds to 97
}

console.log("\nperimeter derived from floor area (no perimeter field) reproduces the example walls:");
{
  // square room: 4×√144 = 48 → same as the explicit perimeter above
  const r = room({
    woliId: "w1", floorAreaSqft: 144, heightFt: 8, doors: 1, windows: 2, closets: 1, coats: 2,
    surfaces: [surf("walls", "WL", "Walls", "Eggshell")],
  });
  const out = estimateOrderGallons([r]);
  check("derived-perimeter walls totalSqft = 608", out[0]?.totalSqft === 608, `${out[0]?.totalSqft}`);
}

console.log("\ndefaults when openings not captured (1 door + 1 window, 0 closets):");
{
  // 12×12×8, coats 2, no counts → doors 1, windows 1, closets 0
  // walls = (48*8 - 20 - 15 - 0)*2 = (384-35)*2 = 698 ; 698/375*1.1 = 2.05 → 3 cans
  const r = room({ woliId: "w1", floorAreaSqft: 144, heightFt: 8, coats: 2, surfaces: [surf("walls", "WL", "Walls")] });
  const out = estimateOrderGallons([r]);
  check("walls totalSqft = 698 (default openings)", out[0]?.totalSqft === 698, `${out[0]?.totalSqft}`);
  check("walls = 3 cans", out[0]?.cans === 3 && out[0]?.buckets === 0, JSON.stringify(out[0]));
}

console.log("\nsame color+finish across rooms rolls up once, then packages → buckets:");
{
  // two big rooms, same wall color: each (4√400=80 perim ×9 −35)*2 ... use explicit
  // perimeter 100, height 10, no openings-default(1/1/0): (100*10 -20-15)*2 = 1930 each
  const mk = (id: string) => room({
    woliId: id, roomLabel: id, floorAreaSqft: 625, perimeterLf: 100, heightFt: 10, coats: 2,
    surfaces: [surf("walls", "WL", "Walls", "Eggshell")],
  });
  const out = estimateOrderGallons([mk("r1"), mk("r2")]);
  // total = 3860 ; /375 = 10.29 ; *1.1 = 11.32 ; package: >4→b1(6.32),>4→b2(1.32); cans=ceil(1.32)=2
  check("single rolled-up line", out.length === 1, `${out.length}`);
  check("covers 2 rooms", out[0]?.rooms.length === 2);
  check("2 buckets + 2 cans", out[0]?.buckets === 2 && out[0]?.cans === 2, JSON.stringify(out[0]));
}

console.log("\nmissing floor area → needs measurement, 0 order:");
{
  const r = room({ woliId: "w1", floorAreaSqft: 0, surfaces: [surf("walls", "WL", "Walls")] });
  const out = estimateOrderGallons([r]);
  check("0 buckets + 0 cans", out[0]?.buckets === 0 && out[0]?.cans === 0);
  check("needsMeasurement", out[0]?.needsMeasurement === true);
  check("formatOrderQuantity = needs measurement", formatOrderQuantity(out[0]) === "needs measurement");
}

console.log("\nunsized surface (Accent Wall) → needs review:");
{
  const r = room({ woliId: "w1", floorAreaSqft: 144, surfaces: [surf("unsized", "AC", "Accent Wall")] });
  const out = estimateOrderGallons([r]);
  check("unsized flag", out[0]?.unsized === true);
  check("formatOrderQuantity = needs review", formatOrderQuantity(out[0]) === "needs review");
}

console.log("\nmeasured wall area (Wall_Surface_Area__c) used directly, no floor needed:");
{
  // wallSurfaceArea 400, 2 coats → 800 sqft → /375*1.1 = 2.35 → 3 cans; floor=0
  // must NOT flag needsMeasurement (the wall was measured).
  const r = room({ woliId: "w1", floorAreaSqft: 0, wallSurfaceAreaSqft: 400, coats: 2, surfaces: [surf("walls", "WL", "Walls")] });
  const out = estimateOrderGallons([r]);
  check("uses measured wall area → totalSqft 800", out[0]?.totalSqft === 800, `${out[0]?.totalSqft}`);
  check("3 cans", out[0]?.cans === 3 && out[0]?.buckets === 0, JSON.stringify(out[0]));
  check("NOT needsMeasurement (wall measured despite no floor)", out[0]?.needsMeasurement === false);
}

console.log("\nreal height used when present (10ft taller → more wall):");
{
  // perimeter 48, height 10, default openings(1/1/0): (48*10 - 35)*2 = 890
  const r = room({ woliId: "w1", floorAreaSqft: 144, perimeterLf: 48, heightFt: 10, coats: 2, surfaces: [surf("walls", "WL", "Walls")] });
  const out = estimateOrderGallons([r]);
  check("height 10 → walls totalSqft 890", out[0]?.totalSqft === 890, `${out[0]?.totalSqft}`);
}

console.log("\nmixed sized + unsized same color (walls + cabinets) — flag as may-be-low:");
{
  // Same color on Walls (sized) AND Cabinets (unsized) in one room. Gallons
  // cover only walls — so the figure is an UNDER-count and the bucket must
  // surface needsMeasurement so the UI shows "may be low" instead of looking
  // like a clean quantity.
  const r = room({
    woliId: "w1", floorAreaSqft: 144, perimeterLf: 48, heightFt: 8, coats: 2,
    surfaces: [
      surf("walls", "MIX", "Walls", "Eggshell"),
      surf("unsized", "MIX", "Cabinets", "Eggshell"),
    ],
  });
  const out = estimateOrderGallons([r]);
  check("mixed bucket has gallons (sized contribution counted)", (out[0]?.buckets ?? 0) + (out[0]?.cans ?? 0) > 0);
  check("mixed bucket needsMeasurement=true (under-count warning)", out[0]?.needsMeasurement === true);
  check("mixed bucket unsized=false (still has sized gallons)", out[0]?.unsized === false);
  check("mixed bucket surfaces include both Walls AND Cabinets", out[0]?.surfaces.includes("Walls") === true && out[0]?.surfaces.includes("Cabinets") === true);
}

console.log("\nformatOrderQuantity packaging strings:");
{
  const mk = (buckets: number, cans: number) => ({ buckets, cans, unsized: false, needsMeasurement: false } as never);
  check('1 bucket + 2 gal', formatOrderQuantity(mk(1, 2)) === "1 bucket (×5 gal) + 2 gal", formatOrderQuantity(mk(1, 2)));
  check('3 gal', formatOrderQuantity(mk(0, 3)) === "3 gal", formatOrderQuantity(mk(0, 3)));
  check('2 buckets', formatOrderQuantity(mk(2, 0)) === "2 buckets (×5 gal)", formatOrderQuantity(mk(2, 0)));
}

console.log("\nsummarizeOrder + formatBucketsCans (job total):");
{
  const ests = [
    { buckets: 2, cans: 1 }, { buckets: 0, cans: 3 }, { buckets: 0, cans: 0 },
  ] as never[];
  const t = summarizeOrder(ests);
  check("total 2 buckets + 4 cans", t.buckets === 2 && t.cans === 4, JSON.stringify(t));
  check("2 sized, 1 review", t.sizedColors === 2 && t.reviewColors === 1, JSON.stringify(t));
  check("formatBucketsCans(2,4)", formatBucketsCans(2, 4) === "2 buckets (×5 gal) + 4 gal", formatBucketsCans(2, 4));
  check("formatBucketsCans(0,5)", formatBucketsCans(0, 5) === "5 gal", formatBucketsCans(0, 5));
  check("formatBucketsCans(0,0) = —", formatBucketsCans(0, 0) === "—");
}

console.log("\nisJobComplete — must not false-positive on 'Incomplete':");
{
  check("'Complete Paid in Full' = complete", isJobComplete("Complete Paid in Full") === true);
  check("'Paid in Full' = complete", isJobComplete("Paid in Full") === true);
  check("'Complete' = complete", isJobComplete("Complete") === true);
  // The bug we're fixing: includes('complete') matches 'incomplete' too.
  check("'Incomplete' is NOT complete", isJobComplete("Incomplete") === false);
  check("'incomplete' is NOT complete (lowercase)", isJobComplete("incomplete") === false);
  check("'Cancelled' is NOT complete", isJobComplete("Cancelled") === false);
  check("'Void' is NOT complete", isJobComplete("Void") === false);
  check("'Abandoned' is NOT complete", isJobComplete("Abandoned") === false);
  check("null is NOT complete", isJobComplete(null) === false);
  check("empty string is NOT complete", isJobComplete("") === false);
  check("'Open' is NOT complete", isJobComplete("Open") === false);
  check("'In Progress' is NOT complete", isJobComplete("In Progress") === false);
}

console.log("\nAudit-fix regressions:");
{
  // 1. classifySurface trims whitespace
  check("classifySurface(' Walls ') = walls", classifySurface(" Walls ") === "walls");
  check("classifySurface('Walls') = walls", classifySurface("Walls") === "walls");
  check("classifySurface('   Ceiling') = ceiling", classifySurface("   Ceiling") === "ceiling");

  // 2. Door/window/closet per-WO cap at 20 (a typo'd numDoors=50 must NOT
  //    contribute 50 × casing/face area into the gallon math).
  const rCapped = room({
    woliId: "cap1", floorAreaSqft: 144, perimeterLf: 48, heightFt: 8,
    doors: 50,         // typo — should be capped
    windows: 50,       // typo
    closets: 50,       // typo
    coats: 2, paintDoorFaces: true,
    surfaces: [surf("trim", "C1", "Trim")],
  });
  const rSane = room({
    woliId: "cap2", floorAreaSqft: 144, perimeterLf: 48, heightFt: 8,
    doors: 20, windows: 20, closets: 20, coats: 2, paintDoorFaces: true,
    surfaces: [surf("trim", "C2", "Trim")],
  });
  const capped = estimateOrderGallons([rCapped])[0];
  const sane = estimateOrderGallons([rSane])[0];
  check("door/window/closet capped at 20 — totalSqft matches sane 20s",
    capped.totalSqft === sane.totalSqft, `${capped.totalSqft} vs ${sane.totalSqft}`);
}

console.log("\nKatie's door-face rule (paintDoorFaces toggles room-facing door area):");
{
  // Same room with door=2: paintDoorFaces=true adds 2×20×coats=80 sqft to trim
  // vs paintDoorFaces=false (just casings). 80 sqft = 0.23 gal → can shift the
  // can count by 1, depending on rounding. The rule must be a real signal.
  const rWith = room({
    woliId: "wf", floorAreaSqft: 144, perimeterLf: 48, heightFt: 8,
    doors: 2, windows: 1, closets: 0, coats: 2, paintDoorFaces: true,
    surfaces: [surf("trim", "TR", "Trim")],
  });
  const rWithout = room({
    woliId: "wf", floorAreaSqft: 144, perimeterLf: 48, heightFt: 8,
    doors: 2, windows: 1, closets: 0, coats: 2, paintDoorFaces: false,
    surfaces: [surf("trim", "TR", "Trim")],
  });
  const withFaces = estimateOrderGallons([rWith])[0];
  const noFaces = estimateOrderGallons([rWithout])[0];
  check("paintDoorFaces=true adds 80 sqft (2 doors × 20 sqft × 2 coats)", withFaces.totalSqft - noFaces.totalSqft === 80, `${withFaces.totalSqft} vs ${noFaces.totalSqft}`);
  check("paintDoorFaces=true produces ≥ gallons of paintDoorFaces=false", withFaces.gallons >= noFaces.gallons);
}

console.log("\nConfig sanity caps (isValidCoverageValue upper bounds):");
{
  // Lower bound: STRICT_POSITIVE keys reject 0 and negatives.
  check("coverageSqftPerGallon rejects 0", isValidCoverageValue("coverageSqftPerGallon", 0) === false);
  check("coverageSqftPerGallon rejects -10", isValidCoverageValue("coverageSqftPerGallon", -10) === false);
  check("coverageSqftPerGallon accepts 375", isValidCoverageValue("coverageSqftPerGallon", 375) === true);
  // Other keys may be 0 (e.g., bufferPct=0 means "no buffer").
  check("bufferPct accepts 0", isValidCoverageValue("bufferPct", 0) === true);
  check("bufferPct accepts 0.10", isValidCoverageValue("bufferPct", 0.10) === true);
  check("bufferPct accepts 0.50", isValidCoverageValue("bufferPct", 0.50) === true);
  // Upper bound: typo of 1000 (meant 10) is rejected.
  check("bufferPct rejects 10.0 (1000% buffer typo)", isValidCoverageValue("bufferPct", 10) === false);
  check("bufferPct rejects 2.0 (above 100% cap)", isValidCoverageValue("bufferPct", 2.0) === false);
  check("bufferPct accepts 1.0 (exactly at cap)", isValidCoverageValue("bufferPct", 1.0) === true);
  check("defaultCoats rejects 50 (typo above cap)", isValidCoverageValue("defaultCoats", 50) === false);
  check("defaultCoats accepts 3", isValidCoverageValue("defaultCoats", 3) === true);
  check("NaN always rejected", isValidCoverageValue("bufferPct", NaN) === false);
  check("Infinity always rejected", isValidCoverageValue("bufferPct", Infinity) === false);
  // Spot-check every MAX is realistic (defaults must comfortably fit under).
  for (const k of Object.keys(MAX_COVERAGE_VALUES)) {
    const def = (COVERAGE_CONFIG as Record<string, number>)[k];
    check(`${k} default (${def}) fits under cap (${MAX_COVERAGE_VALUES[k]})`, def <= MAX_COVERAGE_VALUES[k]);
  }
}

console.log(`\nCONFIG: ${JSON.stringify(COVERAGE_CONFIG)}`);
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
