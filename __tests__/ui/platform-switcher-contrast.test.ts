import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The platform-switch button is a GHOST row — transparent, hairline border,
 * colour only on hover — and it renders in BOTH sidebars, so it renders inside
 * the commercial dark subtree too. Four states have to stay legible: label at
 * rest and label on hover, each in light and dark.
 *
 * Neither existing dark-theme test covers it, which I confirmed rather than
 * assumed (both stay green with the dark forest tokens deleted):
 *   · dark-theme-covers-every-colour  checks STOCK Tailwind families only;
 *     brand `ppp-*` / `cc-*` are excluded as "handled by their own tokens".
 *   · dark-theme-token-coverage       checks surface tints paired with body
 *     text, not a control's own hover pairing.
 *
 * It asserts the colour MATHS, not class names. Every wrong choice here looked
 * right in review: emerald-600 under white was 3.77:1, and cc-brand-600 on its
 * own -50 tint is 2.70:1 in dark. Both read as perfectly ordinary Tailwind.
 */

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const darkStart = css.indexOf('[data-theme="dark"] {');
const THEMES = { light: css.slice(0, darkStart), dark: css.slice(darkStart) };

function token(theme: keyof typeof THEMES, name: string): string {
  const m = THEMES[theme].match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`${name} is not defined in the ${theme} theme`);
  return m[1].toLowerCase();
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

/** AA for the row's 12px semibold label. */
const AA = 4.5;
/** The column the row sits on: residential is bg-white, commercial bg-surface. */
const COLUMN = { light: "#ffffff", dark: () => token("dark", "--color-surface") };

describe("platform switcher — ghost row stays legible", () => {
  for (const theme of ["light", "dark"] as const) {
    const column = theme === "light" ? COLUMN.light : COLUMN.dark();

    it(`${theme}: resting label reads on the sidebar column`, () => {
      const label = token(theme, "--color-ppp-charcoal-600");
      const ratio = contrast(label, column);
      expect(ratio, `charcoal-600 ${label} on ${column} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    });

    it(`${theme}: residential hover — forest accent on the forest tint`, () => {
      const fg = token(theme, "--color-ppp-forest-500");
      const bg = token(theme, "--color-ppp-forest-50");
      const ratio = contrast(fg, bg);
      expect(ratio, `forest-500 ${fg} on forest-50 ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    });

    it(`${theme}: commercial hover — cc-brand accent on the cc-brand tint`, () => {
      const fg = token(theme, "--color-cc-brand-700");
      const bg = token(theme, "--color-cc-brand-50");
      const ratio = contrast(fg, bg);
      expect(ratio, `cc-brand-700 ${fg} on cc-brand-50 ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    });

    it(`${theme}: the hover tint is a tint, not a fill that swallows the accent`, () => {
      // Guards the specific inversion trap: if a dark tint ever flips light (or
      // a light one flips dark) the accent above it silently loses its footing.
      const forestTint = luminance(token(theme, "--color-ppp-forest-50"));
      expect(theme === "light" ? forestTint > 0.5 : forestTint < 0.2).toBe(true);
    });
  }

  it("the switcher paints with these exact roles", () => {
    const src = readFileSync(join(process.cwd(), "components/platform-switcher.tsx"), "utf8");
    expect(src).toMatch(/border-ppp-charcoal-200/);
    expect(src).toMatch(/bg-transparent/);
    expect(src).toMatch(/text-ppp-charcoal-600/);
    expect(src).toMatch(/hover:bg-ppp-forest-50/);
    expect(src).toMatch(/hover:text-ppp-forest-500/);
    expect(src).toMatch(/hover:text-cc-brand-700/);
    // The two solid fills that were rejected must not creep back.
    expect(src).not.toMatch(/bg-emerald-600/);
    expect(src).not.toMatch(/\bbg-ppp-forest-600\b/);
    // cc-brand-600 as hover TEXT is the 2.70:1 failure.
    expect(src).not.toMatch(/hover:text-cc-brand-600/);
  });
});
