import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * White text on PPP's brand fills fails WCAG AA, and the fix is not a find-and-
 * replace, so this guards the actual rule rather than a spelling.
 *
 *   white on brand blue   #2BAAE1   2.64:1   FAIL
 *   white on brand orange #EE662E   3.19:1   FAIL
 *
 * The trap is the middle of the ramp. Blue-600 (#1E8FBF) reaches AA with
 * NEITHER navy (3.85) nor white (3.66) — so the conventional "darken on hover"
 * walks a compliant resting state straight into a dead zone, and the usual
 * escape (white on the dark states, navy on the light one) flips the label
 * colour mid-press on every primary button.
 *
 * So: navy on the brand fill, and hover/active go LIGHTER. Contrast improves as
 * you interact instead of collapsing, one text colour holds throughout, and
 * #2BAAE1 stays exactly the 2023 brand-deck primary at rest — which is what
 * anyone actually looks at.
 *
 * The three orange sites are badges and a banner with no hover state at all, so
 * they just needed a fill dark enough for white: orange-700 at 6.2:1.
 */

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const light = css.slice(0, css.indexOf('[data-theme="dark"] {'));
const TOKENS: Record<string, string> = {};
for (const [, k, v] of light.matchAll(/(--color-ppp-[a-z]+(?:-\d+)?)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  TOKENS[k] = v;
}

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

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      if (full.includes("commercial")) continue; // separate platform, own session
      walk(full, out);
    } else if (e.endsWith(".tsx")) out.push(full);
  }
  return out;
}
const FILES = [...walk(join(ROOT, "components")), ...walk(join(ROOT, "app"))];

/** Class strings pairing an exact brand-token fill with white text. */
function offenders(family: "blue" | "orange" | "green"): string[] {
  const fill = new RegExp(String.raw`(?<![-\w])bg-ppp-${family}(?![-\w])`);
  const hits: string[] = [];
  for (const f of FILES) {
    for (const [, cls] of readFileSync(f, "utf8").matchAll(/"([^"\n]*)"/g)) {
      if (fill.test(cls) && /(?<![-\w:])text-white(?![-\w])/.test(cls)) {
        hits.push(`${f.replace(ROOT + "/", "")} :: ${cls.slice(0, 70)}`);
      }
    }
  }
  return hits;
}

describe("brand fills never carry white text", () => {
  it.each(["blue", "orange", "green"] as const)("ppp-%s", (family) => {
    const token = TOKENS[`--color-ppp-${family}`];
    expect(token, `--color-ppp-${family} not found`).toBeDefined();
    // Guards the guard: if this stops failing, the pairing stopped being a bug
    // and the test should be revisited, not the numbers.
    expect(contrast(token, "#ffffff")).toBeLessThan(4.5);
    expect(offenders(family), `white on #${token} is ${contrast(token, "#ffffff").toFixed(2)}:1`).toEqual([]);
  });
});

describe("the hover ramp stays out of the dead zone", () => {
  it("blue-600 really is unusable with either text colour", () => {
    // The fact that justifies lightening rather than darkening. If a future
    // palette change fixes blue-600, the ramp choice can be revisited.
    const mid = TOKENS["--color-ppp-blue-600"];
    expect(contrast(mid, "#ffffff")).toBeLessThan(4.5);
    expect(contrast(mid, TOKENS["--color-ppp-navy"])).toBeLessThan(4.5);
  });

  it("navy clears AA at every state a brand-blue button passes through", () => {
    const navy = TOKENS["--color-ppp-navy"];
    for (const shade of ["--color-ppp-blue", "--color-ppp-blue-400", "--color-ppp-blue-300"]) {
      expect(contrast(TOKENS[shade], navy), `${shade} vs navy`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no brand-blue button darkens on hover into the dead zone", () => {
    const bad: string[] = [];
    const fill = /(?<![-\w])bg-ppp-blue(?![-\w])/;
    for (const f of FILES) {
      for (const [, cls] of readFileSync(f, "utf8").matchAll(/"([^"\n]*)"/g)) {
        if (!fill.test(cls)) continue;
        if (/(hover|active):bg-ppp-blue-(600|700|800|900)(?![-\w])/.test(cls)) {
          bad.push(`${f.replace(ROOT + "/", "")} :: ${cls.slice(0, 70)}`);
        }
      }
    }
    expect(bad, "these darken into blue-600+, where navy fails AA").toEqual([]);
  });
});
