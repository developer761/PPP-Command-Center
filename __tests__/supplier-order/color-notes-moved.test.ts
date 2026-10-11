/**
 * Kate p4.2 + p18 "Remove this" — one change, two annotations.
 *
 * The adder for a color parsed out of the notes used to sit on the line-item
 * card. She drew an arrow at it and wrote "Remove this", and separately asked
 * that the color "add that to the custom color area for the guys to add a
 * quantity instead of having a flag that doesn't inform them".
 *
 * So the ADDER moved and the customer's own words stayed. It also had to
 * move: the line-item panel is collapsed by default on a phone now, which is
 * her own p18 request, and an adder inside a closed drawer is not an adder.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const src = () => strip(read("components/order-builder-view.tsx"));

describe("the color-note adder moved off the line item", () => {
  it("renders only the remarks inside the line-item list", () => {
    const s = src();
    // Bounded by the NEW section, not by <CustomColorItems — the moved adder
    // sits between them, and a window that includes it counts two.
    const liAt = s.indexOf('id="source-lines-list"');
    const movedAt = s.indexOf("Colors from the notes");
    expect(liAt).toBeGreaterThan(-1);
    expect(movedAt).toBeGreaterThan(liAt);
    const insideList = s.slice(liAt, movedAt);
    // Exactly one ColorNoteOffers in the list region, and it is remarks-only.
    const uses = insideList.match(/<ColorNoteOffers/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(insideList).toMatch(/only="remarks"/);
    expect(insideList).not.toMatch(/only="offers"/);
  });

  it("renders the adder in the custom color area", () => {
    const s = src();
    const custAt = s.indexOf("Colors from the notes");
    expect(custAt, "no 'Colors from the notes' section").toBeGreaterThan(-1);
    const region = s.slice(custAt - 1500, custAt + 1200);
    expect(region).toMatch(/only="offers"/);
    // Immediately before the custom items, so the row it creates appears next.
    expect(s.indexOf("Colors from the notes")).toBeLessThan(s.indexOf("<CustomColorItems"));
  });

  it("hides the section entirely when no line has an offer", () => {
    // An empty "Colors from the notes" card on every ordinary job would be
    // noise, and the panel it replaced rendered nothing in that case too.
    expect(src()).toMatch(/sourceLines\.some\(\(l\) => \(l\.colorNoteOffers \?\? \[\]\)\.length > 0\) && \(/);
  });

  it("passes the room through, so the order says where the paint goes", () => {
    const s = src();
    const at = s.indexOf("Colors from the notes");
    const region = s.slice(at, at + 1200);
    expect(region).toMatch(/room=\{l\.room\}/);
  });

  it("keeps offers and remarks separable rather than duplicating the component", () => {
    const s = src();
    expect(s).toMatch(/const showOffers = only !== "remarks"/);
    expect(s).toMatch(/const showRemarks = only !== "offers"/);
    // Both halves gated — a half that renders regardless would reappear on
    // the line item, which is the thing she asked to remove.
    expect(s).toMatch(/\{showOffers && offers\.length > 0 && \(/);
    expect(s).toMatch(/\{showOffers && \(/);
    expect(s).toMatch(/\{showRemarks && remarks\.length > 0 && \(/);
  });
});
