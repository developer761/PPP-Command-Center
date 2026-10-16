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
 * color mid-press on every primary button.
 *
 * So: navy on the brand fill, and hover/active go LIGHTER. Contrast improves as
 * you interact instead of collapsing, one text color holds throughout, and
 * #2BAAE1 stays exactly the 2023 brand-deck primary at rest — which is what
 * anyone actually looks at.
 *
 * The three orange sites are badges and a banner with no hover state at all, so
 * they just needed a fill dark enough for white: orange-700 at 6.2:1.
 */

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const SPLIT = css.indexOf('[data-theme="dark"] {');

/**
 * Every `--color-*` token, not just `--color-ppp-*`.
 *
 * The narrow version could not see `--color-cc-brand-*` at all, which is the
 * entire accent ramp of the Commercial platform — so once Commercial was let
 * into the walk (below) the scanner would have read its primary button as a
 * fill with no known color and skipped it. Same silence, one level deeper.
 */
function parse(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, k, v] of src.matchAll(/(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[k] = v;
  return out;
}
const LIGHT = parse(css.slice(0, SPLIT));
const DARK_OVERRIDES = parse(css.slice(SPLIT));

/**
 * Dark REDEFINES the ramp, and in the 600-800 range it inverts the meaning:
 * a dark fill in light becomes a light FOREGROUND in dark. So any class that
 * hardcodes one text color against those tokens is theme-dependent by
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
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * ─── WHY THERE ARE TWO LISTS, AND WHY COMMERCIAL IS NOW IN ONE ────────────
 *
 * Until 2026-10-16 the walk read `if (full.includes("commercial")) continue;`
 * — "separate platform, own session". The effect of that line was not
 * neutrality. Residential reports ZERO sub-AA pairs because every assertion
 * below has been grinding it down for months; Commercial reported zero
 * because nothing ever looked. 488 pairs were sitting behind it, including a
 * primary button at 3.66:1 AT REST in light on 172 class strings, a hover
 * state at 2.43:1 in dark on 129, and a prevailing-wage badge at 1.14:1 in
 * dark — the pay-rate flag a crew member reads on a phone, in the dark theme
 * Commercial is the ONLY platform that actually sets.
 *
 * Commercial is also the one platform where `data-theme="dark"` is live, so
 * its dark-mode numbers are not hypothetical the way the residential
 * INERT_PREEXISTING list below is.
 *
 * The two lists stay separate because the assertions differ: residential's
 * floor is ZERO new offenders of any shape, and Commercial's is a RATCHET
 * (see the bottom of this file) against a 488-pair baseline that may only go
 * down. Mixing them would either exempt residential or turn Commercial's
 * backlog into 488 unrelated failures on somebody else's first commit.
 *
 * The split is by WHICH PLATFORM RENDERS THE FILE, not by directory, because
 * the old skip tested directories only and `components/commercial-*.tsx` — a
 * dozen files at the top level, mounted exclusively under /commercial — fell
 * on the residential side of it. They are Commercial: they render inside the
 * one layout on the platform that sets `data-theme`, so their dark values are
 * live, not hypothetical.
 */
const isCommercial = (f: string) =>
  f.includes("/commercial/") || /\/components\/commercial-[^/]+\.tsx$/.test(f);

const ALL_TSX = [...walk(join(ROOT, "components")), ...walk(join(ROOT, "app"))];
const FILES = ALL_TSX.filter((f) => !isCommercial(f));
const COMMERCIAL_FILES = ALL_TSX.filter(isCommercial);

/**
 * Every class string in a file — double-quoted AND template-literal.
 *
 * This used to read `"..."` only. A className written as a template literal
 * to toggle one class (`className={`bg-ppp-blue-700 ... ${x ? "a" : ""}`}`)
 * became invisible, so the button kept its white-on-blue fill and the
 * scanner stopped reporting it — and the stale-exemption check then said the
 * problem was FIXED. Blinding a guard reads exactly like passing it.
 *
 * `${...}` holes are replaced with a space rather than dropped, so classes
 * either side of an interpolation never fuse into one invented token.
 */
function classStrings(src: string): string[] {
  const out: string[] = [];
  for (const [, cls] of src.matchAll(/"([^"\n]*)"/g)) out.push(cls);
  for (const [, raw] of src.matchAll(/`([^`]*)`/g)) {
    out.push(raw.replace(/\$\{[^}]*\}/g, " ").replace(/\s+/g, " "));
  }
  return out;
}

/**
 * Read a file and scan it, saying WHICH file if that goes wrong.
 *
 * Two sessions share this working tree, and this is one of the few tests that
 * reads source off disk rather than importing it — so it can catch a file
 * mid-save. On 2026-10-15 it did: nine tests in here failed together with
 * `RangeError: Maximum call stack size exceeded`, and the stack named only
 * `classStrings` itself, which contains no recursion. Unreproducible minutes
 * later, and not reproducible from file content either (a giant template
 * literal, an unbalanced backtick, 120k interpolations — all scan fine).
 *
 * So the cause is not established, and this does not pretend to fix it. It
 * makes the next occurrence say which file was being read, which is the one
 * thing the failure could not tell us. The guard is unchanged: the error is
 * re-thrown, never swallowed — a scanner that quietly skipped a file it could
 * not parse would report a clean pass over code it never looked at.
 */
function scan(file: string): string[] {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`could not read ${file.replace(ROOT + "/", "")}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return classStrings(src);
  } catch (err) {
    throw new Error(
      `scanning ${file.replace(ROOT + "/", "")} (${src.length} bytes) failed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `If another session is mid-save in this shared tree, re-run before believing it.`,
    );
  }
}

/** Class strings pairing an exact brand-token fill with white text. */
function offenders(family: "blue" | "orange" | "green"): string[] {
  const fill = new RegExp(String.raw`(?<![-\w])bg-ppp-${family}(?![-\w])`);
  const hits: string[] = [];
  for (const f of FILES) {
    for (const [, cls] of scan(f).map((c) => [null, c] as const)) {
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
  it("blue-600 really is unusable with either text color", () => {
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
  const INERT_PREEXISTING = new Set<string>([
    "components/customer-form-view.tsx :: bg-ppp-blue-700",
    "components/customer-form-view.tsx :: bg-ppp-blue-800",
    "components/email-password-sign-in.tsx :: bg-ppp-navy-600",
    "components/email-password-sign-in.tsx :: bg-ppp-navy-700",
    "components/settings/access-manager.tsx :: bg-ppp-blue-700",
    /**
     * Added 2026-10-16, same cause as the cc-solid work: `parse` was widened
     * from `--color-ppp-*` to every `--color-*`, so emerald and cc-brand
     * entered the inverting set for the first time. These were never passing
     * this rule — they were never ASKED. Same inert status as the five above:
     * neither Settings → Writeback nor the signature portal is under
     * /commercial, and `data-theme` is set in exactly one place
     * (app/commercial/layout.tsx), so the dark values are unreachable today.
     *
     * emerald-700 → #78b498 and emerald-800 → #a1cdb8 in dark; cc-brand-700
     * → #74aecb, -800 → #9dc6db. White on any of them is ~2.1-2.5:1. If
     * residential ever gains a theme toggle these go live and must be fixed
     * before it ships.
     */
    "app/dashboard/settings/writeback/page.tsx :: bg-emerald-600",
    "app/dashboard/settings/writeback/page.tsx :: bg-emerald-700",
    "app/dashboard/settings/writeback/page.tsx :: bg-emerald-800",
    "app/dashboard/settings/writeback/tomco/page.tsx :: bg-cc-brand-700",
    "app/dashboard/settings/writeback/tomco/page.tsx :: bg-cc-brand-800",
  ]);

  it("a pressed button still looks different from a hovered one", () => {
    // Only blue / blue-300 / blue-900 survive both themes, and navy fails on
    // blue-900 (1.21), so there are exactly two usable fills for three states.
    // Collapsing hover and active onto the same one is an easy accident — the
    // contrast assertions all still pass, and the button silently stops
    // acknowledging a press. Rest → hover lightens → press settles back.
    const bad: string[] = [];
    for (const f of FILES) {
      for (const [, cls] of scan(f).map((c) => [null, c] as const)) {
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

  it("no fill carrying white text fails in LIGHT, whatever dark does to it", () => {
    // I filed twelve sites as "inert — only broken in dark". Four of them were
    // failing in LIGHT as well: bg-ppp-blue-600 at 3.66 and bg-ppp-green-600 at
    // 3.12, both as RESTING fills on buttons residential shows every day. The
    // dark-inversion rule looked past them because it only asked what dark did.
    // Two independent questions, two assertions.
    const bad: string[] = [];
    for (const f of FILES) {
      for (const [, cls] of scan(f).map((c) => [null, c] as const)) {
        if (!/(?<![-\w:])text-white(?![-\w])/.test(cls)) continue;
        for (const [tok, hex] of Object.entries(LIGHT)) {
          const cn = "bg-" + tok.replace("--color-", "");
          // Resting fills only — a hover/active shade is a separate question.
          if (!new RegExp(String.raw`(?<![-\w:])${cn}(?![-\w])`).test(cls)) continue;
          if (contrast(hex, "#ffffff") < 4.5) {
            bad.push(`${f.replace(ROOT + "/", "")} :: ${cn} (${contrast(hex, "#ffffff").toFixed(2)}:1)`);
          }
        }
      }
    }
    /**
     * EMPTY, and that is the point — it held one entry and the entry is fixed.
     *
     * The site was the GC e-signature portal, surfaced on 2026-10-16 the
     * moment `parse` learned to read `--color-cc-*` tokens. Before that,
     * cc-brand-600 was not a color this file knew, so the pairing could not be
     * measured and the suite was green over it. app/sign/[token] is NOT under
     * /commercial and does not set `data-theme`, so it missed both the
     * commercial ratchet and the dark rules — a public, customer-facing page
     * at 3.66:1, on the one button a GC presses to download what they are
     * about to sign. Now `bg-cc-solid-600` / `hover:bg-cc-solid-700`, 5.24:1
     * and 7.72:1, identical in both themes.
     *
     * It stays as an empty Set rather than being deleted so the next light-mode
     * failure has somewhere to be recorded, and so the second assertion keeps
     * refusing a stale entry. Must only SHRINK.
     */
    const LIGHT_PREEXISTING = new Set<string>([]);
    expect(
      bad.filter((b) => !LIGHT_PREEXISTING.has(b)),
      "white on these resting fills fails AA in the light theme",
    ).toEqual([]);
    expect(
      [...LIGHT_PREEXISTING].filter((e) => !bad.includes(e)),
      "fixed — remove from LIGHT_PREEXISTING",
    ).toEqual([]);
  });

  it("text on a dark scrim is actually readable", () => {
    // The gap that let a broken pill through with a green suite: every rule
    // above asks about `bg-ppp-*` under `text-white`, and none asks about
    // `text-ppp-*` on a `bg-black/N` scrim. Overlays on camera video use
    // exactly that pairing, because video has no theme to inherit.
    //
    // The PPP orange ramp is NOT monotonic — 100 is pale, 200 and 300 are dark
    // browns, 800 and 900 are pale again — so "a low number is light" reasoning
    // silently picks an unreadable color. text-ppp-orange-200 on black is
    // 1.64:1; it looked plausible and shipped past every other assertion here.
    const bad: string[] = [];
    for (const f of FILES) {
      for (const [, cls] of scan(f).map((c) => [null, c] as const)) {
        const scrim = cls.match(/(?<![-\w:])bg-black\/\[?\.?(\d+)/);
        if (!scrim) continue;
        const fg = cls.match(/(?<![-\w:])text-(ppp-[a-z]+(?:-\d+)?)(?![-\w])/)?.[1];
        if (!fg) continue;
        const hex = LIGHT["--color-" + fg];
        if (!hex) {
          // NOT a skip. A token absent from the light theme is defined only in
          // the dark block, so in light mode the custom property resolves to
          // nothing and the text silently inherits whatever it is sitting on.
          // Skipping here is what made the first version of this guard vacuous:
          // text-ppp-orange-200 is dark-only, so the lookup came back undefined
          // and the broken pill sailed through a green suite.
          bad.push(`${f.replace(ROOT + "/", "")} :: text-${fg} is not defined in the light theme`);
          continue;
        }
        // A heavy scrim over arbitrary video is effectively near-black.
        const r = contrast(hex, "#0a0a0a");
        if (r < 4.5) bad.push(`${f.replace(ROOT + "/", "")} :: text-${fg} on black scrim (${r.toFixed(2)}:1)`);
      }
    }
    expect(bad, "this text is unreadable on the scrim it sits on").toEqual([]);
  });

  it("every ppp color utility refers to a token that actually exists", () => {
    // Tailwind generates a utility only for tokens declared in `@theme`. Eight
    // brand tokens (orange 200/300/400/800/900, green 200/300/800) are declared
    // ONLY inside the [data-theme="dark"] rule, which is far below @theme — so
    // classes naming them compile to nothing at all. Not a contrast problem: no
    // rule is emitted, the property is never set, and the element silently
    // inherits. A border falls back to currentColor and a background vanishes.
    //
    // This is why the scrim guard above must treat an unknown token as a
    // failure rather than skipping it — skipping is exactly what let a dead
    // class through a fully green suite.
    const bad: string[] = [];
    for (const f of FILES) {
      for (const [, cls] of scan(f).map((c) => [null, c] as const)) {
        for (const [, prefix, tok] of cls.matchAll(
          /(?<![-\w])(?:hover:|active:|focus:|group-hover:|dark:|sm:|md:|lg:)*(text|bg|border|ring|from|to|via|decoration|outline|divide|shadow|accent|caret|fill|stroke)-(ppp-[a-z]+(?:-\d+)?)(?![-\w])/g
        )) {
          if (!(("--color-" + tok) in LIGHT)) {
            bad.push(`${f.replace(ROOT + "/", "")} :: ${prefix}-${tok}`);
          }
        }
      }
    }
    expect([...new Set(bad)], "these classes generate no CSS — the token is dark-only").toEqual([]);
  });

  /**
   * The same check over Commercial. It used to end
   * `.filter((b) => !b.includes("commercial"))` — which was dead code anyway,
   * since the walk had already dropped every commercial directory before the
   * filter ran. Two guards for one platform, neither of them looking.
   *
   * Commercial had exactly two, both in the green family, both dark-only
   * declarations that Tailwind therefore never emits a utility for:
   * `text-ppp-green-800` on the Field Ops "clocked in" chip (fixed — green-700
   * is declared in @theme AND remapped for dark: 4.58 light / 9.03 dark) and
   * the one below.
   *
   * This list may only SHRINK.
   */
  const COMMERCIAL_DEAD_TOKENS = new Set<string>([
    // `--color-ppp-green-200` exists only inside [data-theme="dark"], so this
    // border renders as currentColor in both themes. Outside this session's
    // file allowlist — left listed rather than silently dropped.
  ]);

  it("no commercial class names a token Tailwind never emits", () => {
    const bad: string[] = [];
    for (const f of COMMERCIAL_FILES) {
      for (const cls of scan(f)) {
        for (const [, prefix, tok] of cls.matchAll(
          /(?<![-\w])(?:hover:|active:|focus:|group-hover:|dark:|sm:|md:|lg:)*(text|bg|border|ring|from|to|via|decoration|outline|divide|shadow|accent|caret|fill|stroke)-((?:ppp|cc)-[a-z]+(?:-\d+)?)(?![-\w])/g
        )) {
          if (!(("--color-" + tok) in LIGHT)) bad.push(`${f.replace(ROOT + "/", "")} :: ${prefix}-${tok}`);
        }
      }
    }
    const found = [...new Set(bad)];
    expect(
      found.filter((b) => !COMMERCIAL_DEAD_TOKENS.has(b)),
      "these classes generate no CSS — the token is declared only in the dark block",
    ).toEqual([]);
    expect(
      [...COMMERCIAL_DEAD_TOKENS].filter((e) => !found.includes(e)),
      "fixed — remove from COMMERCIAL_DEAD_TOKENS",
    ).toEqual([]);
  });

  it("no NEW class pairs a fill with white where dark inverts that fill", () => {
    // The orange-700 regression in one rule: a token dark turns into a
    // foreground must never be a fill under hardcoded white.
    // A token the dark block RE-DECLARES AT THE SAME VALUE has not inverted —
    // it has been pinned on purpose, which is exactly what --color-cc-solid-*
    // and the forest solids are for. Listing those as "inverting" would make
    // this rule condemn the one pattern that fixes it.
    const inverting = Object.keys(DARK_OVERRIDES).filter(
      (k) => /-([6-9]00)$/.test(k) && DARK_OVERRIDES[k] !== LIGHT[k],
    );
    expect(inverting.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of FILES) {
      for (const [, cls] of scan(f).map((c) => [null, c] as const)) {
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
      for (const [, cls] of scan(f).map((c) => [null, c] as const)) {
        if (!fill.test(cls)) continue;
        if (/(hover|active):bg-ppp-blue-(600|700|800|900)(?![-\w])/.test(cls)) {
          bad.push(`${f.replace(ROOT + "/", "")} :: ${cls.slice(0, 70)}`);
        }
      }
    }
    expect(bad, "these darken into blue-600+, where navy fails AA").toEqual([]);
  });
});

/**
 * ─── COMMERCIAL: a ratchet, not an exemption ──────────────────────────────
 *
 * Commercial carries 488 explicit foreground/background pairs below 4.5:1,
 * counted across BOTH themes from the token values in app/globals.css. That
 * number is not going to zero in one pass, and pretending otherwise by
 * leaving the platform out of the walk is what produced it.
 *
 * So the baseline below is the shape of every failure that existed on
 * 2026-10-16, with its count. A shape that grows fails. A shape that is not
 * listed fails on its first occurrence. A shape that shrinks fails too, with
 * "lower this number" — a stale entry re-opens that many slots in silence.
 *
 * TWO SHAPES ARE 61% OF IT, and both have the same cause: in this palette
 * -700 and -800 are TEXT roles that invert for dark, so using them as button
 * fills makes the fill a foreground in one theme.
 *
 *     bg-cc-brand-600 + text-white        3.66:1  LIGHT  × 172
 *     hover:bg-cc-brand-700 + text-white  2.43:1  DARK   × 129
 *
 * The fix for both is `--color-cc-solid-600/-700`, added to globals.css the
 * same day: pinned to #15749c / #0f5978 in the @theme block AND in the dark
 * block, so white measures 5.24 / 7.72 in both themes. Nine sites moved
 * across in this pass; the rest is a mechanical swap,
 *
 *     bg-cc-brand-600 text-white      →  bg-cc-solid-600 text-white
 *     hover:bg-cc-brand-700           →  hover:bg-cc-solid-700
 *     active:bg-cc-brand-800          →  active:bg-cc-solid-700
 *
 * done ONLY where the class string also carries `text-white`. cc-brand-600/
 * -700 remain correct for borders, rings, accent text and the active-nav
 * label, where the dark inversion is wanted.
 *
 * WHAT THIS STILL CANNOT SEE, stated so nobody trusts it for more than it
 * does:
 *   · a foreground that is INHERITED rather than written in the same class
 *     string — the pair has to be spelled out in one string to be measured;
 *   · the Tailwind stock families (amber / emerald / rose / teal / slate),
 *     whose light values live in Tailwind, not in globals.css. `bg-amber-500
 *     text-white` is 2.15:1 in light and is NOT counted here;
 *   · opacity modifiers (`bg-cc-brand-600/40`), which are skipped rather
 *     than guessed at;
 *   · anything composed at runtime from a variable.
 */
const COMMERCIAL_BASELINE = new Map<string, number>([
  ["dark | active:bg-cc-brand-700 + text-white", 1],
  ["dark | active:bg-cc-brand-800 + text-white", 23],
  ["dark | active:bg-ppp-blue-200 + text-ppp-navy", 1],
  ["dark | active:bg-ppp-blue-800 + text-white", 3],
  ["dark | bg-cc-brand-600 + text-cc-brand-700", 1],
  ["dark | bg-cc-brand-600 + text-ppp-charcoal-600", 2],
  ["dark | bg-cc-brand-700 + text-ppp-charcoal-600", 2],
  ["dark | bg-ppp-blue-50 + text-ppp-blue-900", 1],
  ["dark | bg-ppp-blue-600 + text-ppp-charcoal-600", 3],
  ["dark | bg-ppp-blue-700 + text-ppp-charcoal-600", 3],
  ["dark | bg-ppp-charcoal + text-white", 2],
  ["dark | bg-ppp-charcoal-100 + text-ppp-charcoal-400", 5],
  // The prevailing-wage "PW" badge at 1.14:1 — #172b4d on #34343c. Four of
  // the seven were in this session's file allowlist and now read
  // text-ppp-navy-700 (5.78 dark / 11.20 light). These three are the field-ops
  // status board, the jobs list and the proposal line-item chip.
  ["dark | bg-ppp-charcoal-200 + text-ppp-charcoal-500", 1],
  ["dark | bg-ppp-green-600 + text-white", 1],
  ["dark | bg-ppp-navy-600 + text-white", 1],
  ["dark | bg-ppp-navy-700 + text-white", 2],
  ["dark | hover:bg-cc-brand-600 + text-cc-brand-700", 1],
  ["dark | hover:bg-cc-brand-700 + text-white", 129],
  ["dark | hover:bg-ppp-blue-700 + text-white", 15],
  ["dark | hover:bg-ppp-blue-800 + text-white", 1],
  ["dark | hover:bg-ppp-charcoal-100 + text-ppp-charcoal-400", 2],
  ["dark | hover:bg-ppp-charcoal-50 + text-cc-brand-600", 1],
  ["dark | hover:bg-ppp-charcoal-800 + text-ppp-charcoal-400", 1],
  ["dark | hover:bg-ppp-charcoal-800 + text-white", 1],
  ["dark | hover:bg-ppp-green-700 + text-white", 1],
  ["dark | hover:bg-ppp-navy-700 + text-white", 1],
  ["light | active:bg-ppp-blue-100 + text-ppp-blue", 1],
  ["light | active:bg-cc-brand-100 + text-ppp-charcoal-500", 1],
  ["light | bg-cc-brand-100 + text-cc-brand-700", 7],
  ["light | bg-cc-brand-600 + text-cc-brand-700", 1],
  ["light | bg-cc-brand-600 + text-ppp-charcoal-600", 2],
  ["light | bg-cc-brand-600 + text-white", 172],
  ["light | bg-cc-brand-700 + text-ppp-charcoal-600", 2],
  ["light | bg-ppp-blue-100 + text-ppp-blue-700", 2],
  ["light | bg-ppp-blue-50 + text-ppp-blue", 1],
  ["light | bg-ppp-blue-600 + text-ppp-charcoal-600", 3],
  ["light | bg-ppp-blue-600 + text-white", 18],
  ["light | bg-ppp-blue-700 + text-ppp-charcoal-600", 3],
  ["light | bg-ppp-charcoal-100 + text-ppp-charcoal-400", 5],
  ["light | bg-ppp-charcoal-100 + text-ppp-charcoal-500", 11],
  ["light | bg-ppp-charcoal-200 + text-ppp-charcoal-500", 1],
  ["light | bg-ppp-charcoal-200 + text-ppp-charcoal-600", 1],
  ["light | bg-ppp-charcoal-50 + text-ppp-charcoal-400", 10],
  ["light | bg-ppp-green-600 + text-white", 1],
  ["light | group-hover:bg-cc-brand-100 + text-cc-brand-700", 1],
  ["light | hover:bg-cc-brand-100 + text-cc-brand-700", 8],
  ["light | hover:bg-cc-brand-50 + text-ppp-charcoal-400", 3],
  ["light | hover:bg-cc-brand-600 + text-cc-brand-700", 1],
  ["light | hover:bg-cc-brand-600 + text-white", 3],
  ["light | hover:bg-ppp-blue-100 + text-ppp-blue-700", 3],
  ["light | hover:bg-ppp-blue-50 + text-ppp-blue", 1],
  ["light | hover:bg-ppp-charcoal-100 + text-ppp-charcoal-400", 2],
  ["light | hover:bg-ppp-charcoal-100 + text-ppp-charcoal-500", 6],
  ["light | hover:bg-ppp-charcoal-50 + text-cc-brand-600", 1],
  ["light | hover:bg-ppp-charcoal-50 + text-ppp-charcoal-400", 5],
  ["light | hover:bg-ppp-charcoal-800 + text-ppp-charcoal-400", 1],
  ["light | hover:bg-ppp-green-100 + text-ppp-green-700", 3],
]);

type CcHit = { shape: string; where: string; ratio: number };

function commercialSubAA(): { hits: CcHit[]; pairsMeasured: number } {
  const hits: CcHit[] = [];
  let pairsMeasured = 0;
  for (const f of COMMERCIAL_FILES) {
    const rel = f.replace(ROOT + "/", "");
    for (const cls of scan(f)) {
      const white = /(?<![-\w:])text-white(?![-\w])/.test(cls);
      const fgTok = cls.match(/(?<![-\w:])text-((?:ppp|cc)-[a-z]+(?:-\d+)?)(?![-\w])/)?.[1];
      if (!white && !fgTok) continue;
      // `(?![-\w/])` drops `bg-cc-brand-600/40` — an opacity modifier composites
      // against whatever is behind it, and guessing that backdrop would invent
      // a number. Skipped loudly here rather than measured wrongly.
      for (const [, state, bgTok] of cls.matchAll(
        /(?<![-\w])(hover:|active:|focus:|focus-visible:|group-hover:)?bg-((?:ppp|cc)-[a-z]+(?:-\d+)?)(?![-\w/])/g,
      )) {
        for (const [themeName, T] of THEMES) {
          const bg = T["--color-" + bgTok];
          const fg = white ? "#ffffff" : T["--color-" + fgTok!];
          if (!bg || !fg) continue;
          pairsMeasured++;
          const r = contrast(fg, bg);
          if (r >= 4.5) continue;
          hits.push({
            shape: `${themeName} | ${state ?? ""}bg-${bgTok} + ${white ? "text-white" : "text-" + fgTok}`,
            where: `${rel} (${r.toFixed(2)}:1)`,
            ratio: r,
          });
        }
      }
    }
  }
  return { hits, pairsMeasured };
}

describe("commercial contrast ratchet", () => {
  const { hits, pairsMeasured } = commercialSubAA();
  const actual = new Map<string, number>();
  for (const h of hits) actual.set(h.shape, (actual.get(h.shape) ?? 0) + 1);

  it("no NEW sub-AA pairing, and no more of an existing one", () => {
    const fresh: string[] = [];
    for (const [shape, n] of actual) {
      const allowed = COMMERCIAL_BASELINE.get(shape) ?? 0;
      if (n <= allowed) continue;
      const where = [...new Set(hits.filter((h) => h.shape === shape).map((h) => h.where))].slice(0, 6);
      fresh.push(`${shape} — ${n} now, ${allowed} allowed. e.g. ${where.join(", ")}`);
    }
    expect(
      fresh.sort(),
      "\nWhite on a fill needs 4.5:1 in BOTH themes. For a solid button use " +
        "bg-cc-solid-600 / hover:bg-cc-solid-700 — pinned in both blocks.\n" +
        fresh.join("\n") +
        "\n",
    ).toEqual([]);
  });

  it("the baseline only ever shrinks", () => {
    const stale: string[] = [];
    for (const [shape, n] of COMMERCIAL_BASELINE) {
      const now = actual.get(shape) ?? 0;
      if (now < n) stale.push(`${shape} — fixed ${n - now}; set it to ${now}${now === 0 ? " (delete the line)" : ""}`);
    }
    expect(stale.sort(), `\n${stale.join("\n")}\n`).toEqual([]);
  });

  it("is actually measuring commercial", () => {
    // Every one of these has been zero at some point in this file's history
    // while the suite stayed green, which is the only reason they are asserted.
    expect(COMMERCIAL_FILES.length, "no commercial files walked").toBeGreaterThan(100);
    expect(pairsMeasured, "no fg/bg pair resolved to two real hex values").toBeGreaterThan(1500);
    expect(hits.length, "zero sub-AA hits means the contrast maths stopped running").toBeGreaterThan(300);
    // And the token that the fix depends on has to exist in BOTH blocks, or
    // the advice in the failure message above is a lie.
    for (const [themeName, T] of THEMES) {
      for (const tok of ["--color-cc-solid-600", "--color-cc-solid-700"]) {
        expect(T[tok], `${tok} missing in ${themeName}`).toBeDefined();
        expect(contrast(T[tok], "#ffffff"), `white on ${tok} in ${themeName}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
