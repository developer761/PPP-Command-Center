/**
 * Room geometry for paint estimation.
 *
 * The estimator already accepts `floorAreaSqft`, `perimeterLf` and
 * `wallSurfaceAreaSqft`, and falls back to `4 × √(floor area)` for perimeter
 * when it has none — which silently assumes every room is SQUARE.
 *
 * That assumption is where a lot of accuracy is lost, and it costs nothing to
 * fix: if someone measures a room at all, they measured two numbers, not one.
 *
 *   12 × 12 room →  144 sqft, real perimeter 48 lf, square guess 48 lf   ✓
 *   24 ×  6 hall →  144 sqft, real perimeter 60 lf, square guess 48 lf   ✗ 25% low
 *
 * A hallway, a galley kitchen and a long living room are all badly served by
 * the square guess, and they're common. So every capture path here returns
 * length and width where it can, not just an area.
 */

/** PPP's defaults, matching the estimator's coverage config. */
export const DEFAULT_CEILING_FT = 8;
/** A standard door: 3'0" × 6'8". */
export const DOOR_SQFT = 20;
/** A common double-hung window, 3' × 5'. */
export const WINDOW_SQFT = 15;

export type RoomDimensions = {
  lengthFt: number;
  widthFt: number;
  ceilingFt: number;
};

export type RoomGeometry = {
  floorAreaSqft: number;
  perimeterLf: number;
  /** Gross wall area before openings — perimeter × height. */
  grossWallSqft: number;
  /** Wall area after deducting doors and windows. What actually gets painted. */
  paintableWallSqft: number;
};

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Derive everything the estimator wants from two tape measurements.
 *
 * Openings are deducted because a door is not a wall. The estimator applies its
 * own opening defaults when it has no counts, so callers that DO know the real
 * counts should pass them and stop it double-guessing.
 */
export function geometryFromDimensions(
  d: RoomDimensions,
  openings: { doors?: number; windows?: number } = {}
): RoomGeometry {
  const length = Math.max(0, d.lengthFt);
  const width = Math.max(0, d.widthFt);
  const height = d.ceilingFt > 0 ? d.ceilingFt : DEFAULT_CEILING_FT;

  const floorAreaSqft = round(length * width);
  const perimeterLf = round(2 * (length + width));
  const grossWallSqft = round(perimeterLf * height);

  const doors = Math.max(0, Math.floor(openings.doors ?? 0));
  const windows = Math.max(0, Math.floor(openings.windows ?? 0));
  const deduction = doors * DOOR_SQFT + windows * WINDOW_SQFT;

  // Never deduct below a floor — a data-entry slip claiming 12 doors in a
  // closet must not produce a negative or near-zero wall area and under-order
  // the paint. 40% of gross is the least a real room can plausibly paint.
  const paintableWallSqft = round(Math.max(grossWallSqft * 0.4, grossWallSqft - deduction));

  return { floorAreaSqft, perimeterLf, grossWallSqft, paintableWallSqft };
}

/**
 * How wrong the square assumption is for a given room — used to show the worker
 * why entering both numbers is worth the extra three seconds.
 */
export function perimeterGainVsSquareGuess(d: Pick<RoomDimensions, "lengthFt" | "widthFt">): {
  realLf: number;
  squareGuessLf: number;
  pctDifference: number;
} {
  const area = Math.max(0, d.lengthFt) * Math.max(0, d.widthFt);
  const realLf = round(2 * (d.lengthFt + d.widthFt));
  const squareGuessLf = round(area > 0 ? 4 * Math.sqrt(area) : 0);
  const pct = squareGuessLf > 0 ? round(((realLf - squareGuessLf) / squareGuessLf) * 100) : 0;
  return { realLf, squareGuessLf, pctDifference: pct };
}

/**
 * Split a whole-house square footage across the rooms on a work order.
 *
 * Property records give ONE number for the building — they never give room
 * dimensions. So this is deliberately a rough distribution, and everything
 * downstream must treat it as low confidence.
 *
 * Two adjustments make it less crude than dividing equally:
 *   · a chunk of any house is hallway, stairs and closets that aren't on the
 *     work order, so only a share of the total is distributable;
 *   · rooms are not equal — a master bedroom is not a bathroom — so known room
 *     types get a relative weight.
 */
const ROOM_WEIGHTS: Array<{ match: RegExp; weight: number }> = [
  { match: /\b(great|family|living|lounge)\b/i, weight: 1.8 },
  { match: /\b(master|primary)\b/i, weight: 1.5 },
  { match: /\b(kitchen|dining)\b/i, weight: 1.2 },
  { match: /\b(bed|bdrm|guest)\b/i, weight: 1.0 },
  { match: /\b(office|den|study|nursery)\b/i, weight: 0.9 },
  { match: /\b(laundry|mud|pantry|utility)\b/i, weight: 0.5 },
  { match: /\b(bath|powder|wc)\b/i, weight: 0.4 },
  { match: /\b(closet|hall|entry|foyer|stair)\b/i, weight: 0.35 },
];

/** Share of a home's stated square footage that lands in paintable rooms. */
export const DISTRIBUTABLE_SHARE = 0.8;

export function roomWeight(label: string): number {
  for (const { match, weight } of ROOM_WEIGHTS) if (match.test(label)) return weight;
  return 1.0; // unrecognised room — treat as an average bedroom
}

export function distributeHouseSqft(
  houseSqft: number,
  rooms: Array<{ id: string; label: string }>
): Record<string, number> {
  const out: Record<string, number> = {};
  if (houseSqft <= 0 || rooms.length === 0) return out;
  const weights = rooms.map((r) => roomWeight(r.label));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return out;
  const pool = houseSqft * DISTRIBUTABLE_SHARE;
  rooms.forEach((r, i) => {
    out[r.id] = Math.round((pool * weights[i]) / totalWeight);
  });
  return out;
}
