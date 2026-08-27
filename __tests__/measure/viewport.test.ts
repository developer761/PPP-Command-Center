import { describe, it, expect } from "vitest";
import {
  fittedSize, reticleToImage, imageToViewport, clampTransform,
  zoomAboutReticle, centreOn, IDENTITY, MAX_ZOOM,
} from "@/lib/measure/viewport";

const NAT = { w: 4032, h: 3024 };      // a real iPhone photo
const VP = { w: 390, h: 500 };          // portrait phone viewport

describe("reticle coordinate mapping", () => {
  it("fits the photo inside the viewport, aspect preserved", () => {
    const f = fittedSize(NAT, VP);
    expect(f.w).toBeCloseTo(390, 1);              // width-constrained
    expect(f.h).toBeCloseTo(292.5, 1);
    expect(f.w / f.h).toBeCloseTo(NAT.w / NAT.h, 3);
  });

  it("points at the centre of the image when untransformed", () => {
    const p = reticleToImage(IDENTITY, NAT, VP)!;
    expect(p.x).toBeCloseTo(NAT.w / 2, 3);
    expect(p.y).toBeCloseTo(NAT.h / 2, 3);
  });

  it("round-trips image px → screen → image px", () => {
    // Every placed point is stored in image px and drawn in screen px. If these
    // two disagree the dot renders somewhere other than where it was dropped.
    const t = { tx: -60, ty: 35, k: 2.5 };
    for (const p of [{ x: 100, y: 100 }, { x: 2016, y: 1512 }, { x: 3900, y: 2900 }]) {
      const screen = imageToViewport(p, t, NAT, VP)!;
      // Invert by hand: shift the transform so this point lands on the reticle.
      const shifted = { ...t, tx: t.tx + (VP.w / 2 - screen.x), ty: t.ty + (VP.h / 2 - screen.y) };
      const back = reticleToImage(shifted, NAT, VP)!;
      expect(back.x).toBeCloseTo(p.x, 2);
      expect(back.y).toBeCloseTo(p.y, 2);
    }
  });

  it("zoom keeps whatever the reticle was on", () => {
    // The point of zooming is to place a corner precisely. If the target drifts
    // out from under the crosshair each pinch, you re-aim forever.
    const t = { tx: -80, ty: 40, k: 1 };
    const before = reticleToImage(t, NAT, VP)!;
    let z = t;
    for (const f of [1.5, 1.5, 1.2]) z = zoomAboutReticle(z, f, NAT, VP);
    const after = reticleToImage(z, NAT, VP)!;
    expect(z.k).toBeGreaterThan(2.5);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it("never lets the reticle leave the photo", () => {
    // Stranded on empty background you cannot tell which way the image went.
    for (const k of [1, 3, MAX_ZOOM]) {
      const t = clampTransform({ tx: -99999, ty: 99999, k }, NAT, VP);
      const p = reticleToImage(t, NAT, VP)!;
      expect(p.x).toBeGreaterThanOrEqual(-0.01);
      expect(p.x).toBeLessThanOrEqual(NAT.w + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(-0.01);
      expect(p.y).toBeLessThanOrEqual(NAT.h + 0.01);
    }
  });

  it("clamps zoom to the allowed range", () => {
    expect(clampTransform({ tx: 0, ty: 0, k: 0.01 }, NAT, VP).k).toBe(1);
    expect(clampTransform({ tx: 0, ty: 0, k: 500 }, NAT, VP).k).toBe(MAX_ZOOM);
    expect(zoomAboutReticle(IDENTITY, 0.001, NAT, VP).k).toBe(1);
  });

  it("centres on a placed point so it can be nudged", () => {
    const target = { x: 3200, y: 400 };
    const t = centreOn(target, 4, NAT, VP);
    const p = reticleToImage(t, NAT, VP)!;
    expect(p.x).toBeCloseTo(target.x, 1);
    expect(p.y).toBeCloseTo(target.y, 1);
  });

  it("survives a zero-sized viewport during first paint", () => {
    // The container measures 0x0 before layout; this must not emit NaN and
    // poison every stored point.
    expect(fittedSize(NAT, { w: 0, h: 0 })).toEqual({ w: 0, h: 0 });
    expect(reticleToImage(IDENTITY, NAT, { w: 0, h: 0 })).toBeNull();
    expect(imageToViewport({ x: 1, y: 1 }, IDENTITY, NAT, { w: 0, h: 0 })).toBeNull();
    expect(clampTransform({ tx: 5, ty: 5, k: 2 }, NAT, { w: 0, h: 0 })).toEqual({ tx: 0, ty: 0, k: 2 });
  });
});
