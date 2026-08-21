import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { ASSIGNMENT_ROLES } from "@/lib/commercial/accounts/assignment-roles";
import { OPPORTUNITY_ASSIGNMENT_ROLES } from "@/lib/commercial/opportunities/assignments";

/**
 * Karan 2026-08-13: adding a team member failed with
 * "violates check constraint commercial_account_assignments_role".
 *
 * Brendan's four roles were added to the app and never to the DATABASE, whose
 * CHECK constraint still listed the old ones. Only `sales_rep` overlapped, so
 * three of the four roles the picker offered were rejected by Postgres — with
 * a raw constraint error in the UI — from the day they shipped.
 *
 * This is "one list in two places" with Postgres as the second place, which is
 * the version TypeScript cannot see. So the check is done here instead: every
 * role the app can WRITE must appear in the newest CHECK constraint for that
 * table.
 */

function latestCheckedRoles(constraintName: string): string[] {
  // The newest migration that defines this constraint wins — later ones
  // replace earlier ones, exactly as they do when applied in order.
  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let roles: string[] = [];
  for (const f of files) {
    const sql = readFileSync(`${dir}/${f}`, "utf8");
    const idx = sql.indexOf(constraintName);
    if (idx === -1) continue;
    const after = sql.slice(idx);
    const m = /CHECK\s*\(\s*role\s+IN\s*\(([^)]*)\)/i.exec(after);
    if (!m) continue;
    roles = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  }
  return roles;
}

describe("every role the app offers is permitted by the database", () => {
  it("account assignments", () => {
    const allowed = latestCheckedRoles("commercial_account_assignments_role_check");
    expect(allowed.length, "no CHECK constraint found — did the migration move?").toBeGreaterThan(0);
    for (const role of ASSIGNMENT_ROLES) {
      expect(allowed, `"${role}" is offered by the picker but rejected by Postgres`).toContain(role);
    }
  });

  it("opportunity assignments", () => {
    const allowed = latestCheckedRoles("commercial_opportunity_assignments_role_check");
    expect(allowed.length).toBeGreaterThan(0);
    for (const role of OPPORTUNITY_ASSIGNMENT_ROLES) {
      expect(allowed, `"${role}" is offered on the deal Team tab but rejected by Postgres`).toContain(role);
    }
  });

  // The table this test DIDN'T cover, and therefore the one that stayed broken.
  //
  // Migration 136 widened account + opportunity assignments and stopped there.
  // Settings → Teams builds its dropdown from the same ASSIGNMENT_ROLES, and
  // commercial_team_members still carried the original seven from migration
  // 122 — so "Estimator" was refused by Postgres, and the table held zero rows.
  // Stephanie reported it as "I can't add team members" (2026-08-20).
  //
  // Every table whose role column is fed by a picker belongs in this list. A
  // test that covers two of three tables proves nothing about the third.
  it("team members — the roster picker uses the same list", () => {
    const allowed = latestCheckedRoles("commercial_team_members_role_check");
    expect(allowed.length, "no CHECK constraint found — did the migration move?").toBeGreaterThan(0);
    for (const role of ASSIGNMENT_ROLES) {
      expect(allowed, `"${role}" is offered on Settings → Teams but rejected by Postgres`).toContain(role);
    }
  });

  it("retired roles stay permitted, so existing rows keep validating", () => {
    // Widening must never drop a value already stored — those rows were
    // written legitimately and nobody asked us to touch them.
    const allowed = latestCheckedRoles("commercial_account_assignments_role_check");
    for (const old of ["account_manager", "primary_pm", "superintendent", "foreman", "billing_contact", "lead_estimator", "other"]) {
      expect(allowed, `retiring "${old}" from the constraint would orphan existing rows`).toContain(old);
    }
  });
});
