/**
 * The room's dimensions, for the people reading the order screen.
 *
 * Jason + Alex, 2026-09-17: "Put the room dimensions instead of the
 * calculation surface area coverage (that can be on the backend for us)."
 *
 * Salesforce does not hold length and width — it holds `Sq_Footage__c` (floor
 * area) and `Perimeter__c`. For a rectangular room those two ARE the
 * dimensions, and the arithmetic is exact:
 *
 *     w + l = P / 2        w · l = A
 *     → w, l are the roots of  x² − (P/2)x + A = 0
 *
 * A room that is not a rectangle has no such pair, and the discriminant says
 * so rather than the code inventing one. When that happens the caller keeps
 * showing what it showed before — an estimate dressed as a measurement is
 * worse than an honest area.
 */

export type RoomDimensions = {
  /** The shorter side, feet. */
  widthFt: number;
  /** The longer side, feet. */
  lengthFt: number;
};

/** Round to a half foot: PPP measures in feet and inches, and "12.03 × 14.97"
 *  reads as false precision on a number derived from two rounded inputs. */
function toHalfFoot(n: number): number {
  return Math.round(n * 2) / 2;
}

/**
 * Length and width from floor area + perimeter, or null when the two cannot
 * describe one rectangle.
 */
export function deriveRoomDimensions(
  floorSqft: number | null | undefined,
  perimeterLf: number | null | undefined
): RoomDimensions | null {
  const area = Number(floorSqft);
  const perim = Number(perimeterLf);
  if (!Number.isFinite(area) || !Number.isFinite(perim)) return null;
  if (area <= 0 || perim <= 0) return null;

  const half = perim / 2;
  const disc = half * half - 4 * area;
  // Negative: no rectangle has this area and this perimeter — an L-shaped room,
  // a bay window, or one of the two numbers is simply wrong. Say nothing.
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  const a = (half + root) / 2;
  const b = (half - root) / 2;
  if (!(a > 0) || !(b > 0)) return null;

  const lengthFt = toHalfFoot(Math.max(a, b));
  const widthFt = toHalfFoot(Math.min(a, b));
  // Rounding can flatten a sliver room to a zero side.
  if (widthFt <= 0 || lengthFt <= 0) return null;
  return { widthFt, lengthFt };
}

/** "12 × 15 ft", or "12 × 15 × 8 ft" with a ceiling height. Null when the
 *  dimensions cannot be derived, so the caller can fall back to the area. */
export function formatRoomDimensions(
  floorSqft: number | null | undefined,
  perimeterLf: number | null | undefined,
  heightFt?: number | null
): string | null {
  const d = deriveRoomDimensions(floorSqft, perimeterLf);
  if (!d) return null;
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const h = Number(heightFt);
  const base = `${n(d.widthFt)} × ${n(d.lengthFt)}`;
  return Number.isFinite(h) && h > 0 ? `${base} × ${n(toHalfFoot(h))} ft` : `${base} ft`;
}
