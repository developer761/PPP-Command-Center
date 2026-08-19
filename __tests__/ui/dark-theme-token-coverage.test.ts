import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dark mode inverts by REDEFINING tokens, not by restyling call sites. That
 * only works if every token in a family gets a dark value — miss one and it
 * silently keeps its light-mode colour while the tokens around it flip.
 *
 * That's what happened to ppp-orange and ppp-green: they had no dark values at
 * all. `bg-ppp-orange-50` stayed #fdefe5 on a near-black page, and the banners
 * that pair the tint with charcoal text — whose token DOES invert, to off-white
 * — rendered at 1.13:1. Off-white text on an off-white block. Invisible, on
 * warning banners specifically, across both platforms.
 *
 * The failure is invisible in code review (both classes look right), invisible
 * in light mode, and invisible to anyone who doesn't run the app dark. So it's
 * asserted here instead: every light surface tint must have a dark counterpart,
 * and the pairs actually used as banner backgrounds must clear WCAG AA in both
 * themes.
 */

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const darkStart = css.indexOf('[data-theme="dark"] {');
const lightSrc = css.slice(0, darkStart);
const darkSrc = css.slice(darkStart);

function tokens(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, k, v] of src.matchAll(/(--color-[a-z-]+(?:-\d+)?)\s*:\s*([^;]+);/g)) {
    out[k] = v.trim();
  }
  return out;
}

const LIGHT = tokens(lightSrc);
const DARK = tokens(darkSrc);
const effectiveDark = (k: string) => DARK[k] ?? LIGHT[k];

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("dark theme token coverage", () => {
  it("gives every PPP surface tint a dark counterpart", () => {
    const tints = Object.keys(LIGHT).filter(
      (k) => /^--color-ppp-[a-z]+-(50|100|200)$/.test(k)
    );
    expect(tints.length).toBeGreaterThan(8); // sanity: the regex still matches
    const missing = tints.filter((k) => !(k in DARK));
    expect(missing, `no dark value — these stay light-mode on a dark page`).toEqual([]);
  });

  it("keeps banner text readable in BOTH themes", () => {
    // The tint+text pairs actually used for banners across the app.
    const pairs: Array<[string, string]> = [
      ["--color-ppp-orange-50", "--color-ppp-orange-700"],
      ["--color-ppp-orange-100", "--color-ppp-orange-700"],
      ["--color-ppp-orange-50", "--color-ppp-charcoal-700"],
      ["--color-ppp-green-50", "--color-ppp-charcoal-700"],
      ["--color-ppp-green-50", "--color-ppp-green-700"],
      ["--color-ppp-blue-50", "--color-ppp-blue-700"],
    ];
    for (const [bg, fg] of pairs) {
      const light = contrast(LIGHT[bg], LIGHT[fg]);
      const dark = contrast(effectiveDark(bg), effectiveDark(fg));
      expect(light, `${bg} + ${fg} in light`).toBeGreaterThanOrEqual(4.5);
      expect(dark, `${bg} + ${fg} in dark`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
