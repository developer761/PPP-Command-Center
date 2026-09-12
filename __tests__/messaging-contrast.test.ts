import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * White text on a colored background.
 *
 * This has been got wrong three times in this build — `bg-ppp-orange-700
 * text-white` each time — and once more in the simulator, whose iMessage-blue
 * bubble sat at 3.22:1 against white for weeks because it looked right. Looking
 * right is exactly the problem: a failing pair is legible to someone with good
 * eyesight on a good screen, so review does not catch it and neither gate does.
 *
 * So it is computed rather than judged. Any `text-white` paired with a
 * background this can resolve must clear 4.5:1.
 */
function srgb(c: number) {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function luminance(hex: string) {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.split("").map((d) => d + d).join("") : v;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function ratio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The palette, read from source so the test cannot drift from the tokens. */
function palette(): Record<string, string> {
  const css = fs.readFileSync("app/globals.css", "utf8");
  // Light theme only: the first definition of each token, before any override
  // block. A dark-mode value is a different pairing and is not what these
  // classes resolve to on the messaging surface.
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--color-(ppp-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const FILES = [...walk("components/messaging"), ...walk("app/messaging")];
const PALETTE = palette();
const AA = 4.5;

describe("white text clears WCAG AA", () => {
  it("read the palette", () => {
    expect(Object.keys(PALETTE).length).toBeGreaterThan(10);
    expect(PALETTE["ppp-charcoal"]).toMatch(/^#/);
  });

  it("every text-white pairing is legible", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      const src = fs.readFileSync(f, "utf8");
      // A class string is the unit that applies together. A line is not: the
      // two arms of a ternary sit on one line and never render at once, so
      // pairing by line reports failures that cannot happen on screen.
      for (const m of src.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
        const cls = m[1];
        if (!/(^|\s)text-white(\s|$)/.test(cls)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        for (const b of cls.matchAll(/(?<![a-z0-9:-])bg-\[(#[0-9a-fA-F]{3,6})\]/g)) {
          const r = ratio(b[1], "#ffffff");
          if (r < AA) bad.push(`${f}:${line}  ${b[1]} → ${r.toFixed(2)}:1`);
        }
        for (const b of cls.matchAll(/(?<![a-z0-9:-])bg-(ppp-[a-z0-9-]+)/g)) {
          const hex = PALETTE[b[1]];
          if (!hex) continue;
          const r = ratio(hex, "#ffffff");
          if (r < AA) bad.push(`${f}:${line}  ${b[1]} ${hex} → ${r.toFixed(2)}:1`);
        }
      }
    }
    expect(bad, `white text below ${AA}:1:\n${bad.join("\n")}`).toEqual([]);
  });

  it("messaging renders light-only, so the light palette is the right one", () => {
    // This test reads the FIRST definition of each token. That is only correct
    // while the messaging surface never sits under [data-theme], which flips
    // the whole ramp — ppp-orange-700 goes from #a83f12 to a light peach. Dark
    // is scoped to the commercial subtree. If messaging ever adopts a theme
    // root, this test is measuring the wrong colors and must learn both.
    const themed = FILES.filter((f) => fs.readFileSync(f, "utf8").includes("data-theme"));
    expect(themed, "messaging now sets data-theme — this test checks light tokens only").toEqual([]);
  });

  it("the maths is right", () => {
    // Controls. Without these the assertion above passes when luminance is wrong.
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(ratio("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
    // The bubble as it was, and as it is.
    expect(ratio("#0b93f6", "#ffffff")).toBeLessThan(AA);
    expect(ratio("#0b76ce", "#ffffff")).toBeGreaterThanOrEqual(AA);
    // And the variant filter really does skip a prefixed background while
    // still catching a bare one.
    const bare = /(?<![a-z0-9:-])bg-(ppp-[a-z0-9-]+)/;
    expect(bare.test("disabled:bg-ppp-charcoal-200")).toBe(false);
    expect(bare.test("bg-ppp-charcoal-200")).toBe(true);
    // And a failing pair inside one class string is still caught.
    const pair = (c: string) => /(^|\s)text-white(\s|$)/.test(c);
    expect(pair("bg-ppp-orange-700 text-white")).toBe(true);
    expect(pair("bg-ppp-charcoal-50 text-ppp-charcoal-500")).toBe(false);
    // #e3a687 is ppp-orange-700 as the dark theme redefines it — the pairing
    // that went wrong three times on Commercial. It is not what messaging
    // resolves to (see the scope test below) but it proves the maths flags it.
    expect(ratio("#e3a687", "#ffffff")).toBeLessThan(AA);
  });
});
