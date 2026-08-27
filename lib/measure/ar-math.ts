/**
 * Maths for true AR measuring — the Apple Measure behaviour.
 *
 * WHY THIS EXISTS AND WHERE IT RUNS. Anchoring a point in real 3D space and
 * watching the distance update as you walk the phone needs the device's own
 * tracking: camera feature tracking fused with the IMU, which supplies real
 * metric scale. On Android that is ARCore, reachable from the browser through
 * WebXR's hit-test module. On iPhone it is ARKit, which Safari does not expose
 * at all — no WebXR on iOS, so those phones stay on the reference-object flow
 * until there is a native app.
 *
 * Everything here is pure so the projection and unit conversion can be tested
 * without a headset, a phone, or a WebXR session.
 */

export type Vec3 = { x: number; y: number; z: number };

/** Straight-line distance in metres — WebXR poses are always metric. */
export function distanceM(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export const M_PER_FT = 0.3048;

export function metresToFeet(m: number): number {
  return m / M_PER_FT;
}

/**
 * Metres as a tape reads it: 3′ 9″.
 *
 * Rounds to the nearest inch and carries 12″ up to the next foot, so a reading
 * never shows "3′ 12″".
 */
export function formatMetres(m: number): string {
  const totalIn = Math.round((m / M_PER_FT) * 12);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn - ft * 12;
  if (!ft) return `${inch}″`;
  if (!inch) return `${ft}′`;
  return `${ft}′ ${inch}″`;
}

/**
 * Multiply a column-major 4x4 (the layout WebXR hands out) by a vec4.
 *
 * Column-major means element [row + col*4], which is why the indices step by 4
 * across a row rather than along it. Getting this transposed is the classic way
 * to end up with a marker that tracks the phone instead of the wall.
 */
export function transformVec4(m: Float32Array | number[], v: [number, number, number, number]): [number, number, number, number] {
  const [x, y, z, w] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

/**
 * Where a world point lands on screen, in CSS pixels.
 *
 * Used to draw the measuring line and the anchor dots as plain SVG in the DOM
 * overlay, instead of rendering geometry in WebGL. The AR session still needs a
 * GL context, but nothing has to be drawn into it — which removes shaders,
 * buffers and a whole category of bugs from a feature whose only visual output
 * is a line and two dots.
 *
 * Returns null when the point is behind the camera: w <= 0 means the
 * perspective divide would flip it, and a point behind you would otherwise be
 * drawn mirrored in front of you.
 */
export function projectToScreen(
  point: Vec3,
  viewMatrix: Float32Array | number[],
  projectionMatrix: Float32Array | number[],
  widthPx: number,
  heightPx: number
): { x: number; y: number } | null {
  const view = transformVec4(viewMatrix, [point.x, point.y, point.z, 1]);
  const clip = transformVec4(projectionMatrix, view as [number, number, number, number]);
  const w = clip[3];
  if (!(w > 1e-6)) return null;
  const ndcX = clip[0] / w;
  const ndcY = clip[1] / w;
  return {
    x: (ndcX * 0.5 + 0.5) * widthPx,
    // NDC y points up, CSS pixels point down.
    y: (1 - (ndcY * 0.5 + 0.5)) * heightPx,
  };
}

/**
 * How much to trust a reading.
 *
 * ARCore's own plane fit is good to roughly a centimetre on a well-lit textured
 * surface, but the error that actually bites is the operator: an anchor dropped
 * a few centimetres off the corner. Over a short span that is a large
 * percentage, over a long wall it is noise — so the warning is tied to span
 * length rather than to a fixed tolerance.
 */
export function arConfidence(metres: number): { confidence: "high" | "medium" | "low"; pct: number } {
  // ~2cm of realistic anchor placement slop at each end.
  const slopM = 0.04;
  const pct = metres > 0 ? Math.min(50, Math.round((slopM / metres) * 100)) : 50;
  if (metres >= 1.5 && pct <= 3) return { confidence: "high", pct: Math.max(1, pct) };
  if (metres >= 0.6) return { confidence: "medium", pct };
  return { confidence: "low", pct };
}
