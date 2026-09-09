import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

/**
 * One spelling, platform-wide: color and labor, never colour or labour.
 *
 * Karan 2026-09-09: "Labor and Color should be this spelling everywhere."
 *
 * It had drifted badly. Reports called its own screen "Labour & payroll" while
 * the route serving it was `/commercial/reports/labor`, and the CSV it exported
 * downloaded as `Labour_2026-08-01_to_2026-08-31.csv`. 419 occurrences across
 * 117 files — a handful of screen labels, and the rest comments and identifiers
 * that would have kept seeding the visible ones.
 *
 * A guard rather than a one-off fix, because a spelling sweep is exactly the
 * kind of thing that half-reverts: the next person writing a comment about a
 * colour form reintroduces it, and nothing notices until it reaches a label.
 *
 * `supabase/migrations/` is deliberately out of scope. Those files are a record
 * of what was already run against the database; editing one changes no schema
 * and rewrites history. Three still contain "colour" in their comments, and
 * that is correct.
 */
describe("American spelling, everywhere a person can read it", () => {
  it("no colour / labour in the source", () => {
    const hits = execSync(
      "grep -rniE 'colour|labour' app lib components __tests__ scripts docs || true",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      // This file names the misspellings in order to forbid them.
      .filter((l) => !l.startsWith("__tests__/ui/american-spelling.test.ts"));

    expect(
      hits,
      `British spelling is back. Karan asked for one spelling platform-wide:\n${hits
        .slice(0, 20)
        .join("\n")}`
    ).toEqual([]);
  });

  it("no filename carries it either", () => {
    // Two test files were named for it — a rename a text-only sweep misses.
    const files = execSync(
      "find app lib components __tests__ scripts docs \\( -iname '*colour*' -o -iname '*labour*' \\) || true",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);
    expect(files).toEqual([]);
  });

  it("the labor report agrees with its own route", () => {
    // The specific inconsistency that prompted this: the page said Labour, the
    // URL said labor. Assert the label, not just the absence of a spelling.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const src = readFileSync("app/commercial/reports/labor/page.tsx", "utf8");
    expect(src).toContain("Labor &amp; payroll");
  });
});
