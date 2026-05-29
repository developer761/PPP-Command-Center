/**
 * Paint gallon estimation engine (PaintScout-style takeoff, adapted to PPP's data).
 *
 * Salesforce gives us ONE measurement per work-order line item: Sq_Footage__c,
 * which Katie confirmed is length × width = FLOOR AREA (≈ ceiling area too).
 * It does NOT capture wall height or paintable wall area, and it's estimator-
 * entered with no enforcement — so ~15% of lines have no number at all.
 *
 * From that single number we derive per-surface paint need:
 *   - Ceiling / Floor : area = floor area  (Sq_Footage__c directly)
 *   - Walls           : area = floor area × WALL_AREA_MULTIPLIER
 *                       (Katie's ((2L+2W)×H) ≈ 2.5–3× floor for normal ceilings;
 *                        we use the conservative 3.0 so crews don't run short)
 *   - Trim            : Katie's field rule — 1 gallon per 2–3 same-color rooms;
 *                       we use the conservative 2 rooms/gallon (room-count, not
 *                       area, since Perimeter__c is never populated)
 *   - Everything else (Accent Wall, Cabinets, Closet, Shelves, "Other"): we
 *     CAN'T size it from one floor number, so we surface the color but mark the
 *     quantity "needs review" instead of guessing wildly.
 *
 * Output is a per-(color + finish) rollup — the clean shopping list a vendor
 * order actually wants ("4 gal Stardust Eggshell"), aggregated across every
 * room, rounded UP to whole gallons (vendors don't sell fractions), min 1.
 *
 * Pure + deterministic on purpose: no I/O, no SF, no Supabase — so it's trivial
 * to verify (scripts/verify-gallon-estimate.ts) and safe to reuse anywhere.
 */

export const COVERAGE_CONFIG = {
  /** Conservative coverage. BM Regal really covers ~400 sqft/gal; 350 pads. */
  sqftPerGallon: 350,
  /** floor area → paintable wall area. Katie: 2.5–3; conservative end = 3.0. */
  wallAreaMultiplier: 3.0,
  /** Default when WOLI.of_Coats__c is missing/0. */
  defaultCoats: 2,
  /** Katie: 1 trim gallon per 2–3 same-color rooms. Conservative = 2. */
  trimRoomsPerGallon: 2,
} as const;

export type CoverageConfig = typeof COVERAGE_CONFIG;

/** How a surface is sized for paint. */
export type SurfaceBasis = "area" | "trim-rooms" | "unsized";

/** One painted surface on one room (line item), fed into the estimator. */
export type SurfacePick = {
  woliId: string;
  roomLabel: string;
  /** Raw Surfaces__c label, e.g. "Walls" / "Ceiling" / "Trim" / "Accent Wall". */
  surfaceLabel: string;
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
  /** WOLI.Sq_Footage__c (floor area). 0 / negative = not measured. */
  floorAreaSqft: number;
  /** WOLI.of_Coats__c, already defaulted by the caller (or 0 → defaultCoats). */
  coats: number;
};

/** One aggregated line on the order — a color+finish to buy, with a quantity. */
export type GallonEstimate = {
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
  basis: SurfaceBasis;
  /** Whole gallons to order (rounded up, min 1 when sized). 0 when unsized. */
  gallons: number;
  /** Distinct surface labels this color covers, e.g. ["Walls", "Ceiling"]. */
  surfaces: string[];
  /** Distinct room labels this color appears in. */
  rooms: string[];
  /** True when a contributing line had no Sq_Footage__c — the gallon figure is
   *  an UNDER-count (some rooms uncounted) and the worker must measure/confirm. */
  needsMeasurement: boolean;
};

/**
 * Classify a Surfaces__c label into how we size its paint.
 * Order matters: "Accent Wall" must hit "accent" before "wall"; doors/windows
 * are trim (Katie: trim includes door + window frames).
 */
export function classifySurface(label: string): { basis: SurfaceBasis; key: string } {
  const s = label.toLowerCase();
  if (s.includes("accent")) return { basis: "unsized", key: "accent" };
  if (s.includes("cabinet")) return { basis: "unsized", key: "cabinets" };
  if (s.includes("closet")) return { basis: "unsized", key: "closet" };
  if (s.includes("shelf") || s.includes("shelves")) return { basis: "unsized", key: "shelves" };
  if (s.includes("ceil")) return { basis: "area", key: "ceiling" };
  if (s.includes("trim") || s.includes("door") || s.includes("window")) return { basis: "trim-rooms", key: "trim" };
  if (s.includes("floor")) return { basis: "area", key: "floor" };
  if (s.includes("wall")) return { basis: "area", key: "wall" };
  return { basis: "unsized", key: "other" };
}

/** Coated square footage a single area-surface contributes (area × coats). */
function coatedAreaFor(key: string, floorAreaSqft: number, coats: number, cfg: CoverageConfig): number {
  if (floorAreaSqft <= 0) return 0;
  const baseArea = key === "wall" ? floorAreaSqft * cfg.wallAreaMultiplier : floorAreaSqft; // ceiling/floor = floor area
  return baseArea * coats;
}

type Bucket = {
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
  basis: SurfaceBasis;
  surfaces: Set<string>;
  rooms: Set<string>;
  coatedArea: number;       // for "area"
  trimRoomIds: Set<string>; // for "trim-rooms" (distinct WOLI = room)
  anyMissingSqft: boolean;
};

/**
 * Aggregate surface picks into a per-(color + finish + basis) gallon shopping
 * list. A color used on both walls (area) and trim (room-count) yields two
 * lines — different sizing methods, and in practice different finishes anyway.
 */
export function estimateOrderGallons(
  picks: SurfacePick[],
  cfg: CoverageConfig = COVERAGE_CONFIG
): GallonEstimate[] {
  const buckets = new Map<string, Bucket>();

  for (const p of picks) {
    if (!p.colorId) continue;
    const { basis, key } = classifySurface(p.surfaceLabel);
    const finishKey = p.finish ?? "";
    const bucketKey = `${p.colorId}::${finishKey}::${basis}`;
    let b = buckets.get(bucketKey);
    if (!b) {
      b = {
        colorId: p.colorId,
        colorName: p.colorName,
        colorCode: p.colorCode,
        finish: p.finish,
        basis,
        surfaces: new Set(),
        rooms: new Set(),
        coatedArea: 0,
        trimRoomIds: new Set(),
        anyMissingSqft: false,
      };
      buckets.set(bucketKey, b);
    }
    b.surfaces.add(p.surfaceLabel);
    if (p.roomLabel) b.rooms.add(p.roomLabel);
    const coats = p.coats > 0 ? p.coats : cfg.defaultCoats;

    if (basis === "area") {
      if (p.floorAreaSqft > 0) b.coatedArea += coatedAreaFor(key, p.floorAreaSqft, coats, cfg);
      else b.anyMissingSqft = true;
    } else if (basis === "trim-rooms") {
      b.trimRoomIds.add(p.woliId);
      // trim is room-count based; no sqft needed, so never "needs measurement"
    }
    // "unsized" → we list the color but can't compute gallons
  }

  const out: GallonEstimate[] = [];
  for (const b of buckets.values()) {
    let gallons = 0;
    let needsMeasurement = false;

    if (b.basis === "area") {
      gallons = b.coatedArea > 0 ? Math.max(1, Math.ceil(b.coatedArea / cfg.sqftPerGallon)) : 0;
      // Undercount if SOME rooms had sqft and some didn't, OR all were missing.
      needsMeasurement = b.anyMissingSqft;
    } else if (b.basis === "trim-rooms") {
      const rooms = b.trimRoomIds.size;
      gallons = rooms > 0 ? Math.max(1, Math.ceil(rooms / cfg.trimRoomsPerGallon)) : 0;
    } else {
      // unsized — can't size from a floor number; show the color, flag review.
      gallons = 0;
      needsMeasurement = true;
    }

    out.push({
      colorId: b.colorId,
      colorName: b.colorName,
      colorCode: b.colorCode,
      finish: b.finish,
      basis: b.basis,
      gallons,
      surfaces: Array.from(b.surfaces),
      rooms: Array.from(b.rooms),
      needsMeasurement,
    });
  }

  // Sort: biggest orders first (area > trim > unsized), then by gallons desc,
  // then color name — a readable shopping list.
  const basisRank: Record<SurfaceBasis, number> = { area: 0, "trim-rooms": 1, unsized: 2 };
  out.sort((a, z) =>
    basisRank[a.basis] - basisRank[z.basis] ||
    z.gallons - a.gallons ||
    a.colorName.localeCompare(z.colorName)
  );
  return out;
}
