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
const SPLIT = css.indexOf('[data-theme="dark"] {');

function parse(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, k, v] of src.matchAll(/(--color-ppp-[a-z]+(?:-\d+)?)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[k] = v;
  return out;
}
const LIGHT = parse(css.slice(0, SPLIT));
const DARK_OVERRIDES = parse(css.slice(SPLIT));

/**
 * Dark REDEFINES the ramp, and in the 600-800 range it inverts the meaning:
 * a dark fill in light becomes a light FOREGROUND in dark. So any class that
 * hardcodes one text colour against those tokens is theme-dependent by
 * construction, and a check that reads only the light block cannot see it.
 *
 * That gap shipped two defects. `hover:bg-ppp-blue-400` measured 5.93 in light
 * and 3.60 in dark; `bg-ppp-orange-700 text-white` measured 6.20 in light and
 * 2.09 in dark — WORSE than the 3.19 the change set out to fix. Both are
 * invisible to a light-only parse, which is why every assertion below runs
 * against both palettes.
 */
const THEMES: Array<[string, Record<string, string>]> = [
  ["light", LIGHT],
  ["dark", { ...LIGHT, ...DARK_OVERRIDES }],
];
const TOKENS = LIGHT;

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

  it.each(THEMES)("navy clears AA at every brand-blue button state (%s)", (_theme, T) => {
    const navy = T["--color-ppp-navy"];
    // blue-400 is deliberately NOT in this list — dark redefines it to #3F88B0
    // where navy is 3.60. blue-300 is never overridden, so it holds in both.
    for (const shade of ["--color-ppp-blue", "--color-ppp-blue-300"]) {
      expect(contrast(T[shade], navy), `${shade} vs navy`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)("every fill that carries text still carries it in %s", (_theme, T) => {
    // The pairings this codebase actually ships, checked against BOTH palettes.
    const pairs: Array<[string, string]> = [
      ["--color-ppp-blue", "--color-ppp-navy"],
      ["--color-ppp-blue-300", "--color-ppp-navy"],
      ["--color-ppp-green", "--color-ppp-navy"],
      ["--color-ppp-orange-700", "--color-ppp-orange-50"],
    ];
    for (const [fill, text] of pairs) {
      expect(contrast(T[fill], T[text]), `${fill} + ${text}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  /**
   * Pre-existing pairings, from before this rule existed. They are INERT, not
   * fine: `data-theme="dark"` is set only on the Commercial layout wrapper, and
   * none of these files is imported by Commercial, so their dark values are
   * unreachable today. Churning working light-mode buttons for a theme that
   * cannot render them would be motion, not a fix.
   *
   * This list must only ever SHRINK. Anything new fails the assertion below.
   * If residential ever gains a theme toggle, every entry here becomes live and
   * has to be repaired first — that is the moment to spend the churn.
   */
  const INERT_PREEXISTING = new Set([
    "components/customer-form-view.tsx :: bg-ppp-blue-700",
    "components/customer-form-view.tsx :: bg-ppp-blue-800",
    "components/email-password-sign-in.tsx :: bg-ppp-navy-600",
    "components/email-password-sign-in.tsx :: bg-ppp-navy-700",
    "components/materials-view.tsx :: bg-ppp-blue-600",
    "components/materials-view.tsx :: bg-ppp-blue-700",
    "components/materials-view.tsx :: bg-ppp-green-600",
    "components/materials-view.tsx :: bg-ppp-green-700",
    "components/order-builder-view.tsx :: bg-ppp-blue-600",
    "components/order-builder-view.tsx :: bg-ppp-green-600",
    "components/order-builder-view.tsx :: bg-ppp-green-700",
    "components/settings/access-manager.tsx :: bg-ppp-blue-700",
  ]);

  it("a pressed button still looks different from a hovered one", () => {
    // Only blue / blue-300 / blue-900 survive both themes, and navy fails on
    // blue-900 (1.21), so there are exactly two usable fills for three states.
    // Collapsing hover and active onto the same one is an easy accident — the
    // contrast assertions all still pass, and the button silently stops
    // acknowledging a press. Rest → hover lightens → press settles back.
    const bad: string[] = [];
    for (const f of FILES) {
      for (const [, cls] of readFileSync(f, "utf8").matchAll(/"([^"\n]*)"/g)) {
        // Capture the opacity modifier too. `hover:bg-ppp-blue-50/40` and
        // `active:bg-ppp-blue-50` share a token but differ visibly — 40% vs
        // 100% — so stripping the `/40` reports a false positive on list rows
        // that are behaving correctly.
        const hover = cls.match(/hover:bg-(ppp-blue(?:-\d+)?(?:\/\d+)?)(?![-\w])/)?.[1];
        const active = cls.match(/active:bg-(ppp-blue(?:-\d+)?(?:\/\d+)?)(?![-\w])/)?.[1];
        if (hover && active && hover === active) {
          bad.push(`${f.replace(ROOT + "/", "")} :: hover and active both ${hover}`);
        }
      }
    }
    expect(bad, "pressing these gives no visual feedback").toEqual([]);
  });

  it("no NEW class pairs a fill with white where dark inverts that fill", () => {
    // The orange-700 regression in one rule: a token dark turns into a
    // foreground must never be a fill under hardcoded white.
    const inverting = Object.keys(DARK_OVERRIDES).filter((k) => /-([6-9]00)$/.test(k));
    expect(inverting.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of FILES) {
      for (const [, cls] of readFileSync(f, "utf8").matchAll(/"([^"\n]*)"/g)) {
        if (!/(?<![-\w:])text-white(?![-\w])/.test(cls)) continue;
        for (const tok of inverting) {
          const cn = "bg-" + tok.replace("--color-", "");
          if (new RegExp(String.raw`(?<![-\w])${cn}(?![-\w])`).test(cls)) {
            bad.push(`${f.replace(ROOT + "/", "")} :: ${cn}`);
          }
        }
      }
    }
    const fresh = bad.filter((b) => !INERT_PREEXISTING.has(b));
    expect(fresh, "dark turns these fills into foregrounds — white becomes unreadable").toEqual([]);
    // The allowlist must only shrink: a stale entry means someone fixed one and
    // left the exemption behind, which quietly re-opens the door.
    const stale = [...INERT_PREEXISTING].filter((e) => !bad.includes(e));
    expect(stale, "fixed — remove from INERT_PREEXISTING").toEqual([]);
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
