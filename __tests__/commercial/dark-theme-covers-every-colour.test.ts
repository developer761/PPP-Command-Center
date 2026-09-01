import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every colour family the UI paints with must exist in the dark theme.
 *
 * Tailwind's stock palette is defined once, for light. The dark theme works by
 * REDEFINING those same `--color-<family>-<step>` variables, so a family nobody
 * remembered to redefine silently keeps its light value — and renders at full
 * light-mode saturation against a near-black surface.
 *
 * That is not hypothetical. `teal` was the only status colour with no dark
 * mapping, so on the Field Ops calendar and status board every sibling status
 * (emerald · amber · rose) desaturated correctly while "Almost done" kept
 * Tailwind's stock #14b8a6 and glowed. Nothing failed; it just looked wrong,
 * on the one theme nobody screenshots.
 *
 * Reads the stylesheet and the markup rather than a hand-kept list, so adding a
 * new accent colour to a component fails HERE rather than in dark mode.
 */

const CSS = readFileSync("app/globals.css", "utf8");

/**
 * EVERY `[data-theme="dark"]` block, concatenated.
 *
 * There is more than one — a small `{ color-scheme: dark }` rule sits well
 * above the palette block. Taking only the first (which is what I wrote first)
 * reported emerald, amber and rose as unmapped when all three are defined,
 * which would have sent someone re-adding ramps that already exist.
 */
function darkBlock(): string {
  let out = "";
  let from = 0;
  for (;;) {
    const start = CSS.indexOf('[data-theme="dark"]', from);
    if (start === -1) break;
    let depth = 0, i = CSS.indexOf("{", start);
    if (i === -1) break;
    const open = i;
    for (; i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}") { depth--; if (depth === 0) break; }
    }
    out += CSS.slice(open, i);
    from = i + 1;
  }
  if (!out) throw new Error("no dark theme block in globals.css");
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "worktrees"].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

/** Stock Tailwind families we might reach for. Brand families (ppp-*, cc-*) and
 *  the neutral ramp are handled by their own tokens. */
const STOCK = [
  "emerald", "amber", "rose", "teal", "sky", "violet", "indigo",
  "fuchsia", "lime", "cyan", "orange", "purple", "pink", "red",
  "green", "blue", "yellow", "slate", "zinc", "stone",
];

describe("the dark theme covers every colour the UI paints with", () => {
  const dark = darkBlock();
  // ONLY surfaces that can actually render dark.
  //
  // `data-theme` is set in app/commercial/layout.tsx and nowhere else, so the
  // residential app under /dashboard never goes dark and its colours cannot be
  // wrong for a reason this test would catch. Scanning it flagged a `red` in
  // components/materials-view.tsx — a real unmapped family, on a surface with
  // no dark mode to be unmapped in.
  //
  // Shared components count only when Commercial actually pulls them in, which
  // is checked by reference rather than assumed.
  const commercial = [...walk("app/commercial"), ...walk("components/commercial")];
  const commercialSrc = commercial.map((f) => readFileSync(f, "utf8")).join("\n");
  const sharedUsedByCommercial = walk("components").filter((f) => {
    if (f.startsWith("components/commercial/")) return false;
    const base = f.split("/").pop()!.replace(/\.tsx$/, "");
    return commercialSrc.includes(`/${base}"`) || commercialSrc.includes(`/${base}'`);
  });
  const files = [...commercial, ...sharedUsedByCommercial];
  const used = new Map<string, string[]>();

  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(
      /\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|accent)-([a-z]+)-\d{2,3}\b/g
    )) {
      const family = m[1];
      if (!STOCK.includes(family)) continue; // brand token or a neutral
      const list = used.get(family) ?? [];
      if (!list.includes(f)) list.push(f);
      used.set(family, list);
    }
  }

  it("finds the colours actually in use (guards the test itself)", () => {
    // If this ever reads zero families the assertions below become vacuous —
    // a check that cannot fail is worse than no check.
    expect(used.size).toBeGreaterThan(2);
    expect([...used.keys()]).toContain("emerald");
  });

  for (const family of STOCK) {
    const where = used.get(family);
    if (!where?.length) continue;
    it(`${family} has dark values`, () => {
      expect(
        dark.includes(`--color-${family}-`),
        `"${family}" is painted in ${where.length} file(s) — e.g. ${where[0]} — but the dark theme never redefines it, so it renders at full light-mode saturation on a near-black surface. Add a --color-${family}-* ramp to the [data-theme="dark"] block in app/globals.css.`
      ).toBe(true);
    });
  }
});

/**
 * Destructive labels use rose-700, not rose-600.
 *
 * Handed over from the residential session, and the numbers check out — I
 * recomputed all four independently before applying it:
 *
 *              rose-600        rose-700
 *   light card   4.70 ✓          6.29 ✓
 *   light tint   4.28 ✗          5.72 ✓
 *   DARK card    3.39 ✗          6.96 ✓
 *   DARK tint    3.37 ✗          6.91 ✓
 *
 * Three of the four fail the 4.5:1 that 12px semibold needs, and dark fails
 * worst — the dark ramp maps rose-600 to a muted #9b5c63 that sits almost
 * invisibly on the #1a1a1e card. These are Deactivate / Remove / Delete team /
 * Turn off: the one control on a page that most needs to be legible was the
 * least legible on it.
 *
 * Only the TEXT utility. `bg-rose-600` is a solid fill carrying white text at
 * 4.70:1 light / 5.12:1 dark — it passes, and darkening it would be a different
 * and unnecessary change.
 */
describe("destructive text is rose-700", () => {
  const files = [...walk("app/commercial"), ...walk("components/commercial")];

  it("no text-rose-600 survives in Commercial", () => {
    const offenders = files.filter((f) =>
      /(?<![a-z-])text-rose-600\b/.test(readFileSync(f, "utf8"))
    );
    expect(
      offenders,
      `text-rose-600 fails WCAG AA on 3 of its 4 backdrops — worst in dark (3.39:1 on the card). Use text-rose-700.`
    ).toEqual([]);
  });

  it("bg-rose-600 is deliberately left alone", () => {
    // Guards the rule above from being over-applied by a future find/replace:
    // the solid fill passes, and this test should fail if someone "helpfully"
    // sweeps it too.
    const usesFill = files.some((f) => /\bbg-rose-600\b/.test(readFileSync(f, "utf8")));
    expect(usesFill).toBe(true);
  });
});
