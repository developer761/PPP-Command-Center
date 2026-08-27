import { describe, it, expect } from "vitest";
import {
  distanceM, metresToFeet, formatMetres, transformVec4, projectToScreen, arConfidence, M_PER_FT,
} from "@/lib/measure/ar-math";

/** Column-major perspective matrix, the layout WebXR hands out. */
function perspective(fovYRad: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}
const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
/** Column-major translation — note the offsets live in elements 12..14. */
const translate = (x: number, y: number, z: number) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];

describe("AR measuring maths", () => {
  it("measures in metres, because that is what WebXR poses are", () => {
    expect(distanceM({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(distanceM({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 })).toBe(0);
  });

  it("converts to the units a painter works in", () => {
    expect(metresToFeet(M_PER_FT)).toBeCloseTo(1, 9);
    expect(metresToFeet(3.6576)).toBeCloseTo(12, 6);   // a 12ft wall
  });

  it("reads back like a tape", () => {
    expect(formatMetres(3.6576)).toBe("12′");
    expect(formatMetres(3.8354)).toBe("12′ 7″");
    expect(formatMetres(0.2032)).toBe("8″");
  });

  it("never prints 12 inches", () => {
    // 11.98ft is 11′ 11.8″ — must carry to 12′, not read "11′ 12″".
    expect(formatMetres(11.98 * M_PER_FT)).toBe("12′");
  });

  it("treats matrices as column-major, the way WebXR supplies them", () => {
    // If this were read row-major the translation would land in the wrong
    // components and every anchor would track the phone, not the wall.
    const out = transformVec4(translate(5, -2, 7), [1, 1, 1, 1]);
    expect(out).toEqual([6, -1, 8, 1]);
  });

  it("puts a point straight ahead at the centre of the screen", () => {
    const proj = perspective(Math.PI / 3, 1, 0.1, 100);
    // Camera at the origin looking down -Z (the OpenGL/WebXR convention).
    const p = projectToScreen({ x: 0, y: 0, z: -2 }, IDENTITY, proj, 390, 800)!;
    expect(p.x).toBeCloseTo(195, 3);
    expect(p.y).toBeCloseTo(400, 3);
  });

  it("puts a point to the right of the camera to the right of the screen, and up above centre", () => {
    const proj = perspective(Math.PI / 3, 390 / 800, 0.1, 100);
    const right = projectToScreen({ x: 0.5, y: 0, z: -2 }, IDENTITY, proj, 390, 800)!;
    const up = projectToScreen({ x: 0, y: 0.5, z: -2 }, IDENTITY, proj, 390, 800)!;
    expect(right.x).toBeGreaterThan(195);
    // Screen Y grows downward while NDC Y grows up — the flip must survive.
    expect(up.y).toBeLessThan(400);
  });

  it("refuses to draw a point behind the camera", () => {
    // Without the w check a point behind you is drawn mirrored in front of you,
    // so the measuring line whips across the screen as you turn around.
    const proj = perspective(Math.PI / 3, 1, 0.1, 100);
    expect(projectToScreen({ x: 0, y: 0, z: 2 }, IDENTITY, proj, 390, 800)).toBeNull();
    expect(projectToScreen({ x: 0, y: 0, z: 0 }, IDENTITY, proj, 390, 800)).toBeNull();
  });

  it("rates a short span as less trustworthy than a long one", () => {
    // The same few centimetres of anchor slop is noise across a wall and a
    // large fraction across a doorway.
    expect(arConfidence(4).confidence).toBe("high");
    expect(arConfidence(4).pct).toBeLessThanOrEqual(3);
    expect(arConfidence(0.3).confidence).toBe("low");
    expect(arConfidence(0.3).pct).toBeGreaterThan(arConfidence(4).pct);
  });

  it("never reports a nonsense error percentage", () => {
    expect(arConfidence(0).pct).toBeLessThanOrEqual(50);
    expect(arConfidence(0).pct).toBeGreaterThan(0);
    expect(Number.isFinite(arConfidence(0.001).pct)).toBe(true);
  });
});
