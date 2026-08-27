import { describe, it, expect } from "vitest";
import {
  rowGradientProfile, findDominantEdge, pixelOffsetToAngle, grayWindow, DEFAULT_V_FOV,
} from "@/lib/measure/edge-snap";

/**
 * Synthetic frames whose correct answer is known by construction — a wall of
 * one brightness above a floor of another, with the junction at a chosen row.
 */
function frame(w: number, h: number, edgeRow: number, wall = 190, floor = 70, noise = 0) {
  const g = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Deterministic pseudo-noise: a flaky CV test is worse than none.
      const n = noise ? (Math.sin((x * 12.9898 + y * 78.233) * 43758.5453) % 1) * noise : 0;
      g[y * w + x] = (y < edgeRow ? wall : floor) + n;
    }
  }
  return g;
}

describe("finding the wall-floor junction", () => {
  it("locates a clean edge to within a pixel", () => {
    const w = 120, h = 90;
    for (const row of [30, 45, 60]) {
      const hit = findDominantEdge(rowGradientProfile(frame(w, h, row), w, h))!;
      expect(hit).not.toBeNull();
      // Offset is measured from the window centre, matching image coordinates.
      expect(hit.offsetPx).toBeCloseTo(row - 0.5 - (h - 1) / 2, 0);
    }
  });

  it("survives a noisy, textured room", () => {
    const w = 120, h = 90;
    const hit = findDominantEdge(rowGradientProfile(frame(w, h, 50, 190, 70, 40), w, h))!;
    expect(hit).not.toBeNull();
    expect(Math.abs(hit.offsetPx - (50 - 0.5 - (h - 1) / 2))).toBeLessThan(2);
  });

  it("finds nothing on a blank wall rather than inventing an edge", () => {
    // The dangerous failure is not a missed snap, it is a confident wrong one:
    // a bad snap moves the aim decisively to the wrong place.
    const w = 120, h = 90;
    const flat = new Uint8ClampedArray(w * h).fill(150);
    expect(findDominantEdge(rowGradientProfile(flat, w, h))).toBeNull();
  });

  it("finds nothing in pure noise", () => {
    const w = 120, h = 90;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0; i < g.length; i++) g[i] = (Math.sin(i * 12.9898) * 43758.5453) % 255;
    const hit = findDominantEdge(rowGradientProfile(g, w, h));
    // Either nothing, or something too weak to act on.
    if (hit) expect(hit.prominence).toBeLessThan(4);
  });

  it("prefers the true junction over weaker clutter", () => {
    // A skirting board, a shadow line, a rug edge — all real, all weaker than
    // the wall meeting the floor.
    const w = 120, h = 90;
    const g = frame(w, h, 55, 200, 60);
    for (let x = 0; x < w; x++) { g[25 * w + x] = 170; g[26 * w + x] = 185; }  // faint line
    const hit = findDominantEdge(rowGradientProfile(g, w, h))!;
    expect(Math.abs(hit.offsetPx - (55 - 0.5 - (h - 1) / 2))).toBeLessThan(2);
  });

  it("reports how confident it is, so a weak edge can be ignored", () => {
    const w = 120, h = 90;
    const strong = findDominantEdge(rowGradientProfile(frame(w, h, 45, 220, 40), w, h))!;
    const faint = findDominantEdge(rowGradientProfile(frame(w, h, 45, 152, 148), w, h), 1);
    expect(strong.prominence).toBeGreaterThan(4);
    if (faint) expect(faint.prominence).toBeLessThan(strong.prominence);
  });

  it("extracts the centre window from a full RGBA frame", () => {
    const srcW = 320, srcH = 240;
    const rgba = new Uint8ClampedArray(srcW * srcH * 4);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const v = y < 140 ? 200 : 60, i = (y * srcW + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
      }
    }
    const win = grayWindow(rgba, srcW, srcH, 160, 120)!;
    expect(win.width).toBe(160);
    expect(win.height).toBe(120);
    const hit = findDominantEdge(rowGradientProfile(win.gray, win.width, win.height))!;
    // Junction at 140 in a window starting at y=60 -> row 80 of 120.
    expect(Math.abs(hit.offsetPx - (80 - 0.5 - 59.5))).toBeLessThan(2);
  });

  it("refuses a window too small to hold an edge", () => {
    expect(grayWindow(new Uint8ClampedArray(16), 2, 2, 160, 120)).toBeNull();
  });
});

describe("turning a pixel offset into an aim correction", () => {
  it("is zero at the centre and grows outward", () => {
    expect(pixelOffsetToAngle(0, 120, DEFAULT_V_FOV)).toBe(0);
    const near = pixelOffsetToAngle(10, 120, DEFAULT_V_FOV);
    const far = pixelOffsetToAngle(40, 120, DEFAULT_V_FOV);
    expect(far).toBeGreaterThan(near);
  });

  it("keeps its sign, so the aim moves the right way", () => {
    expect(pixelOffsetToAngle(-20, 120, DEFAULT_V_FOV)).toBeCloseTo(-pixelOffsetToAngle(20, 120, DEFAULT_V_FOV), 9);
  });

  it("a full half-FRAME equals half the field of view", () => {
    const deg = (pixelOffsetToAngle(240, 480, DEFAULT_V_FOV) * 180) / Math.PI;
    expect(deg).toBeCloseTo(26, 1);
  });

  it("angle per pixel comes from the frame, never the crop window", () => {
    // The bug this pins: passing a 120-row detection window instead of the
    // 480-row frame multiplied every correction by 4, so a 2 degree nudge
    // became 9 and snapping did more harm than the misplacement it fixed.
    const perPixelFullFrame = pixelOffsetToAngle(20, 480, DEFAULT_V_FOV);
    const ifWindowPassed = pixelOffsetToAngle(20, 120, DEFAULT_V_FOV);
    expect((perPixelFullFrame * 180) / Math.PI).toBeLessThan(3);
    expect(ifWindowPassed).toBeGreaterThan(perPixelFullFrame * 3);
  });

  it("an assumed field of view is good enough BECAUSE the nudge is small", () => {
    // The whole justification for guessing the FOV. A 20px misplacement is
    // ~1.5 degrees of aim error; getting the FOV 20% wrong changes the
    // correction by a fraction of that, which still leaves the aim far better
    // than not snapping at all.
    const truth = pixelOffsetToAngle(20, 120, DEFAULT_V_FOV);
    const wrong = pixelOffsetToAngle(20, 120, DEFAULT_V_FOV * 1.2);
    const residual = Math.abs(truth - wrong) * (180 / Math.PI);
    const uncorrected = Math.abs(truth) * (180 / Math.PI);
    expect(uncorrected).toBeGreaterThan(1);
    expect(residual).toBeLessThan(uncorrected * 0.25);
  });

  it("does not divide by a zero-height window", () => {
    expect(pixelOffsetToAngle(10, 0, DEFAULT_V_FOV)).toBe(0);
  });
});

describe("what snapping is actually worth, in inches", () => {
  const FT = 0.3048, D2R = Math.PI / 180;
  const h = 1.524;              // 5ft
  const FRAME_H = 480;          // video frame height — what the FOV describes

  /** Ground distance for a given depression. */
  const dist = (depRad: number) => h / Math.tan(depRad);

  /**
   * Measure a 12ft wall from 10ft back, with the crosshair misplaced by a given
   * number of pixels at each end — the error the burst-average cannot touch,
   * because it is a steady aim at the wrong place.
   */
  function wallError(misplacePx: number, snap: boolean, fovErrorFactor = 1) {
    const away = 10 * FT, halfWall = 6 * FT;
    const corners = [-halfWall, halfWall].map((x) => ({ x, y: away }));
    const pts = corners.map((c, i) => {
      const d = Math.hypot(c.x, c.y);
      const trueDep = Math.atan(h / d);
      // Misplaced one way at one corner, the other way at the other: the worst
      // realistic case, since it stretches the span rather than shifting it.
      const px = i === 0 ? misplacePx : -misplacePx;
      const aimErr = pixelOffsetToAngle(px, FRAME_H, DEFAULT_V_FOV);
      let dep = trueDep + aimErr;
      if (snap) {
        // Snapping sees the junction `px` away from centre and corrects by that
        // much, using an assumed FOV that may be off.
        const correction = pixelOffsetToAngle(px, FRAME_H, DEFAULT_V_FOV * fovErrorFactor);
        dep = trueDep + aimErr - correction;
      }
      const dd = dist(dep);
      const bearing = Math.atan2(c.x, c.y);
      return { x: Math.sin(bearing) * dd, y: Math.cos(bearing) * dd };
    });
    const measured = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    return Math.abs(measured - 12 * FT) / FT * 12;   // inches
  }

  it("recovers most of the error from a misplaced crosshair", () => {
    console.log("  12ft wall from 10ft back, phone at 5ft — error in inches:");
    console.log("    misplaced   no snap    snapped   snapped w/ 20% FOV error");
    for (const px of [5, 10, 20, 30]) {
      const raw = wallError(px, false);
      const snapped = wallError(px, true);
      const wrongFov = wallError(px, true, 1.2);
      console.log(`    ${String(px).padStart(6)}px   ${raw.toFixed(2).padStart(6)}    ${snapped.toFixed(2).padStart(7)}    ${wrongFov.toFixed(2).padStart(10)}`);
      expect(snapped).toBeLessThan(raw);
      // Even with the FOV badly wrong, snapping must still beat not snapping —
      // otherwise assuming the FOV would not be defensible.
      expect(wrongFov).toBeLessThan(raw);
    }
  });

  it("a 20px misplacement is worth inches, which is why this matters", () => {
    // The burst-average got tremor down to ~0.34in. If aim placement costs more
    // than that, it is the dominant error and snapping is the right next move.
    expect(wallError(20, false)).toBeGreaterThan(0.34);
  });
});
