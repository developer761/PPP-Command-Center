import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kate round-3 #04 — "pop-ups still open wherever you were standing".
 *
 * The cause was not scroll handling. Page shells are wrapped in
 * `.animate-fade-up`, and that animation ran with `animation-fill-mode: both`
 * while ending on `transform: translateY(0)`. A persisted transform makes the
 * element a containing block for `position: fixed` descendants, so every modal
 * inside a page shell anchored to the PAGE rather than the viewport. Scrolled
 * down, the dialog rendered off-screen at the top of the document.
 *
 * The rule this guards: an animation that persists (fill-mode both/forwards)
 * must not leave a transform behind. `transform: none` is required in the final
 * keyframe — `translateY(0)` / `translateX(0)` / `scale(1)` all still count as
 * a transform and would silently reintroduce the bug across both platforms.
 */

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

/** Every `@keyframes name { ... }` block, brace-matched. */
function keyframeBlocks(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push({ name: m[1], body: source.slice(re.lastIndex, i - 1) });
  }
  return out;
}

describe("persisted animations must not create a containing block", () => {
  const blocks = keyframeBlocks(css);

  it("finds the animations it is meant to police", () => {
    const names = blocks.map((b) => b.name);
    expect(names).toContain("ppp-fade-up");
    expect(names).toContain("ppp-slide-in-right");
  });

  it.each(["ppp-fade-up", "ppp-slide-in-right"])(
    "%s ends on transform: none, not an identity transform",
    (name) => {
      const block = blocks.find((b) => b.name === name);
      expect(block, `@keyframes ${name} not found`).toBeDefined();

      // The 100% / to stop is what fill-mode persists.
      const finalStop = block!.body.split(/(?=\b(?:100%|to)\s*\{)/).pop() ?? "";
      const transform = /transform:\s*([^;}]+)/.exec(finalStop)?.[1]?.trim();

      expect(transform, `${name}'s final keyframe should set a transform`).toBeDefined();
      expect(
        transform,
        `${name} persists "${transform}", which makes the element a containing block ` +
          `for position:fixed children and pushes modals off-screen. Use "none".`
      ).toBe("none");
    }
  );
});
