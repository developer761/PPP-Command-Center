/**
 * Snap the aim to the wall–floor junction, the way Apple's reticle grabs a
 * corner.
 *
 * WHY THIS IS THE HIGHEST-VALUE ACCURACY WORK LEFT. The burst-average already
 * removed hand tremor, taking a 12ft wall from ~2.1in of error to ~0.34in. But
 * that simulation assumed the crosshair was placed EXACTLY on the junction and
 * only jittered. In a real hallway, putting it 15-20px off is effortless — and
 * at a typical phone field of view that is 1-2 degrees, worth three to seven
 * inches. Aim placement is therefore the largest remaining error, and it is
 * exactly what snapping fixes.
 *
 * HOW. The wall–floor junction is the strongest near-horizontal edge anywhere
 * near the centre of the frame: a long, straight, high-contrast boundary
 * between two differently-lit surfaces. Finding it does not need general edge
 * detection — summing the vertical gradient along each row of a small window
 * collapses the problem to a 1-D peak search, which is both far more robust to
 * clutter than tracing individual edges and cheap enough to run every frame.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never snaps on a weak or ambiguous peak;
 * a wrong snap is worse than no snap, because it moves the aim confidently to
 * the wrong place. Every function here is pure so detection can be tested
 * against images whose correct answer is known by construction.
 */

export type EdgeHit = {
  /** Rows below the window's centre are positive, matching image coordinates. */
  offsetPx: number;
  /** Peak strength over background. Below ~2 it is not a real edge. */
  prominence: number;
};

/**
 * Row-by-row vertical gradient energy over a grayscale window.
 *
 * Uses a centred difference across two rows rather than a full Sobel: the
 * horizontal smoothing a Sobel adds is already provided by summing across the
 * whole row, so the extra work buys nothing here.
 */
export function rowGradientProfile(gray: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(height);
  if (width <= 0 || height < 3) return out;
  for (let y = 1; y < height - 1; y++) {
    let sum = 0;
    const above = (y - 1) * width;
    const below = (y + 1) * width;
    for (let x = 0; x < width; x++) sum += Math.abs(gray[below + x] - gray[above + x]);
    out[y] = sum / width;
  }
  return out;
}

/**
 * The dominant horizontal edge in the profile, if there is one.
 *
 * Prominence is the peak measured against the MEDIAN row rather than the mean:
 * a real junction is one strong row among many ordinary ones, and a mean is
 * dragged upward by the very peak being tested — which flatters a weak edge
 * into looking significant.
 */
export function findDominantEdge(profile: Float32Array, minProminence = 2): EdgeHit | null {
  const n = profile.length;
  if (n < 5) return null;

  let peak = 1, peakVal = profile[1];
  for (let y = 2; y < n - 1; y++) {
    if (profile[y] > peakVal) { peakVal = profile[y]; peak = y; }
  }
  if (!(peakVal > 0)) return null;

  const sorted = Array.from(profile.slice(1, n - 1)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // A featureless wall has a median near zero; guard the division rather than
  // letting a flat image report infinite confidence.
  const prominence = median > 0.5 ? peakVal / median : peakVal > 6 ? 99 : 0;
  if (prominence < minProminence) return null;

  // Sub-pixel refinement: fit a parabola through the peak and its neighbours.
  // The junction rarely lands exactly on a row, and at these window sizes half
  // a row is a meaningful fraction of the correction being applied.
  const a = profile[peak - 1], b = profile[peak], c = profile[peak + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  const refined = peak + (Math.abs(shift) <= 1 ? shift : 0);

  return { offsetPx: refined - (n - 1) / 2, prominence };
}

/**
 * Convert a vertical pixel offset into an angular one, via the pinhole model.
 *
 * `frameHeightPx` is the height of the WHOLE video frame, not the detection
 * window. The field of view describes the full frame, so angle-per-pixel is
 * fixed by the frame; a cropped window sees the same pixels at the same angular
 * pitch, just fewer of them. Passing the window height instead inflates every
 * correction by the crop factor — with a 120-row window on a 480-row frame that
 * is 4x, turning a 2 degree nudge into 9 and making a snap far more damaging
 * than the misplacement it was correcting.
 *
 * The vertical field of view has to be assumed — getUserMedia never exposes
 * focal length. That is tolerable ONLY because this is a correction rather than
 * the measurement: getting the FOV 20% wrong costs 20% of a small nudge, which
 * is much less than the aim error the nudge removes. It would not be acceptable
 * if the whole distance rested on it.
 */
export function pixelOffsetToAngle(offsetPx: number, frameHeightPx: number, vFovRad: number): number {
  if (frameHeightPx <= 0) return 0;
  const half = frameHeightPx / 2;
  return Math.atan((offsetPx / half) * Math.tan(vFovRad / 2));
}

/**
 * Typical vertical field of view for a phone's main rear camera, in radians.
 *
 * ~26mm-equivalent glass gives roughly 73 degrees horizontally; at 4:3 that is
 * about 57 vertically. Video capture is usually cropped tighter, so 52 is the
 * closer figure for a stream rather than a still.
 */
export const DEFAULT_V_FOV = (52 * Math.PI) / 180;

/** Extract the luminance of a centred window from RGBA pixels. */
export function grayWindow(
  rgba: Uint8ClampedArray, srcW: number, srcH: number, winW: number, winH: number
): { gray: Uint8ClampedArray; width: number; height: number } | null {
  const w = Math.min(winW, srcW), h = Math.min(winH, srcH);
  if (w < 3 || h < 5) return null;
  const x0 = Math.floor((srcW - w) / 2), y0 = Math.floor((srcH - h) / 2);
  const gray = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * srcW + (x0 + x)) * 4;
      // Rec. 601 luma — matches how the eye weights the channels, so a
      // colour-only boundary (carpet against skirting) still registers.
      gray[y * w + x] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
    }
  }
  return { gray, width: w, height: h };
}
