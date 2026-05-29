/**
 * Paint gallons calculator — implements PPP's estimating spec.
 *
 * Source of truth: ppp-salesforce-reference/estimating/paint-gallons-calculator.md
 * (Katie, spec locked 2026-05-29). This file mirrors that spec exactly. If the
 * two ever disagree, the reference doc wins — update here to match.
 *
 * THE DATA GAP we bridge: Katie's per-room formulas need width W, length L,
 * height H and door/window/closet counts. Salesforce only reliably stores
 * Sq_Footage__c (= W × L = floor area); perimeter, height and opening counts are
 * fields that exist but are almost never populated. So, per Katie's "inputs used
 * when available, otherwise sensible defaults":
 *   - perimeter: WOLI.Perimeter__c when present, else 4 × √(floor area) (assumes
 *     a square room — exact for square rooms, slightly low for long ones).
 *   - height:    WOLI height when present, else DEFAULT_HEIGHT_FT.
 *   - openings:  WOLI Doors/Windows/Closets when present, else the defaults
 *     (1 door + 1 window per room, 0 closets).
 *
 * Output: a suggested ORDER per color+finish for the whole job — rolled up
 * across rooms, ÷ coverage, + buffer, then packaged into 5-gal buckets + 1-gal
 * cans. A defensible default a PM can trust and adjust; NOT a precise takeoff.
 *
 * Pure + deterministic: no I/O. Verify with scripts/verify-gallon-estimate.ts.
 */

/** All tunable constants in one place (Katie: "treat as named config, not
 *  magic numbers — PPP will tune per product / per SW vs BM"). */
export const COVERAGE_CONFIG = {
  defaultCoats: 2,
  coverageSqftPerGallon: 375,
  bufferPct: 0.10,
  defaultHeightFt: 8,
  // Default openings when a room's counts aren't captured.
  defaultDoorsPerRoom: 1,
  defaultWindowsPerRoom: 1,
  defaultClosetsPerRoom: 0,
  // Wall-area deductions per opening (sq ft).
  deductDoorSqft: 20,
  deductWindowSqft: 15,
  deductClosetSqft: 30,
  // Trim casing additions per opening (linear ft).
  casingDoorLf: 17,
  casingWindowLf: 15,
  casingClosetLf: 18,
  // Trim width: linear ft → paintable sq ft.
  trimWidthFt: 0.25,
  // Door FACE area (single-sided), added to trim only when door faces are in scope.
  doorFaceSqft: 20,
  // Packaging: individual cans up to this many gallons; switch to buckets above it.
  bucketThresholdGallons: 4,
  bucketSizeGallons: 5,
} as const;

export type CoverageConfig = typeof COVERAGE_CONFIG;

/** Which of Katie's three buckets (+ floor / unsized) a surface maps to. */
export type PaintSurfaceKind = "ceiling" | "walls" | "trim" | "floor" | "unsized";

/** One painted surface within a room. */
export type RoomSurface = {
  kind: PaintSurfaceKind;
  surfaceLabel: string; // original Surfaces__c label, for display
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
};

/** One room (work-order line item) + its geometry + painted surfaces. */
export type RoomTakeoff = {
  woliId: string;
  roomLabel: string;
  /** WOLI.Sq_Footage__c (floor area W×L). 0 / missing → "needs measurement". */
  floorAreaSqft: number;
  /** WOLI.Wall_Surface_Area__c — the MEASURED paintable wall area. When > 0 we
   *  trust it directly (most accurate) and skip the perimeter×height estimate +
   *  opening deductions (the measurement already reflects them). 0 → derive. */
  wallSurfaceAreaSqft: number;
  /** WOLI.Perimeter__c. 0 / missing → derived as 4×√(floor area). */
  perimeterLf: number;
  /** Room height. 0 / missing → DEFAULT_HEIGHT_FT. */
  heightFt: number;
  /** Raw opening counts (0 → Katie's per-room defaults). */
  doors: number;
  windows: number;
  closets: number;
  /** WOLI.of_Coats__c (0 → defaultCoats). */
  coats: number;
  /** Door faces in scope for this room? (default off — casings always count). */
  paintDoorFaces: boolean;
  surfaces: RoomSurface[];
};

/** Suggested order for one color+finish across the whole job. */
export type GallonEstimate = {
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
  surfaces: string[];
  rooms: string[];
  /** 2-coat, post-deduction coverage area summed across rooms (pre-buffer). */
  totalSqft: number;
  /** 5-gallon buckets to order. */
  buckets: number;
  /** Leftover 1-gallon cans to order. */
  cans: number;
  /** Total gallon-equivalent (buckets×5 + cans) — for sorting / sanity. */
  gallons: number;
  /** A contributing room had no floor area → this is an UNDER-count. */
  needsMeasurement: boolean;
  /** Surface we can't size from the data (accent wall, cabinets, …). */
  unsized: boolean;
};

/** Map a Surfaces__c label to a paint bucket. Order matters: "Accent Wall"
 *  must be caught before "wall"; doors/windows are trim (casings/faces). */
export function classifySurface(label: string): PaintSurfaceKind {
  const s = label.toLowerCase();
  if (s.includes("accent")) return "unsized";
  if (s.includes("cabinet") || s.includes("closet") || s.includes("shelf") || s.includes("shelves")) return "unsized";
  if (s.includes("ceil")) return "ceiling";
  if (s.includes("trim") || s.includes("door") || s.includes("window")) return "trim";
  if (s.includes("floor")) return "floor";
  if (s.includes("wall")) return "walls";
  return "unsized";
}

type RoomCoverage = {
  ceiling: number; walls: number; trim: number; floor: number;
  // Per-bucket: was this surface's area derived without the data it needed
  // (so the figure is an under-count the worker should verify)?
  ceilingMissing: boolean; wallsMissing: boolean; trimMissing: boolean; floorMissing: boolean;
};

/** Per-room coverage sq ft for each bucket (2-coat, post-deduction). */
function roomCoverage(room: RoomTakeoff, cfg: CoverageConfig): RoomCoverage {
  const floor = room.floorAreaSqft > 0 ? room.floorAreaSqft : 0;
  const noFloor = floor <= 0;
  const coats = room.coats > 0 ? room.coats : cfg.defaultCoats;
  const height = room.heightFt > 0 ? room.heightFt : cfg.defaultHeightFt;
  const haveRealPerimeter = room.perimeterLf > 0;
  const perimeter = haveRealPerimeter
    ? room.perimeterLf
    : (floor > 0 ? 4 * Math.sqrt(floor) : 0); // assume square when no perimeter
  const doors = room.doors > 0 ? room.doors : cfg.defaultDoorsPerRoom;
  const windows = room.windows > 0 ? room.windows : cfg.defaultWindowsPerRoom;
  const closets = room.closets > 0 ? room.closets : cfg.defaultClosetsPerRoom;

  const ceilingSqft = floor * coats;
  const floorSqft = floor * coats;

  // Prefer the MEASURED paintable wall area when present (most accurate — it
  // already reflects this room's real walls + openings). Otherwise estimate
  // from perimeter × height minus standard opening deductions.
  const haveMeasuredWall = room.wallSurfaceAreaSqft > 0;
  let wallSqft: number;
  if (haveMeasuredWall) {
    wallSqft = room.wallSurfaceAreaSqft * coats;
  } else {
    const grossWall = perimeter * height;
    const wallDeduct = doors * cfg.deductDoorSqft + windows * cfg.deductWindowSqft + closets * cfg.deductClosetSqft;
    wallSqft = Math.max(0, grossWall - wallDeduct) * coats;
  }

  const trimLf = perimeter + doors * cfg.casingDoorLf + windows * cfg.casingWindowLf + closets * cfg.casingClosetLf;
  const trimSqft = trimLf * cfg.trimWidthFt * coats
    + (room.paintDoorFaces ? doors * cfg.doorFaceSqft * coats : 0);

  return {
    ceiling: ceilingSqft, walls: wallSqft, trim: trimSqft, floor: floorSqft,
    ceilingMissing: noFloor,
    floorMissing: noFloor,
    // walls fine if measured directly OR derivable from floor; missing only if neither.
    wallsMissing: !haveMeasuredWall && noFloor,
    // trim needs a perimeter; if neither a real perimeter nor a floor to derive
    // one, it's only the default casings — flag it.
    trimMissing: !haveRealPerimeter && noFloor,
  };
}

/** Package raw gallons into 5-gal buckets + 1-gal cans (Katie's rule). */
export function packageGallons(rawGallons: number, cfg: CoverageConfig = COVERAGE_CONFIG): { buckets: number; cans: number } {
  let g = rawGallons;
  let buckets = 0;
  while (g > cfg.bucketThresholdGallons) {
    buckets += 1;
    g -= cfg.bucketSizeGallons;
  }
  const cans = Math.ceil(Math.max(g, 0));
  return { buckets, cans };
}

type Bucket = {
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
  surfaces: Set<string>;
  rooms: Set<string>;
  totalSqft: number;
  anyMissingFloor: boolean;
  unsized: boolean;
};

/**
 * Roll a job's rooms into a suggested order per color+finish.
 * Per Katie: combine each color's coverage sq ft across ALL rooms, THEN
 * ÷ coverage, × (1 + buffer), then package — once, at the job level.
 */
export function estimateOrderGallons(
  rooms: RoomTakeoff[],
  cfg: CoverageConfig = COVERAGE_CONFIG
): GallonEstimate[] {
  const buckets = new Map<string, Bucket>();

  const bucketFor = (s: RoomSurface): Bucket => {
    const key = `${s.colorId}::${s.finish ?? ""}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        colorId: s.colorId, colorName: s.colorName, colorCode: s.colorCode, finish: s.finish,
        surfaces: new Set(), rooms: new Set(), totalSqft: 0, anyMissingFloor: false, unsized: false,
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const room of rooms) {
    const cov = roomCoverage(room, cfg);
    for (const s of room.surfaces) {
      if (!s.colorId) continue;
      const b = bucketFor(s);
      b.surfaces.add(s.surfaceLabel);
      if (room.roomLabel) b.rooms.add(room.roomLabel);
      let sqft = 0;
      let missing = false;
      switch (s.kind) {
        case "ceiling": sqft = cov.ceiling; missing = cov.ceilingMissing; break;
        case "walls":   sqft = cov.walls;   missing = cov.wallsMissing;   break;
        case "trim":    sqft = cov.trim;    missing = cov.trimMissing;    break;
        case "floor":   sqft = cov.floor;   missing = cov.floorMissing;   break;
        case "unsized": b.unsized = true;   break; // can't size — flag, no sqft
      }
      if (s.kind !== "unsized") {
        b.totalSqft += sqft;
        if (missing) b.anyMissingFloor = true;
      }
    }
  }

  const out: GallonEstimate[] = [];
  for (const b of buckets.values()) {
    // A bucket is "unsized" only if it had NO sizable coverage at all (every
    // surface was an unsizable one). If it also has real coverage, size it.
    const sizable = b.totalSqft > 0;
    let bucketsCount = 0;
    let cans = 0;
    if (sizable) {
      const rawGallons = (b.totalSqft / cfg.coverageSqftPerGallon) * (1 + cfg.bufferPct);
      ({ buckets: bucketsCount, cans } = packageGallons(rawGallons, cfg));
    }
    out.push({
      colorId: b.colorId,
      colorName: b.colorName,
      colorCode: b.colorCode,
      finish: b.finish,
      surfaces: Array.from(b.surfaces),
      rooms: Array.from(b.rooms),
      totalSqft: Math.round(b.totalSqft),
      buckets: bucketsCount,
      cans,
      gallons: bucketsCount * cfg.bucketSizeGallons + cans,
      needsMeasurement: sizable ? b.anyMissingFloor : true,
      unsized: !sizable && b.unsized,
    });
  }

  // Biggest orders first, sized before unsized, then color name.
  out.sort((a, z) =>
    (a.unsized ? 1 : 0) - (z.unsized ? 1 : 0) ||
    z.gallons - a.gallons ||
    a.colorName.localeCompare(z.colorName)
  );
  return out;
}

/** Human-readable order, e.g. "1 bucket + 2 gal", "3 gal", "needs measurement". */
export function formatOrderQuantity(e: GallonEstimate): string {
  if (e.unsized) return "needs review";
  if (e.buckets === 0 && e.cans === 0) return e.needsMeasurement ? "needs measurement" : "—";
  const parts: string[] = [];
  if (e.buckets > 0) parts.push(`${e.buckets} bucket${e.buckets === 1 ? "" : "s"} (×5 gal)`);
  if (e.cans > 0) parts.push(`${e.cans} gal`);
  return parts.join(" + ");
}
