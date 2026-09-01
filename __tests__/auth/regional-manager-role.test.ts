import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  capabilitiesFor, normalizeRole, roleLabel, homeHrefFor,
  USER_ROLE_VALUES, USER_ROLES, type UserRole,
} from "@/lib/auth/roles";

/**
 * Kate, 2026-09-01: "regional managers ... should essentially have the Sales
 * Rep settings but with the ability to see all work orders."
 *
 * So the role is defined by its ONE difference from a rep, and the tests are
 * written that way — anything that drifts apart from `rep` beyond breadth of
 * visibility is a regression, whichever direction it drifts in.
 */
const ROOT = process.cwd();

describe("Regional Manager is a rep who sees everything", () => {
  const rm = capabilitiesFor("regional_manager");
  const rep = capabilitiesFor("rep");

  it("sees ALL work orders — the whole point of the role", () => {
    expect(rm.canSeeAllWorkOrders).toBe(true);
    expect(rep.canSeeAllWorkOrders).toBe(false);
  });

  it("differs from a Sales Rep in that and NOTHING else", () => {
    // Written as a diff rather than a list of booleans: a capability added
    // later gets this comparison for free, in both directions.
    const differing = (Object.keys(rm) as Array<keyof typeof rm>)
      .filter((k) => rm[k] !== rep[k]);
    expect(differing).toEqual(["canSeeAllWorkOrders"]);
  });

  it("orders materials like a rep, but cannot open Settings", () => {
    // Kate 2026-09-01 widened ordering to every role except the account
    // manager, so this flipped from false. Settings stays admin-only.
    expect(rm.canOrderMaterials).toBe(true);
    expect(rm.canManageSettings).toBe(false);
    expect(rm.isAdmin).toBe(false);
    expect(rm.isAccountManager).toBe(false);
  });

  it("keeps analytics, like a rep", () => {
    // A regional manager logs in for numbers; theirs now span the region.
    expect(rm.canSeeAnalytics).toBe(true);
  });

  it("lands on the dashboard, not the materials page", () => {
    expect(homeHrefFor("regional_manager")).toBe("/dashboard");
  });

  it("round-trips through storage and has a label", () => {
    expect(normalizeRole("regional_manager")).toBe("regional_manager");
    expect(roleLabel("regional_manager")).toBe("Regional Manager");
    expect(USER_ROLE_VALUES).toContain("regional_manager");
    expect(USER_ROLES.map((r) => r.value)).toContain("regional_manager");
  });

  it("an unknown role still falls back to the least privilege", () => {
    // Commercial roles (scheduler, foreman, …) share this table's column.
    expect(normalizeRole("scheduler")).toBe("rep");
    expect(capabilitiesFor(normalizeRole("nonsense")).canSeeAllWorkOrders).toBe(false);
  });
});

describe("the visibility rule lives in exactly one place", () => {
  it("nothing re-derives 'can see all' from role booleans", () => {
    // This is the bug this change nearly shipped with. Both viewer-server and
    // dashboard-chrome carried their own `isAdmin || isAccountManager`, so a
    // role added to roles.ts alone would have had the new role's NAV and the
    // old role's DATA SCOPE — visible only by logging in as one.
    const files = ["lib/auth/viewer-server.ts", "components/dashboard-chrome.tsx"];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, `${f} re-derives the visibility rule`).not.toMatch(/isAdmin \|\| isAccountManager/);
      expect(src, `${f} should read the capability`).toMatch(/canSeeAllWorkOrders/);
    }
  });
});

describe("the database accepts every role the app can produce", () => {
  it("the CHECK constraint lists all of them", () => {
    // The app-list vs DB-CHECK seam: a role the UI offers but the database
    // rejects fails only at save time, on a real admin provisioning a real
    // person.
    const migrations = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql")).sort();
    const latest = migrations
      .filter((f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8").includes("profiles_role_check"))
      .pop();
    expect(latest, "no migration defines profiles_role_check").toBeTruthy();
    const sql = readFileSync(join(ROOT, "supabase/migrations", latest!), "utf8");
    const allowed = sql.split("check (role in (")[1]?.split("))")[0] ?? "";
    for (const role of USER_ROLE_VALUES as readonly UserRole[]) {
      expect(allowed, `the database would reject role "${role}"`).toContain(`'${role}'`);
    }
  });

  it("keeps the Commercial roles that share this column", () => {
    // Dropping one would orphan real Commercial profiles on the next write.
    const sql = readFileSync(join(ROOT, "supabase/migrations/177_regional_manager_role.sql"), "utf8");
    for (const role of ["scheduler", "foreman", "payroll", "viewer"]) {
      expect(sql).toContain(`'${role}'`);
    }
  });
});


describe("field users can enter colors (Kate, 2026-09-01)", () => {
  it("every role can enter colors and send the color form", () => {
    // "the field users should be able to enter colors + send the color form."
    // Colour capture is field work — the rep is standing in the customer's
    // hallway — and gating it to office roles meant the person actually WITH
    // the customer had to ask someone else to send the form.
    for (const role of USER_ROLE_VALUES) {
      expect(capabilitiesFor(role).canEnterColors, `${role} cannot enter colors`).toBe(true);
    }
  });

  it("this did NOT widen anything else", () => {
    // Opening one capability must not quietly open the others. Settings and
    // work-order scope stay exactly where they were.
    expect(capabilitiesFor("rep").canManageSettings).toBe(false);
    expect(capabilitiesFor("rep").canSeeAllWorkOrders).toBe(false);
    expect(capabilitiesFor("regional_manager").canManageSettings).toBe(false);
    expect(capabilitiesFor("account_manager").canManageSettings).toBe(false);
    // Ordering was widened SEPARATELY on the same day (Kate: "available to
    // all but Account Management") — the account manager is the exception,
    // and that exclusion is the thing that must not drift.
    expect(capabilitiesFor("account_manager").canOrderMaterials).toBe(false);
  });

  it("the server routes read the capability rather than the role", () => {
    // Seven routes enforce this. If any re-derived "admin or AM" locally, the
    // UI would offer a rep a button whose route still returns 403 — which is
    // worse than not offering it.
    const dir = join(ROOT, "app/api");
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name === "route.ts") out.push(p);
      }
      return out;
    };
    const guarded = walk(dir).filter((f) => readFileSync(f, "utf8").includes("canEnterColors"));
    expect(guarded.length).toBeGreaterThanOrEqual(7);
    for (const f of guarded) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, `${f} re-derives the colour gate`).not.toMatch(/isAdmin \|\| isAccountManager/);
    }
  });
});
