import { describe, it, expect } from "vitest";
import { deriveRoomDimensions, formatRoomDimensions } from "@/lib/supplier-order/room-dimensions";

/**
 * Jason + Alex, 2026-09-17: "Put the room dimensions instead of the
 * calculation surface area coverage (that can be on the backend for us)."
 *
 * Salesforce holds floor area and perimeter, not length and width. For a
 * rectangle those two ARE the dimensions; for anything else they are not, and
 * the maths has to say so instead of inventing a room.
 */

describe("dimensions from what Salesforce actually holds", () => {
  it("a 12 x 15 room, given its area and perimeter", () => {
    expect(deriveRoomDimensions(180, 54)).toEqual({ widthFt: 12, lengthFt: 15 });
  });

  it("a square room", () => {
    expect(deriveRoomDimensions(144, 48)).toEqual({ widthFt: 12, lengthFt: 12 });
  });

  it("a narrow hallway", () => {
    expect(deriveRoomDimensions(48, 32)).toEqual({ widthFt: 4, lengthFt: 12 });
  });

  it("width is always the shorter side", () => {
    const d = deriveRoomDimensions(180, 54)!;
    expect(d.widthFt).toBeLessThanOrEqual(d.lengthFt);
  });

  it("says nothing when no rectangle fits — an L-shaped room", () => {
    // 200 sq ft with only a 50 ft perimeter is impossible for a rectangle:
    // (25² − 800) is negative. The room is a real shape; our model is not.
    expect(deriveRoomDimensions(200, 50)).toBeNull();
  });

  it("says nothing when a measurement is missing or junk", () => {
    expect(deriveRoomDimensions(0, 54)).toBeNull();
    expect(deriveRoomDimensions(180, 0)).toBeNull();
    expect(deriveRoomDimensions(null, null)).toBeNull();
    expect(deriveRoomDimensions(undefined, 54)).toBeNull();
    expect(deriveRoomDimensions(NaN, 54)).toBeNull();
    expect(deriveRoomDimensions(-180, -54)).toBeNull();
  });

  it("rounds to the half foot rather than showing false precision", () => {
    // 181 sq ft and a 54 ft perimeter is nearly 12 x 15, off by rounding in
    // the inputs themselves.
    const d = deriveRoomDimensions(181, 54)!;
    expect(d.widthFt % 0.5).toBe(0);
    expect(d.lengthFt % 0.5).toBe(0);
  });
});

describe("how it reads on the line", () => {
  it("includes the ceiling height when we have one", () => {
    expect(formatRoomDimensions(180, 54, 8)).toBe("12 × 15 × 8 ft");
  });

  it("drops the height when it is missing, rather than guessing 8", () => {
    // The gallon maths defaults a missing height to 8 ft. Printing that as a
    // measurement would tell an estimator we know something we do not.
    expect(formatRoomDimensions(180, 54)).toBe("12 × 15 ft");
    expect(formatRoomDimensions(180, 54, 0)).toBe("12 × 15 ft");
    expect(formatRoomDimensions(180, 54, null)).toBe("12 × 15 ft");
  });

  it("is null when the room cannot be described, so the caller keeps the area", () => {
    expect(formatRoomDimensions(200, 50, 8)).toBeNull();
    expect(formatRoomDimensions(0, 0)).toBeNull();
  });

  it("prints a half foot with one decimal, not fifteen", () => {
    const out = formatRoomDimensions(174, 53, 8.5)!;
    expect(out).toMatch(/^[\d.]+ × [\d.]+ × 8.5 ft$/);
    expect(out).not.toMatch(/\d\.\d\d/);
  });
});
