import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The delivery tiles are readable — measured, not eyeballed.
 *
 * Rebuilding these as one filled control (Karan 2026-09-17, the fourth "make
 * them clickable") moved every label off `bg-surface` and onto a brand tint.
 * That changes the contrast of all four text colors at once, and I picked them
 * by eye. Measuring afterwards:
 *
 *   phase label   text-cc-brand-700/70  2.87:1   at 9px
 *   state caption text-cc-brand-900/45  2.46:1   at 11px
 *
 * Both are small text, so AA is 4.5:1. Both shipped in the first version of the
 * rebuild and neither is visible as wrong in the source — the classes look
 * perfectly sensible, and the failure only exists because of what they sit on.
 * This is the same class the project already has a rule about ("the 600-on-50
 * tint pairing fails AA").
 *
 * The hover state is checked too: `hover:bg-cc-brand-100` LIGHTENS the tile in
 * light mode, so a color that passes at rest can fail under the cursor —
 * cc-brand-700 came out 4.91:1 at rest and 4.02:1 on hover.
 */

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const src = readFileSync(join(process.cwd(), "components/commercial/delivery-tools-strip.tsx"), "utf8");

/** Token values, split at the dark block the same way globals.css is written. */
function tokenAt(name: string, dark: boolean): string {
  const darkStart = css.indexOf('[data-theme="dark"] {');
  const region = dark ? css.slice(darkStart) : css.slice(0, darkStart);
  const m = region.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  const light = css.slice(0, darkStart).match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  return (m?.[1] ?? light?.[1])!;
}

const luminance = (hex: string): number => {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const parse = (hex: string) => hex.replace("#", "").match(/../g)!.map((x) => parseInt(x, 16));
const toHex = (a: number[]) => "#" + a.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Alpha-composite, because Tailwind's `/80` is opacity, not a token. */
const over = (fg: string, bg: string, alpha: number) => {
  const [F, B] = [parse(fg), parse(bg)];
  return toHex(F.map((v, i) => v * alpha + B[i] * (1 - alpha)));
};

const AA_SMALL = 4.5;

describe("delivery tile contrast", () => {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    // The page behind the tile, then the tile's own `bg-cc-brand-50/70`.
    const page = dark ? "#0b0b0d" : "#ffffff";
    const rest = over(tokenAt("cc-brand-50", dark), page, 0.7);
    const hover = tokenAt("cc-brand-100", dark); // hover:bg-cc-brand-100 is opaque

    it(`the tool label clears AA in ${theme}, at rest and on hover`, () => {
      const fg = tokenAt("cc-brand-900", dark);
      expect(ratio(fg, rest)).toBeGreaterThanOrEqual(AA_SMALL);
      expect(ratio(fg, hover)).toBeGreaterThanOrEqual(AA_SMALL);
    });

    it(`the phase label clears AA in ${theme}, at rest and on hover`, () => {
      // 9px uppercase — small text, no large-text exemption.
      const fg = tokenAt("cc-brand-800", dark);
      expect(ratio(fg, rest)).toBeGreaterThanOrEqual(AA_SMALL);
      expect(ratio(fg, hover)).toBeGreaterThanOrEqual(AA_SMALL);
    });

    it(`the state caption clears AA in ${theme}, at rest and on hover`, () => {
      const fg = tokenAt("cc-brand-900", dark);
      expect(ratio(over(fg, rest, 0.8), rest)).toBeGreaterThanOrEqual(AA_SMALL);
      expect(ratio(over(fg, hover, 0.8), hover)).toBeGreaterThanOrEqual(AA_SMALL);
    });
  }

  it("still uses the colors this test measured", () => {
    // The guard that keeps the maths honest. Without it, someone changes the
    // class in the component, this file keeps measuring the old tokens, and
    // reports PASS about colors that are no longer on screen.
    expect(src).toContain("bg-cc-brand-50/70");
    expect(src).toContain("hover:bg-cc-brand-100");
    expect(src).toContain("text-cc-brand-800"); // phase
    expect(src).toContain("text-cc-brand-900"); // label
    expect(src).toContain("text-cc-brand-900/80"); // state caption
    // And the two that failed must not come back.
    expect(src).not.toContain("text-cc-brand-900/45");
    expect(src).not.toContain("text-cc-brand-700/70");
  });
});
