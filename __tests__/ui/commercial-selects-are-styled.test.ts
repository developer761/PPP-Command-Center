import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No `<select>` on the Commercial platform may ship with the browser's own
 * dropdown chrome.
 *
 * Karan has now flagged the grey native select FOUR times. Three of those
 * produced `lib/commercial/form-classnames.ts` — one styled contract,
 * `appearance-none` plus a painted chevron — and the fourth happened anyway,
 * on a brand-new filter bar that wrapped a bare `<select>` in a nice border.
 * That is the trap: the border looks right in the JSX, and the browser paints
 * its grey control INSIDE it.
 *
 * So the rule stops being something to remember. A file that renders a
 * `<select>` must also carry `appearance-none` — directly, or via one of the
 * shared class constants.
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

/** Commercial surfaces only — the residential Command Center has its own
 *  filter chrome (`lib/ui/filter-chrome.ts`) and its own conventions. */
const files = [
  ...walk(join(ROOT, "components", "commercial")),
  ...walk(join(ROOT, "app", "commercial")),
];

/** The shared constants all imply `appearance-none`. */
const STYLED_MARKERS = [
  "appearance-none",
  "SELECT_CLS",
  "FILTER_SELECT_CLS",
];

describe("every Commercial <select> drops the OS chrome", () => {
  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no bare native select", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      // Comments FIRST. Two of these files document the rule by writing
      // "no native <select>" in prose, and a scanner that counts prose finds
      // its loudest offenders among the people who already agreed with it.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // `<select` followed by whitespace or `>` — the JSX element, not the word
      // "select" in prose or a Supabase `.select(`.
      if (!/<select[\s>]/.test(src)) continue;
      if (STYLED_MARKERS.some((m) => raw.includes(m))) continue;
      offenders.push(f.replace(`${ROOT}/`, ""));
    }
    expect(offenders, `Bare <select> — use SELECT_CLS/FILTER_SELECT_CLS from lib/commercial/form-classnames`).toEqual([]);
  });
});
