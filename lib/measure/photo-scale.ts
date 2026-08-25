/**
 * Measure real distances by tapping points on a photo.
 *
 * WHY NOT ARKIT: Apple's Measure app uses ARKit + LiDAR, which is native iOS
 * only and, for the LiDAR accuracy people associate with it, Pro devices only.
 * Safari does not expose ARKit or WebXR AR to web pages, so a browser cannot
 * reach it at all. Building that means a native app — Apple Developer account,
 * native codebase, TestFlight — and it still leaves the crews on non-Pro phones
 * without the good version.
 *
 * WHAT THIS DOES INSTEAD: a photo already contains a ruler if it contains
 * anything of known size. Tap the two ends of a door frame (80 inches by code),
 * then tap the two ends of the wall you want. The ratio of those pixel lengths
 * is the ratio of the real lengths.
 *
 *     real = knownLength × (targetPixels ÷ referencePixels)
 *
 * That works in any browser, on any phone, today, and needs no permissions
 * beyond the camera roll.
 *
 * WHERE IT IS WRONG, because a measuring tool that hides its error is worse
 * than none: the ratio only holds when the reference and the target lie in the
 * same plane and that plane is parallel to the camera. Photograph a wall
 * straight on and it is good to a few percent. Shoot from the corner of the
 * room and the far end of the wall is further from the lens than the near end,
 * so its pixels are smaller and the answer comes out short. `estimateError`
 * below reports that honestly rather than quietly returning a number.
 */

export type Point = { x: number; y: number };

/** Objects a painter can find in almost any room, with their real size. */
export type ScaleReference = {
  id: string;
  label: string;
  /** Real length in inches. */
  inches: number;
  /** How to line the two taps up. */
  hint: string;
};

export const SCALE_REFERENCES: ScaleReference[] = [
  { id: "door_height", label: "Door — top to bottom", inches: 80, hint: "Standard interior door is 6'8\". Tap the top of the frame, then the floor." },
  { id: "door_width", label: "Door — side to side", inches: 32, hint: "Most interior doors are 30–36\". Use 32\" unless you know otherwise." },
  { id: "outlet_height", label: "Outlet — floor to centre", inches: 15, hint: "Outlets sit 12–18\" up; 15\" is the usual." },
  { id: "switch_height", label: "Light switch — floor to centre", inches: 48, hint: "Switches are 48\" up by code." },
  { id: "letter_paper", label: "Sheet of paper (long edge)", inches: 11, hint: "Hold a letter sheet flat against the wall — the most accurate option here." },
  { id: "tape_marker", label: "Tape measure — pulled to a mark", inches: 0, hint: "Pull a tape out to a round number, lay it against the wall, and enter that number." },
  { id: "custom", label: "Something else I know", inches: 0, hint: "Anything you can measure — a countertop, a tile, your own height." },
];

export type ScaledMeasurement = {
  /** Real length in inches. */
  inches: number;
  feet: number;
  /** "8′ 4″" — how a painter actually says it. */
  display: string;
  /** Pixel lengths, kept so the UI can explain the arithmetic. */
  referencePx: number;
  targetPx: number;
};

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

export function formatFeetInches(totalInches: number): string {
  if (!Number.isFinite(totalInches) || totalInches <= 0) return "—";
  const ft = Math.floor(totalInches / 12);
  const inch = Math.round(totalInches - ft * 12);
  // 11.6" rounds to 12" — carry it rather than printing 8′ 12″.
  if (inch === 12) return `${ft + 1}′`;
  if (ft === 0) return `${inch}″`;
  return inch === 0 ? `${ft}′` : `${ft}′ ${inch}″`;
}

/**
 * Scale a tapped distance against a tapped reference.
 *
 * Returns null rather than a number when the reference is too short to trust:
 * a 6-pixel reference makes every rounding error in the tap position enormous,
 * and the result would look authoritative while being nonsense.
 */
export const MIN_REFERENCE_PX = 40;

export function scaleFromReference(input: {
  referenceA: Point;
  referenceB: Point;
  referenceInches: number;
  targetA: Point;
  targetB: Point;
}): ScaledMeasurement | null {
  const referencePx = dist(input.referenceA, input.referenceB);
  const targetPx = dist(input.targetA, input.targetB);
  if (referencePx < MIN_REFERENCE_PX) return null;
  if (input.referenceInches <= 0 || targetPx <= 0) return null;

  const inches = input.referenceInches * (targetPx / referencePx);
  if (!Number.isFinite(inches) || inches <= 0) return null;

  return {
    inches,
    feet: inches / 12,
    display: formatFeetInches(inches),
    referencePx: Math.round(referencePx),
    targetPx: Math.round(targetPx),
  };
}

/**
 * How much to trust a scaled measurement, from what the taps themselves reveal.
 *
 * Two things are checkable without knowing anything about the scene:
 *
 *   · A short reference amplifies tap error. Two taps are each worth a few
 *     pixels of slop; against a 60px reference that is ~5%, against a 400px
 *     reference it is under 1%.
 *   · A reference and a target running in very different directions are
 *     usually in different planes — a vertical door against a horizontal wall
 *     receding from the camera is the classic case, and it reads short.
 */
export function estimateError(input: {
  referenceA: Point;
  referenceB: Point;
  targetA: Point;
  targetB: Point;
}): { pct: number; confidence: "high" | "medium" | "low"; note: string | null } {
  const refPx = dist(input.referenceA, input.referenceB);
  const tgtPx = dist(input.targetA, input.targetB);

  // Assume ~3px of slop per tap, two taps per segment.
  const TAP_SLOP_PX = 6;
  const refPct = refPx > 0 ? (TAP_SLOP_PX / refPx) * 100 : 100;

  const angle = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);
  const deg = Math.abs(
    ((angle(input.referenceA, input.referenceB) - angle(input.targetA, input.targetB)) * 180) / Math.PI
  ) % 180;
  const misalignment = Math.min(deg, 180 - deg);

  let pct = refPct;
  let note: string | null = null;

  if (refPx < 80) {
    note = "The reference is small in the photo — get closer to it, or pick something longer.";
  }
  // Beyond ~40° apart, the two segments are very unlikely to share a plane.
  if (misalignment > 40) {
    pct += 8;
    note = "The reference and the wall run in different directions, so they're probably not in the same plane. Shoot straight at the wall for a better number.";
  }
  // A target far longer than its reference extrapolates the error with it.
  if (tgtPx > refPx * 8) {
    pct += 5;
    note = note ?? "You're measuring something much longer than the reference — the error grows with it.";
  }

  const confidence = pct <= 4 ? "high" : pct <= 10 ? "medium" : "low";
  return { pct: Math.round(pct * 10) / 10, confidence, note };
}
