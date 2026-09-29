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

  /**
   * The rest of the British vocabulary — "fulfilment", "recognised",
   * "behaviour", "catalogue", "centre", "grey" and the -ise verbs.
   *
   * Karan, 2026-09-29: "not british anymore." 591 of these were in the source;
   * the paint tool's 94 are fixed and this stops them coming back. It is
   * SCOPED to the paths below rather than the whole repo on purpose: the
   * Commercial and messaging areas hold the remaining ~460 and belong to other
   * sessions working in this same tree. Widening the net before they are
   * cleaned would turn one shared CI red for everybody, which is how a
   * standard gets abandoned rather than adopted. Add paths here as each area
   * is cleaned.
   */
  const PAINT_TOOL_PATHS = [
    "lib/supplier-order", "lib/customer-form", "lib/materials", "lib/rooms",
    "components/order-builder-view.tsx", "components/order-fulfillment-view.tsx",
    "components/customer-form-view.tsx", "components/materials-view.tsx",
    "components/material-type-picker.tsx",
    "__tests__/supplier-order", "__tests__/customer-form",
    "app/api/customer-form", "app/api/admin/supplier-order",
  ].join(" ");

  const BRITISH = [
    "behaviours?", "recognis(e|ed|es|ing|able)", "greys?", "centres?", "fulfilment",
    "catalogues?", "defence", "licence",
    // NOT "moulding". PPP's own prose says molding, but the surface matcher in
    // recommended-finish.ts has to recognize a Salesforce label typed either
    // way — same reason "fulfilled" is left out below. A word we MATCH is not
    // a word we WRITE.
    // The bare verb. Not "fulfilled" — that is Promise.allSettled's own
    // status string and appears all over the API routes.
    "fulfil", "fulfils", "fulfilling",
    // -ise where American takes -ize. Spelled out rather than one loose
    // pattern, because "analysis", "emphasis" and "realistic" are not
    // misspellings and a lazy regex flags all three.
    "optimis(e|ed|es|ing|ation)", "normalis(e|ed|es|ing|ation)", "summaris(e|ed|es|ing)",
    "realis(e|ed|es|ing)", "analys(e|ed|es|ing)", "organis(e|ed|es|ing|ation)",
    "serialis(e|ed|es|ing)", "authoris(e|ed|es|ing)", "apologis(e|ed|es|ing)",
    "generalis(e|ed|es|ing)", "utilis(e|ed|es|ing)", "standardis(e|ed|es|ing)",
    "categoris(e|ed|es|ing)", "sanitis(e|ed|es|ing)", "personalis(e|ed|es|ing)",
    "minimis(e|ed|es|ing)", "maximis(e|ed|es|ing)", "prioritis(e|ed|es|ing)",
    "customis(e|ed|es|ing)", "initialis(e|ed|es|ing)", "visualis(e|ed|es|ing)",
    "emphasis(e|ed|es|ing)",
  ];

  it("no British vocabulary in the paint tool", () => {
    const pattern = `\\b(${BRITISH.join("|")})\\b`;
    const hits = execSync(
      `grep -rniE '${pattern}' ${PAINT_TOOL_PATHS} || true`,
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);

    expect(
      hits,
      `British spelling in the paint tool. Karan: "not british anymore".\n${hits
        .slice(0, 20)
        .join("\n")}`
    ).toEqual([]);
  });

  it("…and the check would notice if it were", () => {
    // A grep that matches nothing passes whatever the code says. Prove the
    // pattern bites on the exact words it is written for.
    const pattern = `\\b(${BRITISH.join("|")})\\b`;
    const probe = execSync(
      `printf '%s\\n' 'the fulfilment behaviour was recognised in the grey centre' | grep -icE '${pattern}' || true`,
      { encoding: "utf8" }
    ).trim();
    expect(probe).toBe("1");
    // …and that it does NOT flag the words that merely look British.
    const safe = execSync(
      `printf '%s\\n' 'this analysis puts emphasis on a realistic organic color' | grep -icE '${pattern}' || true`,
      { encoding: "utf8" }
    ).trim();
    expect(safe).toBe("0");
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
