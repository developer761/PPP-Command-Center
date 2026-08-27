import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `position: fixed` is relative to the viewport only while NO ancestor
 * establishes a containing block — and `transform`, `filter`, `backdrop-filter`,
 * `perspective`, `contain` and `will-change` all do. Every page shell here is
 * wrapped in `.animate-fade-up`, so a modal rendered inside the page tree gets
 * positioned against the PAGE: opened below the fold, it lands off-screen.
 *
 * Kate reported this in round 2 (#06), round 3 (#04) and round 4 (#11). Round 3
 * ended the keyframes on `transform: none`, which fixes the SETTLED state — but
 * not the 320ms the animation runs, and not a throttled background tab where
 * the animation never advances at all (measured in Chrome: currentTime stays 0
 * while playState reads "running"). A remount restarts it too.
 *
 * So the rule is structural, not cosmetic: a full-screen overlay must not
 * depend on its ancestors at all. This test fails the moment someone adds a new
 * `fixed inset-0` overlay without portalling it.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const ROOT = process.cwd();
// Commercial is a separate platform with its own session and conventions.
const files = [...walk(join(ROOT, "components")), ...walk(join(ROOT, "app"))].filter(
  (f) => !f.includes("/commercial/") && !f.includes("commercial-")
);

/**
 * Full-viewport overlays — the ones that break.
 *
 * Two spellings, both full-screen:
 *   · `fixed inset-0` — pinned to all four edges;
 *   · `fixed inset-x-0 top-0 h-dvh-full` — pinned to three and sized by dvh,
 *     which is what iOS Safari needs. `inset-0` measures the LAYOUT viewport
 *     there, so the strip behind the toolbars counts as page and a bottom-pinned
 *     footer lands below the visible screen.
 *
 * The second spelling is why this file's own guard fired: switching the measure
 * overlays to it dropped them out of the old regex, and the portal check would
 * have gone quietly vacuous. A `fixed` element pinned to fewer edges without a
 * full-height class is usually a sticky bar, which is unaffected.
 */
const OVERLAY = /className=\{?["'`][^"'`]*\bfixed\b[^"'`]*(\binset-0\b|\bh-dvh-full\b)/;

/** Strip comments: the first version of this test looked for the string
 *  "ModalPortal" anywhere in the file, and the comment EXPLAINING the rule
 *  satisfied it — so the guard passed against a deliberately un-portalled
 *  overlay. Check for the actual JSX element, in code only. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const USES_PORTAL = /<ModalPortal[\s>]/;

describe("full-screen overlays are portalled out of the page tree", () => {
  const offenders: Array<{ file: string; line: number }> = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!OVERLAY.test(src)) continue;
    // The shell's own mobile-drawer scrim is a sibling of the page content, not
    // a descendant of a page shell, so it has no transformed ancestor.
    if (file.endsWith("dashboard-chrome.tsx")) continue;
    if (!USES_PORTAL.test(codeOnly(src))) {
      const line = src.split("\n").findIndex((l) => OVERLAY.test(l)) + 1;
      offenders.push({ file: file.replace(ROOT + "/", ""), line });
    }
  }

  it("has no un-portalled overlay", () => {
    expect(
      offenders,
      "wrap these in <ModalPortal> — a transformed ancestor makes `fixed` " +
        "resolve against the page, so the dialog opens off-screen when scrolled"
    ).toEqual([]);
  });

  it("still finds the overlays it is meant to be checking", () => {
    // Guards the guard: if the regex stops matching, the test above passes
    // vacuously and the bug walks straight back in for a fourth round.
    const withOverlays = files.filter((f) => OVERLAY.test(readFileSync(f, "utf8")));
    expect(withOverlays.length).toBeGreaterThanOrEqual(2);

    // And prove BOTH spellings are still reachable, so a future sweep that
    // converts every overlay to one form can't half-blind this guard.
    const src = withOverlays.map((f) => readFileSync(f, "utf8"));
    expect(src.some((s) => /\bfixed\b[^"'`]*\binset-0\b/.test(s))).toBe(true);
    expect(src.some((s) => /\bfixed\b[^"'`]*\bh-dvh-full\b/.test(s))).toBe(true);
  });
});
