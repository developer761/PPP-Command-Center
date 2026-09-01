import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The platform-switch button is a solid fill with white text, and it renders in
 * BOTH platforms' sidebars — so it renders in the commercial dark subtree too.
 *
 * Neither existing dark-theme test covers it:
 *   · dark-theme-covers-every-colour  checks STOCK Tailwind families only;
 *     brand `ppp-*` families are excluded as "handled by their own tokens".
 *   · dark-theme-token-coverage       checks surface TINTS (-50/-100/-200)
 *     paired with text, not -600 solids.
 *
 * Both pass with the dark `--color-ppp-forest-600` deleted — verified. So the
 * button that just moved from emerald onto a brand family would have had no
 * coverage at all. It gets its own, and it asserts the COLOUR MATHS rather
 * than the class name: the emerald it replaced looked perfectly correct in
 * review and still sat at 3.77:1 under white text.
 */

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const darkStart = css.indexOf('[data-theme="dark"] {');
const lightSrc = css.slice(0, darkStart);
const darkSrc = css.slice(darkStart);

function token(src: string, name: string): string | null {
  const m = src.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  return m ? m[1].toLowerCase() : null;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE = "#ffffff";
/** The near-black the dark page paints behind the sidebar. */
const DARK_PAGE = "#0a0a0a";
/** AA for the button's 12px semibold label. */
const AA = 4.5;

describe("platform switcher stays legible in both themes", () => {
  for (const [theme, src] of [["light", lightSrc], ["dark", darkSrc]] as const) {
    it(`${theme}: forest-600 and -700 are defined`, () => {
      expect(token(src, "--color-ppp-forest-600"), `${theme} forest-600`).toBeTruthy();
      expect(token(src, "--color-ppp-forest-700"), `${theme} forest-700`).toBeTruthy();
    });

    it(`${theme}: white label clears AA on the fill and its hover`, () => {
      for (const shade of ["600", "700"]) {
        const hex = token(src, `--color-ppp-forest-${shade}`)!;
        const ratio = contrast(hex, WHITE);
        expect(ratio, `${theme} forest-${shade} (${hex}) vs white = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
      }
    });
  }

  it("dark mode keeps it DARK — it must not invert into a pale sage", () => {
    // emerald-800 becomes #a1cdb8 in dark. A fill that light under white text
    // is the exact failure this token exists to avoid.
    const hex = token(darkSrc, "--color-ppp-forest-600")!;
    expect(luminance(hex), `dark forest-600 (${hex}) is too light for white text`).toBeLessThan(0.25);
    // ...but still distinguishable from the near-black page behind it.
    expect(contrast(hex, DARK_PAGE)).toBeGreaterThan(1.5);
  });

  it("the switcher actually paints with it", () => {
    const src = readFileSync(join(process.cwd(), "components/platform-switcher.tsx"), "utf8");
    expect(src).toMatch(/bg-ppp-forest-600/);
    expect(src).toMatch(/hover:bg-ppp-forest-700/);
    expect(src).toMatch(/text-white/);
    // The emerald it replaced failed AA; it must not creep back.
    expect(src).not.toMatch(/bg-emerald-600/);
  });
});
