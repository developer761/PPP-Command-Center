/**
 * Perspective correction — measure a wall accurately from a photo taken at an
 * angle.
 *
 * THE PROBLEM THIS SOLVES. Scaling by a pixel ratio (see photo-scale.ts) only
 * holds when the reference and the target sit in a plane parallel to the
 * camera. Shoot a wall from the corner of the room and its far end is further
 * from the lens, so its pixels are smaller and every measurement along it comes
 * out short. That is the single largest error source in photo measurement, and
 * telling someone "stand square to the wall" does not survive a real job site
 * where furniture is in the way.
 *
 * THE FIX. A photograph of a plane is a projective transform of that plane. If
 * you know the true shape of ONE rectangle in it — and a door is a rectangle
 * whose size building code fixes — you can recover the whole transform and undo
 * it. After that, any two points on that wall measure correctly no matter where
 * the camera stood.
 *
 * Tap the four corners of a door, and the wall it sits in becomes measurable.
 *
 * Implemented as the standard Direct Linear Transform: each corner gives two
 * equations, four corners give eight, and the homography has eight unknowns
 * (the ninth is fixed by scale). No dependencies — it is one 8×8 solve.
 */

export type Pt = { x: number; y: number };

/** Row-major 3×3, with h[8] normalised to 1. */
export type Homography = number[];

/**
 * Solve the 8×8 system by Gaussian elimination with partial pivoting.
 *
 * Pivoting matters here rather than being textbook hygiene: the four taps are
 * often close to degenerate (a nearly edge-on door), which puts very small
 * numbers on the diagonal, and without pivoting the result quietly becomes
 * noise instead of failing.
 */
function solve8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-10) return null; // singular — degenerate taps
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = M[i][n] / M[i][i];
    if (!Number.isFinite(out[i])) return null;
  }
  return out;
}

/**
 * Recover the transform mapping image pixels to real-world inches on a plane.
 *
 * `imageCorners` and `worldCorners` must be given in the SAME order around the
 * shape — both clockwise or both anticlockwise. Crossing them produces a
 * mathematically valid homography that mirrors the plane, and every measurement
 * then comes out plausible and wrong, which is worse than an error.
 */
export function solveHomography(imageCorners: Pt[], worldCorners: Pt[]): Homography | null {
  if (imageCorners.length !== 4 || worldCorners.length !== 4) return null;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = imageCorners[i];
    const { x: X, y: Y } = worldCorners[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = solve8(A, b);
  return h ? [...h, 1] : null;
}

/** Map an image point onto the real-world plane, in inches. */
export function applyHomography(H: Homography, p: Pt): Pt | null {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  // A point on (or behind) the horizon has no finite position on the plane.
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null;
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/** Real distance in inches between two tapped points on the mapped plane. */
export function measureOnPlane(H: Homography, a: Pt, b: Pt): number | null {
  const A = applyHomography(H, a);
  const B = applyHomography(H, b);
  if (!A || !B) return null;
  const d = Math.hypot(B.x - A.x, B.y - A.y);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** A known rectangle to calibrate against, in inches. */
export type CalibrationRect = { id: string; label: string; widthIn: number; heightIn: number; hint: string };

export const CALIBRATION_RECTS: CalibrationRect[] = [
  { id: "door_32", label: "Interior door (32″ × 80″)", widthIn: 32, heightIn: 80, hint: "Tap the four corners of the door frame, going round in order." },
  { id: "door_30", label: "Narrow door (30″ × 80″)", widthIn: 30, heightIn: 80, hint: "Older or closet doors are often 30″ wide." },
  { id: "door_36", label: "Wide door (36″ × 80″)", widthIn: 36, heightIn: 80, hint: "Front doors and accessible doors are usually 36″." },
  { id: "paper", label: "Sheet of paper (8.5″ × 11″)", widthIn: 8.5, heightIn: 11, hint: "Tape a letter sheet flat to the wall — the most reliable option." },
  { id: "custom", label: "Something else rectangular", widthIn: 0, heightIn: 0, hint: "Any rectangle you can measure — a window, a cabinet door, a tile." },
];

/**
 * Corners in the order the UI collects them: top-left, top-right,
 * bottom-right, bottom-left — clockwise, matching how a person naturally taps
 * round a doorway.
 */
export function rectWorldCorners(widthIn: number, heightIn: number): Pt[] {
  return [
    { x: 0, y: 0 },
    { x: widthIn, y: 0 },
    { x: widthIn, y: heightIn },
    { x: 0, y: heightIn },
  ];
}

/**
 * Sanity-check the calibration by measuring the rectangle against itself.
 *
 * The homography is fitted to those four corners, so it reproduces them almost
 * exactly — a large residual means the taps were not actually a rectangle's
 * corners (a wonky tap, or corners entered out of order), which is the one
 * mistake that silently ruins every later measurement.
 */
export function calibrationResidual(
  H: Homography,
  imageCorners: Pt[],
  widthIn: number,
  heightIn: number
): number {
  const world = rectWorldCorners(widthIn, heightIn);
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const got = applyHomography(H, imageCorners[i]);
    if (!got) return Infinity;
    worst = Math.max(worst, Math.hypot(got.x - world[i].x, got.y - world[i].y));
  }
  return worst;
}
