import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A Commercial page resolves "is this an admin?" as `is_admin ?? isAdminEmail(email)` —
 * the DB column first, then the env allowlist (`PPP_ADMIN_EMAILS`) for accounts
 * whose `profiles.is_admin` was never written.
 *
 * Several API routes checked the COLUMN ALONE. The result is the worst kind of
 * broken: the page renders for an allowlisted admin, so every control is right
 * there — and then each one 403s with raw JSON. It shipped that way on the
 * payroll export and on all four field-ops scheduling writes (assign, remove,
 * absence, copy-week), which is the entire interactive calendar.
 *
 * So: any commercial API route that gates on `is_admin` must also honour the
 * allowlist, exactly as the page that renders its buttons does.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const ROOT = process.cwd();
const routes = walk(join(ROOT, "app", "api", "commercial"));

/** A gate that reads the column: `...?.is_admin` used as a condition. */
const GATES_ON_COLUMN = /\?\.is_admin\b/;
/** Either the direct helper, or normalizeRole(role, is_admin ?? isAdminEmail(...)). */
const HONOURS_ALLOWLIST = /isAdminEmail\s*\(/;

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("commercial API admin gates match the pages that render their buttons", () => {
  it("no route gates on the is_admin column without the env allowlist", () => {
    const offenders = routes
      .filter((f) => {
        const code = codeOnly(readFileSync(f, "utf8"));
        return GATES_ON_COLUMN.test(code) && !HONOURS_ALLOWLIST.test(code);
      })
      .map((f) => f.slice(ROOT.length + 1));
    expect(
      offenders,
      "these gate on `profiles.is_admin` alone — an allowlisted admin whose " +
        "column is NULL sees the UI and gets a raw 403 on every click. Use " +
        "`is_admin ?? isAdminEmail(email)`, the same resolution the page uses"
    ).toEqual([]);
  });

  it("still finds the routes it is meant to be checking", () => {
    // Guards the guard: if the pattern stops matching, the assertion above
    // passes vacuously and the mismatch walks straight back in.
    const gated = routes.filter((f) => GATES_ON_COLUMN.test(codeOnly(readFileSync(f, "utf8"))));
    expect(gated.length).toBeGreaterThanOrEqual(4);
  });
});
