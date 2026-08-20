import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { capabilitiesFor, homeHrefFor, USER_ROLE_VALUES } from "@/lib/auth/roles";

/**
 * R4.1 — "the only tabs an account manager should see are the tabs under
 * Operations Tools."
 *
 * An AM is an operations role: they run colour forms and materials for every
 * job. Revenue, margin and rep-performance surfaces aren't theirs. A REP keeps
 * them, because their own numbers are the reason they log in and those pages
 * are already scoped to their own work orders.
 */
describe("analytics access by role", () => {
  it("gives analytics to admin and rep, but not to the account manager", () => {
    expect(capabilitiesFor("admin").canSeeAnalytics).toBe(true);
    expect(capabilitiesFor("rep").canSeeAnalytics).toBe(true);
    expect(capabilitiesFor("account_manager").canSeeAnalytics).toBe(false);
  });

  it("never sends a role to a page it will be bounced off — that is a redirect loop", () => {
    // /dashboard is itself guarded. If homeHrefFor ever returned it for a role
    // without analytics access, the guard would redirect to /dashboard, which
    // would redirect again, forever. A hard outage, not a glitch.
    for (const role of USER_ROLE_VALUES) {
      const home = homeHrefFor(role);
      if (!capabilitiesFor(role).canSeeAnalytics) {
        expect(home, `${role} would loop on ${home}`).not.toBe("/dashboard");
      }
    }
  });
});

/**
 * Hiding a nav link is not access control. Without a server guard an account
 * manager can type /dashboard/financials and get the page.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e === "page.tsx") out.push(full);
  }
  return out;
}

const ROOT = process.cwd();
/** Route segments the nav shows only to roles with analytics access. */
const ANALYTICS_ROUTES = ["financials", "operations", "map", "rep"];

describe("analytics routes are guarded server-side", () => {
  const pages = walk(join(ROOT, "app/dashboard"));

  it("guards every page under an analytics section, plus the Overview", () => {
    const shouldGuard = pages.filter((p) => {
      const rel = p.replace(join(ROOT, "app/dashboard"), "");
      if (rel === "/page.tsx") return true; // Overview
      const seg = rel.split("/").filter(Boolean)[0];
      return ANALYTICS_ROUTES.includes(seg);
    });
    // Guards the guard: if the walk or the path logic breaks, this test would
    // pass while checking nothing.
    expect(shouldGuard.length).toBeGreaterThanOrEqual(5);

    const unguarded = shouldGuard
      .filter((p) => !readFileSync(p, "utf8").includes("requireAnalyticsAccess()"))
      .map((p) => p.replace(ROOT + "/", ""));
    expect(
      unguarded,
      "an account manager can reach these by typing the URL"
    ).toEqual([]);
  });
});
