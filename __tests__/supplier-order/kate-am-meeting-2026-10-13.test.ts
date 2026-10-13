/**
 * Kate, 2026-10-13, 15 minutes before the AM meeting. Two flagged red.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const builder = () => strip(read("components/order-builder-view.tsx"));

describe("RED 1 — the accent alert stays off non-wall surfaces", () => {
  it("decides WHERE by the surface, not just whether by the room", () => {
    // Katie 2026-10-13: "do not show Accent wall alert for non-wall surfaces
    // (ceilings, trim)." The per-room trigger stays — without it the walls
    // line goes unflagged, which was the original bug.
    const s = strip(read("lib/supplier-order/estimate-gallons.ts"));
    expect(s).toMatch(/const surfaceIsWall =\s*\n?\s*classifySurface\(s\.surfaceLabel\) === "walls" \|\| mentionsAccentWall\(s\.surfaceLabel\)/);
    expect(s).toMatch(/if \(roomHasAccent && roomPaintsWalls && surfaceIsWall\)/);
  });
});

describe("RED 2 — a color from the notes can carry its product line and finish", () => {
  it("offers both controls on the row", () => {
    const s = builder();
    expect(s).toMatch(/aria-label=\{`Finish for \$\{line\}`\}/);
    expect(s).toMatch(/id=\{`cn-mt-\$\{line\}`\}/);
  });

  it("seeds the finish from what the note already said", () => {
    // "Summer Plum (2074-20) eggshell" parses a finish; "Carter Plum
    // (CW-355)" does not. The common case arrives answered.
    expect(builder()).toMatch(/value=\{finish\[line\] \?\? id\.finish \?\? ""\}/);
  });

  it("carries BOTH through on Add, from either path", () => {
    // Enter key and the Add button are separate call sites; one of them
    // keeping the old shape would drop the answer silently.
    const s = builder();
    // Bounded by the closing brace of the options object, not the first ")"
    // — that one sits inside orderableQty(q) and matched almost nothing.
    const adds = s.match(/onAdd\(id\.label[\s\S]*?\}\)/g) ?? [];
    expect(adds.length, "expected the keyboard and click paths").toBe(2);
    for (const a of adds) {
      expect(a).toMatch(/materialType:/);
      expect(a).toMatch(/finish:/);
    }
  });

  it("stores them only when answered", () => {
    // An empty string reads as "the estimator cleared it" rather than
    // "unknown", and unknown is what makes the buy row mark itself.
    expect(builder()).toMatch(/\.\.\.\(extra\?\.materialType \? \{ materialType: extra\.materialType \} : \{\}\)/);
  });
});

describe("the Color Notes box is gone from the order page", () => {
  it("no longer renders the editor", () => {
    const s = builder();
    expect(s).not.toMatch(/id="order-color-notes"/);
    expect(s).not.toMatch(/htmlFor="order-color-notes"/);
  });

  it("but still sends colorNotes on the draft", () => {
    // Her reason was that nothing is lost. That only holds if the data keeps
    // flowing — the box was a second view of it, not its source.
    expect(builder()).toMatch(/colorNotes: payload\.colorNotes \?\? undefined/);
  });
});
