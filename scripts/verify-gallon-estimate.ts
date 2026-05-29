/**
 * Verification for the paint gallon estimation engine.
 *
 *   npx tsx scripts/verify-gallon-estimate.ts
 *
 * Pure unit checks (no SF/DB). Hand-computed expectations against
 * COVERAGE_CONFIG: 350 sqft/gal, wall ×3.0, 2 coats default, trim 2 rooms/gal.
 */
import {
  estimateOrderGallons,
  classifySurface,
  COVERAGE_CONFIG,
  type SurfacePick,
} from "../lib/supplier-order/estimate-gallons";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function pick(p: Partial<SurfacePick> & { surfaceLabel: string; colorId: string }): SurfacePick {
  return {
    woliId: p.woliId ?? "w1",
    roomLabel: p.roomLabel ?? "Room 1",
    surfaceLabel: p.surfaceLabel,
    colorId: p.colorId,
    colorName: p.colorName ?? p.colorId,
    colorCode: p.colorCode ?? null,
    finish: p.finish ?? null,
    floorAreaSqft: p.floorAreaSqft ?? 0,
    coats: p.coats ?? 0,
  };
}

console.log("classifySurface:");
check("Accent Wall → unsized (not wall)", classifySurface("Accent Wall").basis === "unsized");
check("Walls → area", classifySurface("Walls").basis === "area" && classifySurface("Walls").key === "wall");
check("Ceiling → area/ceiling", classifySurface("Ceiling").key === "ceiling");
check("Trim → trim-rooms", classifySurface("Trim").basis === "trim-rooms");
check("Door → trim-rooms", classifySurface("Door").basis === "trim-rooms");
check("Window → trim-rooms", classifySurface("Window").basis === "trim-rooms");
check("Floor → area/floor", classifySurface("Floor").key === "floor");
check("Cabinets → unsized", classifySurface("Cabinets").basis === "unsized");
check("Closet → unsized", classifySurface("Closet").basis === "unsized");

console.log("\nwalls, single room, floor=200, 2 coats:");
{
  // 200 × 3.0 × 2 = 1200 coated sqft; ceil(1200/350)=4
  const r = estimateOrderGallons([pick({ surfaceLabel: "Walls", colorId: "A", finish: "Eggshell", floorAreaSqft: 200, coats: 2 })]);
  check("one line", r.length === 1, `got ${r.length}`);
  check("gallons = 4", r[0]?.gallons === 4, `got ${r[0]?.gallons}`);
  check("not needsMeasurement", r[0]?.needsMeasurement === false);
}

console.log("\nceiling, floor=200, 1 coat → ceil(200/350)=1 (min 1):");
{
  const r = estimateOrderGallons([pick({ surfaceLabel: "Ceiling", colorId: "B", finish: "Flat", floorAreaSqft: 200, coats: 1 })]);
  check("gallons = 1", r[0]?.gallons === 1, `got ${r[0]?.gallons}`);
}

console.log("\ndefault coats applied when coats=0 → 200×3×2=1200 → 4:");
{
  const r = estimateOrderGallons([pick({ surfaceLabel: "Walls", colorId: "A", floorAreaSqft: 200, coats: 0 })]);
  check("uses defaultCoats(2) → gallons 4", r[0]?.gallons === 4, `got ${r[0]?.gallons}`);
}

console.log("\nsame color+finish walls across 2 rooms aggregates:");
{
  // 200×3×2 + 150×3×2 = 1200+900=2100 → ceil(2100/350)=6
  const r = estimateOrderGallons([
    pick({ woliId: "w1", roomLabel: "Room 1", surfaceLabel: "Walls", colorId: "A", finish: "Eggshell", floorAreaSqft: 200, coats: 2 }),
    pick({ woliId: "w2", roomLabel: "Room 2", surfaceLabel: "Walls", colorId: "A", finish: "Eggshell", floorAreaSqft: 150, coats: 2 }),
  ]);
  check("one aggregated line", r.length === 1, `got ${r.length}`);
  check("gallons = 6", r[0]?.gallons === 6, `got ${r[0]?.gallons}`);
  check("covers 2 rooms", r[0]?.rooms.length === 2);
}

console.log("\ntrim across 3 rooms → ceil(3/2)=2:");
{
  const r = estimateOrderGallons([
    pick({ woliId: "w1", surfaceLabel: "Trim", colorId: "C", finish: "Semi-Gloss", floorAreaSqft: 999 }),
    pick({ woliId: "w2", surfaceLabel: "Trim", colorId: "C", finish: "Semi-Gloss", floorAreaSqft: 999 }),
    pick({ woliId: "w3", surfaceLabel: "Trim", colorId: "C", finish: "Semi-Gloss", floorAreaSqft: 999 }),
  ]);
  check("trim line", r.length === 1 && r[0]?.basis === "trim-rooms");
  check("gallons = 2", r[0]?.gallons === 2, `got ${r[0]?.gallons}`);
  check("trim never needsMeasurement", r[0]?.needsMeasurement === false);
}

console.log("\nmissing sqft on an area surface → 0 gal + needsMeasurement:");
{
  const r = estimateOrderGallons([pick({ surfaceLabel: "Walls", colorId: "A", floorAreaSqft: 0, coats: 2 })]);
  check("gallons = 0", r[0]?.gallons === 0, `got ${r[0]?.gallons}`);
  check("needsMeasurement true", r[0]?.needsMeasurement === true);
}

console.log("\nunsized surface (Accent Wall) → 0 gal + needsMeasurement:");
{
  const r = estimateOrderGallons([pick({ surfaceLabel: "Accent Wall", colorId: "D", finish: "Eggshell", floorAreaSqft: 200 })]);
  check("basis unsized", r[0]?.basis === "unsized");
  check("gallons 0 + needsMeasurement", r[0]?.gallons === 0 && r[0]?.needsMeasurement === true);
}

console.log("\nsame color, different finish/basis (walls eggshell + trim semigloss) → 2 lines:");
{
  const r = estimateOrderGallons([
    pick({ woliId: "w1", surfaceLabel: "Walls", colorId: "A", finish: "Eggshell", floorAreaSqft: 200, coats: 2 }),
    pick({ woliId: "w1", surfaceLabel: "Trim", colorId: "A", finish: "Semi-Gloss", floorAreaSqft: 200, coats: 2 }),
  ]);
  check("two lines", r.length === 2, `got ${r.length}`);
}

console.log("\npartial-missing aggregate (one room measured, one not) undercounts + flags:");
{
  // measured: 200×3×2=1200 → ceil=4; the missing room is excluded but flagged
  const r = estimateOrderGallons([
    pick({ woliId: "w1", roomLabel: "R1", surfaceLabel: "Walls", colorId: "A", finish: "Eggshell", floorAreaSqft: 200, coats: 2 }),
    pick({ woliId: "w2", roomLabel: "R2", surfaceLabel: "Walls", colorId: "A", finish: "Eggshell", floorAreaSqft: 0, coats: 2 }),
  ]);
  check("gallons = 4 (measured only)", r[0]?.gallons === 4, `got ${r[0]?.gallons}`);
  check("needsMeasurement true (undercount)", r[0]?.needsMeasurement === true);
}

console.log(`\nCONFIG: ${JSON.stringify(COVERAGE_CONFIG)}`);
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
