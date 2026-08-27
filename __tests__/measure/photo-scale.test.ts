import { describe, it, expect } from "vitest";
import {
  scaleFromReference, estimateError, formatFeetInches, MIN_REFERENCE_PX,
} from "@/lib/measure/photo-scale";

/**
 * Tap-to-measure: the web-achievable version of Apple's Measure.
 *
 * ARKit is native-iOS-only and Safari can't reach it, so a browser tool has to
 * get its ruler from the scene. A photo containing anything of known size
 * already contains one — the ratio of pixel lengths is the ratio of real ones.
 *
 * The tests that matter most are the ones about being WRONG, because a
 * measuring tool that hides its error is worse than no tool.
 */
const p = (x: number, y: number) => ({ x, y });

describe("scaling a tapped distance", () => {
  it("scales exactly when the target matches the reference", () => {
    const m = scaleFromReference({
      referenceA: p(0, 0), referenceB: p(0, 200), referenceInches: 80,  // a door
      targetA: p(0, 0), targetB: p(0, 200),
    })!;
    expect(m.inches).toBeCloseTo(80, 5);
  });

  it("scales proportionally", () => {
    // Target is 3× the reference in pixels → 3× in inches.
    const m = scaleFromReference({
      referenceA: p(0, 0), referenceB: p(0, 100), referenceInches: 80,
      targetA: p(0, 0), targetB: p(300, 0),
    })!;
    expect(m.inches).toBeCloseTo(240, 5);
    expect(m.feet).toBeCloseTo(20, 5);
    expect(m.display).toBe("20′");
  });

  it("measures diagonals, not just axis-aligned taps", () => {
    // 3-4-5: a 300,400 diagonal is 500px.
    const m = scaleFromReference({
      referenceA: p(0, 0), referenceB: p(0, 100), referenceInches: 10,
      targetA: p(0, 0), targetB: p(300, 400),
    })!;
    expect(m.inches).toBeCloseTo(50, 5);
  });

  it("refuses a reference too small to trust", () => {
    // Two taps carry a few pixels of slop each. Against a tiny reference that
    // slop dominates, and the answer would look authoritative while being noise.
    expect(scaleFromReference({
      referenceA: p(0, 0), referenceB: p(0, MIN_REFERENCE_PX - 1), referenceInches: 80,
      targetA: p(0, 0), targetB: p(0, 400),
    })).toBeNull();
  });

  it("refuses nonsense input rather than returning NaN", () => {
    const base = { referenceA: p(0, 0), referenceB: p(0, 200), targetA: p(0, 0), targetB: p(0, 100) };
    expect(scaleFromReference({ ...base, referenceInches: 0 })).toBeNull();
    expect(scaleFromReference({ ...base, referenceInches: -5 })).toBeNull();
    expect(scaleFromReference({ ...base, referenceInches: 80, targetB: p(0, 0) })).toBeNull();
  });
});

describe("formatting the way a painter says it", () => {
  it("reads as feet and inches", () => {
    expect(formatFeetInches(100)).toBe("8′ 4″");
    expect(formatFeetInches(96)).toBe("8′");
    expect(formatFeetInches(7)).toBe("7″");
  });

  it("carries instead of printing 12 inches", () => {
    // 11.6" must round to the next foot, not to "8′ 12″".
    expect(formatFeetInches(95.6)).toBe("8′");
  });

  it("returns a dash rather than a bogus number", () => {
    expect(formatFeetInches(0)).toBe("—");
    expect(formatFeetInches(NaN)).toBe("—");
    expect(formatFeetInches(-10)).toBe("—");
  });
});

describe("reporting how wrong it might be", () => {
  it("is confident with a long reference aligned to the target", () => {
    const e = estimateError({
      referenceA: p(0, 0), referenceB: p(0, 400),
      targetA: p(50, 0), targetB: p(50, 800),
    });
    expect(e.confidence).toBe("high");
    expect(e.pct).toBeLessThan(4);
  });

  it("warns when the reference is small in frame", () => {
    const e = estimateError({
      referenceA: p(0, 0), referenceB: p(0, 60),
      targetA: p(0, 0), targetB: p(0, 200),
    });
    expect(e.note).toMatch(/reference is small/i);
  });

  it("warns when reference and target aren't in the same plane", () => {
    // A vertical door against a horizontal wall receding from the camera —
    // the classic case, and it reads SHORT without saying so.
    const e = estimateError({
      referenceA: p(0, 0), referenceB: p(0, 300),   // vertical
      targetA: p(0, 0), targetB: p(300, 0),         // horizontal
    });
    expect(e.confidence).not.toBe("high");
    expect(e.note).toMatch(/different directions|same plane/i);
  });

  it("flags extrapolating far beyond the reference", () => {
    const e = estimateError({
      referenceA: p(0, 0), referenceB: p(0, 100),
      targetA: p(0, 0), targetB: p(0, 1200),   // 12× the reference
    });
    expect(e.pct).toBeGreaterThan(4);
  });
});
