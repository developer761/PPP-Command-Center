/**
 * Measuring on iPhone without any position tracking at all.
 *
 * THE IDEA. Safari gives no WebXR and no ARKit, so the device's position in the
 * room is unavailable — and recovering it by integrating the accelerometer
 * drifts by inches within seconds. But ATTITUDE is a different matter: pitch and
 * roll are referenced to gravity, so they are absolute and never accumulate
 * error, and Safari reports them through `deviceorientation`.
 *
 * So use only what does not drift. Hold the phone at a known height, aim the
 * centre crosshair at the point where a wall meets the floor, and the camera's
 * forward ray hits the floor plane at a distance fixed by simple trigonometry:
 *
 *     d = h / tan(depression)
 *
 * Aim at one corner, then the other, and the distance between those two floor
 * points is the wall's length. Nothing is integrated, nothing accumulates, and
 * the phone never has to move.
 *
 * WHY THE CENTRE OF THE SCREEN MATTERS. Aiming with the crosshair means the ray
 * being cast is exactly the camera's forward axis, so no lens model is needed.
 * `getUserMedia` never exposes focal length, and that would otherwise have to be
 * calibrated per device — this sidesteps it entirely.
 *
 * WHAT IT CANNOT DO. The target must lie on the floor plane, so this measures
 * along the floor: room length, wall runs, distances between corners. It cannot
 * measure a ceiling height or a span up a wall. Accuracy also falls off as the
 * aim flattens toward the horizon — see `groundErrorEstimate`, which is derived
 * rather than asserted, and which the UI uses to warn before a bad number gets
 * ordered against.
 */

/**
 * A point on the floor, in the W3C device-orientation world frame:
 * X east, Y north, **Z up**. Note Z is the vertical axis here, not Y — the
 * OpenGL habit of Y-up does not apply to `deviceorientation`, and mixing the
 * two silently turns "aim at the floor" into "aim at the north wall".
 */
export type Vec2 = { x: number; y: number };

/** W3C `deviceorientation` angles, in degrees, as Safari reports them. */
export type Attitude = { alpha: number; beta: number; gamma: number };

const D2R = Math.PI / 180;

/**
 * The camera's forward direction in the world frame (X east, Y north, Z up;
 * floor at z = 0).
 *
 * Follows the W3C device-orientation convention: intrinsic Z-X'-Y'' rotations by
 * alpha, beta, gamma. The device frame has +X right, +Y up the screen and +Z out
 * of the screen toward the user — so the REAR camera looks along -Z, which is
 * the vector rotated here.
 *
 * Sanity check that pins the convention: a phone lying flat on a table is
 * alpha = beta = gamma = 0, and its rear camera points at the table. This must
 * return (0, 0, -1) — straight down — for that input.
 */
export function cameraForward(a: Attitude): { x: number; y: number; z: number } {
  const al = a.alpha * D2R, be = a.beta * D2R, ga = a.gamma * D2R;
  const cA = Math.cos(al), sA = Math.sin(al);
  const cB = Math.cos(be), sB = Math.sin(be);
  const cG = Math.cos(ga), sG = Math.sin(ga);

  // R = Rz(alpha)·Rx(beta)·Ry(gamma), third column negated for the -Z axis.
  // Third column of R = Rz(alpha)·Rx(beta)·Ry(gamma), negated for the -Z axis.
  const m02 = cA * sG + sA * sB * cG;
  const m12 = sA * sG - cA * sB * cG;
  const m22 = cB * cG;
  return { x: -m02, y: -m12, z: -m22 };
}

/**
 * How far below the horizon the camera is aimed, in radians. Positive is down.
 *
 * Gravity-referenced, so this is the part of the measurement that does not
 * drift no matter how long the phone has been awake.
 */
export function depressionAngle(a: Attitude): number {
  const f = cameraForward(a);
  // Z is the vertical axis; X and Y span the floor.
  const horiz = Math.hypot(f.x, f.y);
  return Math.atan2(-f.z, horiz);
}

/**
 * Where the crosshair lands on the floor, relative to the person holding it.
 *
 * Returns null when the aim is level or above the horizon: the ray then never
 * meets the floor, and a "distance" derived from it would be nonsense growing
 * to infinity as the phone tilts up.
 */
export function groundPoint(a: Attitude, cameraHeightM: number): Vec2 | null {
  if (!(cameraHeightM > 0)) return null;
  const f = cameraForward(a);
  // Needs a genuine downward component. Floor at z = 0, camera at z = h.
  if (!(f.z < -1e-4)) return null;
  const t = cameraHeightM / -f.z;
  const p = { x: f.x * t, y: f.y * t };
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return p;
}

/** Straight-line distance along the floor between two aimed points. */
export function groundDistance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How wrong a single aimed point is likely to be, in metres.
 *
 * Differentiating d = h / tan(θ) gives ∂d/∂θ = -h / sin²θ, so the error grows
 * as the square of how flat the aim is — this is not a fixed tolerance and must
 * not be reported as one. A degree of attitude noise costs a couple of
 * centimetres aiming steeply down at your feet and over a metre aiming across a
 * large room.
 *
 * The height term is simply proportional: d scales with h, so a 2% error in the
 * held height is a 2% error in every distance.
 */
export function groundErrorEstimate(
  depressionRad: number,
  cameraHeightM: number,
  attitudeNoiseDeg = 1,
  heightErrorM = 0.03
): number {
  const s = Math.sin(depressionRad);
  if (!(s > 1e-6)) return Infinity;
  const dTheta = attitudeNoiseDeg * D2R;
  const d = cameraHeightM / Math.tan(depressionRad);
  const fromAngle = (cameraHeightM / (s * s)) * dTheta;
  const fromHeight = (d / cameraHeightM) * heightErrorM;
  return Math.hypot(fromAngle, fromHeight);
}

/**
 * Is this aim good enough to order paint against?
 *
 * The threshold is a percentage of the span rather than an absolute tolerance,
 * because 4 inches of slop is noise across a 20ft wall and ruinous across 3ft.
 */
export function groundAimQuality(
  depressionRad: number,
  cameraHeightM: number
): { usable: boolean; errorM: number; reason: string | null } {
  const errorM = groundErrorEstimate(depressionRad, cameraHeightM);
  const deg = depressionRad / D2R;
  if (!(deg > 0)) return { usable: false, errorM: Infinity, reason: "Aim down at the floor where the wall meets it." };
  if (deg < 8) {
    return { usable: false, errorM, reason: "Too flat to the floor — step closer, or aim at a nearer point." };
  }
  return { usable: true, errorM, reason: null };
}

/**
 * Average a burst of attitude samples taken while the crosshair is held still.
 *
 * A single instantaneous reading carries the full hand tremor: simulated at 1°
 * of noise it puts a 12ft wall out by ~2.2in median and ~5in at the 90th
 * percentile — and it is that tail, not the median, that quietly buys the wrong
 * amount of paint. Tremor is largely uncorrelated frame to frame, so averaging a
 * short burst suppresses it.
 *
 * Alpha is a compass bearing and wraps at 360°, so it is averaged as a circle —
 * a plain arithmetic mean of 359° and 1° gives 180°, pointing the measurement
 * backwards across the room. Beta and gamma are bounded and average normally.
 */
export function averageAttitude(samples: Attitude[]): Attitude | null {
  if (samples.length === 0) return null;
  let sx = 0, sy = 0, sb = 0, sg = 0;
  for (const s of samples) {
    const r = s.alpha * D2R;
    sx += Math.cos(r);
    sy += Math.sin(r);
    sb += s.beta;
    sg += s.gamma;
  }
  const n = samples.length;
  let alpha = Math.atan2(sy / n, sx / n) / D2R;
  if (alpha < 0) alpha += 360;
  return { alpha, beta: sb / n, gamma: sg / n };
}

/**
 * How still the phone was held across a burst, in degrees.
 *
 * Reported so the UI can ask for a steadier hand instead of silently accepting
 * a wobbly aim — the spread across the burst is a direct, honest proxy for how
 * much the resulting number should be trusted.
 */
export function attitudeSpread(samples: Attitude[]): number {
  if (samples.length < 2) return Infinity;
  const mean = averageAttitude(samples)!;
  let worst = 0;
  for (const s of samples) {
    // BOTH axes count. An earlier version checked only pitch, on the reasoning
    // that a compass wobble moves the bearing rather than the range — which is
    // true of a single point and false of a measurement, because the span is
    // the chord between two bearings. Measured on a 12ft wall from 10ft back:
    // 1 degree of bearing error costs 4.2in against pitch's 6.7in. Same order.
    // Reporting only pitch under-stated how shaky a hold really was.
    const dBeta = Math.abs(s.beta - mean.beta);
    // Bearing is circular: 359 and 1 are two degrees apart, not 358.
    let dAlpha = Math.abs(s.alpha - mean.alpha) % 360;
    if (dAlpha > 180) dAlpha = 360 - dAlpha;
    worst = Math.max(worst, dBeta, dAlpha);
  }
  return worst;
}

/**
 * Learn how high the phone is actually being held, from one known length.
 *
 * Every distance scales linearly with the assumed height — d = h / tan(θ) — so a
 * 2in error in a 60in holding height puts every measurement out by 3.3%. That
 * is a SYSTEMATIC error: holding steadier does not touch it, and averaging more
 * samples does not touch it. Left as a guess it becomes the dominant error in
 * the whole method, larger than everything the burst-averaging just removed.
 *
 * Because the relationship is exactly proportional, one measurement of a known
 * length recovers it in closed form: measure something whose length you already
 * know, and the ratio of true to measured is the ratio of true to assumed
 * height. A sheet of paper on the floor, a floor tile, a doorway a tape has
 * already been across — anything, once, per person.
 */
export function calibrateHeight(
  assumedHeightM: number,
  measuredLengthM: number,
  trueLengthM: number
): number | null {
  if (!(assumedHeightM > 0) || !(measuredLengthM > 0) || !(trueLengthM > 0)) return null;
  const h = assumedHeightM * (trueLengthM / measuredLengthM);
  // A person holds a phone somewhere between waist and above the head. Anything
  // outside that means the known length was mistyped or the aim was bad, and
  // silently accepting it would corrupt every later measurement.
  if (h < 0.6 || h > 2.4) return null;
  return h;
}

/**
 * The same floor point, with the aim nudged up or down by a known angle.
 *
 * Used by edge snapping: the detector says the wall–floor junction sits a few
 * pixels off centre, that offset converts to an angle, and the aim is corrected
 * by it before the distance is worked out.
 *
 * Only the PITCH moves. The bearing is left exactly as the phone reports it,
 * because the detector searches rows for a near-horizontal line and therefore
 * knows nothing about left and right. Rotating the whole forward vector would
 * quietly drag the bearing along with the correction.
 */
export function groundPointSnapped(
  a: Attitude,
  cameraHeightM: number,
  pitchDeltaRad: number
): Vec2 | null {
  if (!(cameraHeightM > 0)) return null;
  const f = cameraForward(a);
  const horiz = Math.hypot(f.x, f.y);
  // Straight up or straight down has no bearing to preserve, and the division
  // below would be by zero.
  if (horiz < 1e-6) return null;
  const dep = Math.atan2(-f.z, horiz) + pitchDeltaRad;
  // Still has to point at the floor after the nudge.
  if (!(dep > 1e-4)) return null;
  const t = cameraHeightM / Math.sin(dep);
  const flat = Math.cos(dep) * t;
  const p = { x: (f.x / horiz) * flat, y: (f.y / horiz) * flat };
  return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
}
