import { describe, it, expect } from "vitest";
import {
  solveHomography, applyHomography, measureOnPlane,
  rectWorldCorners, calibrationResidual, type Pt,
} from "@/lib/measure/homography";
import { scaleFromReference } from "@/lib/measure/photo-scale";

/**
 * Perspective correction, and the demonstration that it is worth having.
 *
 * Pixel-ratio scaling assumes the wall is parallel to the camera. Real job
 * sites have furniture in them, so people shoot from an angle, and every
 * measurement along the wall then comes out SHORT. These tests build a
 * synthetic camera, photograph a known wall from an angle, and check both
 * methods against the truth.
 */

/**
 * Project a real-world plane point into image pixels through a chosen
 * homography — i.e. simulate photographing the wall from an angle. The
 * numbers here produce a moderate oblique view, the kind you get standing a
 * few feet to one side of a doorway.
 */
const CAMERA: number[] = [
  1.0, 0.10, 100,
  0.05, 1.0, 60,
  0.0016, 0.0004, 1,
];
function project(p: Pt): Pt {
  const w = CAMERA[6] * p.x + CAMERA[7] * p.y + CAMERA[8];
  return {
    x: (CAMERA[0] * p.x + CAMERA[1] * p.y + CAMERA[2]) / w,
    y: (CAMERA[3] * p.x + CAMERA[4] * p.y + CAMERA[5]) / w,
  };
}

const DOOR_W = 32, DOOR_H = 80;

describe("recovering the wall plane from a door", () => {
  const worldCorners = rectWorldCorners(DOOR_W, DOOR_H);
  const imageCorners = worldCorners.map(project);
  const H = solveHomography(imageCorners, worldCorners)!;

  it("solves", () => {
    expect(H).not.toBeNull();
    expect(H).toHaveLength(9);
  });

  it("reproduces the corners it was fitted to", () => {
    expect(calibrationResidual(H, imageCorners, DOOR_W, DOOR_H)).toBeLessThan(0.01);
  });

  it("measures the door's own height correctly", () => {
    const got = measureOnPlane(H, imageCorners[0], imageCorners[3])!;
    expect(got).toBeCloseTo(DOOR_H, 3);
  });

  it("MEASURES A WALL THE PIXEL RATIO GETS WRONG", () => {
    // A 12 ft run along the wall, 40 inches up, photographed at an angle.
    const a: Pt = { x: 0, y: 40 };
    const b: Pt = { x: 144, y: 40 };
    const truth = 144;

    const corrected = measureOnPlane(H, project(a), project(b))!;

    // Same two taps, scaled the old way against the door's height.
    const ratio = scaleFromReference({
      referenceA: imageCorners[0], referenceB: imageCorners[3], referenceInches: DOOR_H,
      targetA: project(a), targetB: project(b),
    })!;

    const correctedErr = Math.abs(corrected - truth) / truth;
    const ratioErr = Math.abs(ratio.inches - truth) / truth;

    // Perspective correction is essentially exact…
    expect(correctedErr).toBeLessThan(0.01);
    // …and materially better than the ratio, which is what justifies the two
    // extra taps the UI asks for.
    expect(ratioErr).toBeGreaterThan(correctedErr * 5);
    // Reported so a future change that quietly erodes the gain is visible.
    console.log(
      `  perspective-corrected: ${corrected.toFixed(1)}in (${(correctedErr * 100).toFixed(2)}% off)  ` +
      `· pixel-ratio: ${ratio.inches.toFixed(1)}in (${(ratioErr * 100).toFixed(1)}% off)`
    );
  });

  it("measures a vertical span away from the door", () => {
    const a: Pt = { x: 100, y: 0 };
    const b: Pt = { x: 100, y: 96 };   // 8 ft ceiling
    const got = measureOnPlane(H, project(a), project(b))!;
    expect(got).toBeCloseTo(96, 2);
  });
});

describe("refusing to return a plausible wrong answer", () => {
  it("returns null on collinear taps", () => {
    // Four points on a line define no plane. Better to fail than to hand back
    // a number that looks fine.
    const line: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    expect(solveHomography(line, rectWorldCorners(DOOR_W, DOOR_H))).toBeNull();
  });

  it("returns null on duplicate taps", () => {
    const dup: Pt[] = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
    expect(solveHomography(dup, rectWorldCorners(DOOR_W, DOOR_H))).toBeNull();
  });

  it("rejects the wrong number of corners", () => {
    expect(solveHomography([{ x: 0, y: 0 }], rectWorldCorners(32, 80))).toBeNull();
  });

  it("flags corners tapped out of order", () => {
    // Swapping two corners still solves, but mirrors the plane — every later
    // measurement comes out plausible and wrong. The residual catches it.
    const world = rectWorldCorners(DOOR_W, DOOR_H);
    const img = world.map(project);
    const swapped = [img[0], img[2], img[1], img[3]];
    const H = solveHomography(swapped, world);
    if (H) expect(calibrationResidual(H, img, DOOR_W, DOOR_H)).toBeGreaterThan(1);
  });
});
