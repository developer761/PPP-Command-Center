import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  RATING_CODES,
  FALLBACK_RATING_LABELS,
  isRatingCode,
} from "@/lib/commercial/accounts/rating-codes";

/**
 * Editable meanings for the A/B/C account rating.
 *
 * Stephanie 2026-08-13: *"Rating system? Can we personalize these..."* The
 * letters stay; what they MEAN became editable. The point of these tests is
 * that the stored values must not move — a rename would re-grade every account
 * and break the filter, the sort and the export.
 */

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the stored rating codes do not move", () => {
  it("is still exactly A, B, C", () => {
    // Changing this set means a data migration, a CHECK change, and re-grading
    // every existing account. If this test fails, that work has to happen too —
    // it must not be an accident.
    expect([...RATING_CODES]).toEqual(["A", "B", "C"]);
  });

  it("matches the CHECK on commercial_accounts.rating", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    let checked: string[] | null = null;
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      for (const stmt of sql.split(";")) {
        if (!stmt.includes("commercial_accounts")) continue;
        for (const m of stmt.matchAll(/rating\s+(?:TEXT\s+)?CHECK\s*\(\s*rating\s+IN\s*\(([^)]*)\)/gi)) {
          const vals = [...m[1].matchAll(/'([A-C])'/g)].map((x) => x[1]);
          if (vals.length > 0) checked = vals;
        }
      }
    }
    expect(checked, "no rating CHECK found").not.toBeNull();
    expect([...checked!].sort()).toEqual([...RATING_CODES].sort());
  });

  it("every code has a fallback meaning", () => {
    // The pill renders on every account row, so a code with no fallback would
    // show a blank label the moment the settings read fails.
    for (const c of RATING_CODES) {
      expect(FALLBACK_RATING_LABELS[c]?.label?.trim(), `no fallback for ${c}`).toBeTruthy();
    }
  });

  it("rejects anything that is not a code", () => {
    expect(isRatingCode("A")).toBe(true);
    expect(isRatingCode("D")).toBe(false);
    expect(isRatingCode("a")).toBe(false);
    expect(isRatingCode("")).toBe(false);
  });
});

describe("the codes module stays client-importable", () => {
  it("has no server-only import", () => {
    // Same lesson as document-categories and contact roles: a list a client
    // component cannot import is a list it ends up copying, and the copy is
    // where the screen starts disagreeing with the constants.
    const src = read("lib/commercial/accounts/rating-codes.ts");
    expect(src).not.toMatch(/^\s*import\s+["']server-only["']/m);
  });

  it("the settings page cannot rename a code", () => {
    // The form posts a code and a label. If it ever posts a NEW code, the
    // guarantee above is gone.
    const src = read("app/commercial/settings/ratings/page.tsx");
    expect(src).toContain("isRatingCode(code)");
    expect(src).toContain('name="label"');
  });
});
