import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTACT_ROLES, roleLabel, isContactRole } from "@/lib/commercial/contacts/roles";

/**
 * The contact-role list lives in three places, and only two of them are code.
 *
 * The third is a Postgres CHECK constraint, which TypeScript cannot see. A role
 * added to the app and not to the constraint compiles, renders in the picker,
 * and is rejected by the database at save time — which is exactly what happened
 * to Brendan's team roles until migration 136 repaired it. Three of his four
 * roles had been silently failing since the day they shipped.
 *
 * So this reads the CHECKs out of the migration files and compares.
 */

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/**
 * The role values in the LAST CHECK defined for a table across all migrations
 * — last, because a later migration can drop and re-add the constraint (141
 * does exactly that to add 'apm').
 */
function checkedRoles(tableName: string): string[] | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let found: string[] | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    // Per STATEMENT, not per file. A single migration can define CHECKs for
    // more than one table — 141 does — and scanning the whole file happily
    // reported the wrong table's constraint, so removing a role from the
    // table under test did not fail this. Caught by deliberately breaking it.
    for (const stmt of sql.split(";")) {
      if (!stmt.includes(tableName)) continue;
      for (const m of stmt.matchAll(/role\s+IN\s*\(([^)]*)\)/gi)) {
        const vals = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
        if (vals.length > 0) found = vals;
      }
    }
  }
  return found;
}

describe("contact roles match the database", () => {
  it("the per-job contacts CHECK accepts exactly the app's roles", () => {
    const db = checkedRoles("commercial_opportunity_contacts");
    expect(db, "no CHECK found for commercial_opportunity_contacts").not.toBeNull();
    expect([...db!].sort()).toEqual([...CONTACT_ROLES].sort());
  });

  it("the account contacts CHECK accepts them too", () => {
    // One vocabulary, not two. 141 widens this one so 'apm' is legal on both.
    const db = checkedRoles("commercial_account_contacts");
    expect(db, "no CHECK found for commercial_account_contacts").not.toBeNull();
    for (const role of CONTACT_ROLES) {
      expect(db!, `"${role}" would be rejected by the database`).toContain(role);
    }
  });

  it("every role has a real label, not the raw slug", () => {
    for (const r of CONTACT_ROLES) {
      expect(roleLabel(r), `no label for "${r}"`).not.toBe(r);
    }
  });

  it("carries the roles Stephanie named", () => {
    // "site supers, pms, apms, estimators"
    for (const r of ["superintendent", "pm", "apm", "estimator"]) {
      expect(isContactRole(r), `${r} missing`).toBe(true);
    }
  });
});

describe("roles are importable by client components", () => {
  it("the roles module has no server-only import", () => {
    // The whole reason this file exists. If `server-only` ever lands here, the
    // client components go back to keeping private copies and the screen
    // starts disagreeing with the constants again.
    const src = readFileSync(join(ROOT, "lib/commercial/contacts/roles.ts"), "utf8");
    // Matched as a real import, not a substring — the phrase appears in this
    // module's own comment explaining why it must not be imported.
    expect(src).not.toMatch(/^\s*import\s+["']server-only["']/m);
    expect(src).not.toMatch(/^\s*import /m);
  });
});
