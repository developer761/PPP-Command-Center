import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Two failures that would each make the tool look broken rather than wrong, and
 * neither of which any unit test could see — they live in the ORDER of
 * operations and in the stacking of overlays.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the aim is judged AFTER snapping, not before", () => {
  it("checks quality on the corrected aim", () => {
    // A first-time user points at the WALL, because the wall is what they are
    // measuring. The edge detector finds the floor line below and works out the
    // nudge that makes that aim valid — but testing the RAW aim first refused
    // an aim the tool was about to be able to use. Snapping is not a refinement
    // here; it is what makes pointing naturally work.
    const src = codeOnly(read("components/measure-ground.tsx"));
    expect(src, "quality must be measured on the snapped aim")
      .toMatch(/const corrected\s*=\s*depressionAngle\(avg\)\s*\+\s*snapRef\.current/);
    expect(src).toMatch(/groundAimQuality\(corrected/);
    expect(src, "the raw aim must not be the one judged")
      .not.toMatch(/groundAimQuality\(depressionAngle\(avg\)/);
  });

  it("tells the user what to do, not what the geometry did", () => {
    const src = read("lib/measure/ground-plane.ts");
    expect(src).toMatch(/Point at the bottom of the wall/);
    expect(src, "method-speak leaked back into a user-facing message")
      .not.toMatch(/reason: "Too flat to the floor/);
  });
});

describe("handing a measurement back closes the tool", () => {
  // The caller renders its own sheet at a LOWER z-index than the camera tools,
  // so a tool that stays mounted hides that sheet behind itself. The tap looks
  // like it did nothing — the worst possible outcome, because the user cannot
  // tell a broken button from a slow one.
  const zOf = (file: string) =>
    Number(read(file).match(/fixed inset-x-0 top-0 z-\[?(\d+)\]?/)?.[1] ?? NaN);

  it("the tools really do sit above the caller's sheet", () => {
    // Guards the guard: if this stopped being true the requirement below would
    // be arbitrary rather than load-bearing.
    const sheet = zOf("components/measure-tool.tsx");
    expect(sheet).toBeGreaterThan(0);
    for (const t of ["components/measure-ground.tsx", "components/measure-ar.tsx"]) {
      expect(zOf(t), `${t} should stack above the sheet`).toBeGreaterThan(sheet);
    }
  });

  it("each tool closes itself when it returns a raw measurement", () => {
    for (const t of ["components/measure-ground.tsx", "components/measure-ar.tsx"]) {
      const src = codeOnly(read(t));
      // The no-targets branch: hands the number back, then gets out of the way.
      const i = src.indexOf('}, "");');
      expect(i, `${t} has no raw-result branch`).toBeGreaterThan(-1);
      const after = src.slice(i, i + 320);
      expect(after, `${t} must close after handing back a measurement`).toMatch(/onClose\(\)/);
    }
  });

  it("the ground tool releases the camera on the way out", () => {
    // A stream left running holds the device and keeps the privacy light on.
    const src = codeOnly(read("components/measure-ground.tsx"));
    const i = src.indexOf('}, "");');
    expect(src.slice(i, i + 320)).toMatch(/stopStream\(\)/);
  });
});

describe("nothing is shown before anything is measured", () => {
  it("does not display a zero reading", () => {
    // "0 inches" reads as a measurement of zero rather than the absence of one.
    const src = codeOnly(read("components/measure-ground.tsx"));
    expect(src).not.toMatch(/out\.textContent\s*=[^;]*"0″"/);
  });
});
