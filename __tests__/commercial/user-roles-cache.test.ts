import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The roles cache, which sits under a security boundary.
 *
 * `assertCommercialAccess` gates every commercial server action and page
 * render (66 files). It paid an uncached read of `commercial_user_roles` every
 * single time — 78ms median, 139ms at the tail — while the profile lookup
 * beside it had been cached since the 2026-06-14 speed pass. `rbac.ts` then ran
 * the identical query again, so a render asking both questions paid it twice.
 *
 * Caching it is a latency fix on a PERMISSION check, so the three things that
 * make it safe are exactly the three things worth pinning. Each test below
 * fails if its property is removed:
 *
 *   1. it actually caches          — else the fix does nothing
 *   2. a FAILED read is not cached — else one dropped packet freezes "cannot
 *                                    tell" into 30 seconds of every gate in the
 *                                    platform, which is worse than the query
 *   3. a write invalidates         — else granting or revoking the crew role
 *                                    takes up to 30s to take effect, and the
 *                                    dangerous direction (stale "not crew" =
 *                                    briefly LESS restricted) stays open
 *
 * These are behavioural, not source-shape: the module is driven through a
 * stubbed client and the QUERIES ARE COUNTED, so a rewrite that keeps the
 * shape but loses the property still goes red.
 */

let queries = 0;
let nextResult: { data: { role: string }[] | null; error: { message: string } | null } = {
  data: [],
  error: null,
};

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => ({
    from: () => ({
      select: () => ({
        eq: async () => {
          queries++;
          return nextResult;
        },
      }),
    }),
  }),
}));

// crew-access reaches for the profile when the roles read fails, to keep an
// admin from being stranded. Not what this file is about — stub it away.
vi.mock("@/lib/auth/profile", () => ({
  getProfileByUserId: async () => ({ is_admin: false }),
}));

const USER = "11111111-1111-1111-1111-111111111111";

async function freshModule() {
  vi.resetModules();
  return import("@/lib/commercial/user-roles");
}

beforeEach(() => {
  queries = 0;
  nextResult = { data: [], error: null };
});

describe("readUserRoles", () => {
  it("reads once and serves the rest from cache", async () => {
    const { readUserRoles } = await freshModule();
    nextResult = { data: [{ role: "crew" }], error: null };
    for (let i = 0; i < 20; i++) expect(await readUserRoles(USER)).toEqual(["crew"]);
    expect(queries, "20 calls should be 1 query").toBe(1);
  });

  it("does not let a concurrent burst stampede the table", async () => {
    // The gate runs at the top of a page render AND of the action it posts to,
    // so simultaneous callers are the normal case, not an edge one.
    const { readUserRoles } = await freshModule();
    await Promise.all(Array.from({ length: 10 }, () => readUserRoles(USER)));
    expect(queries).toBe(1);
  });

  it("NEVER caches a failed read", async () => {
    // The property that keeps one blip from becoming a platform-wide outage.
    const { readUserRoles } = await freshModule();
    nextResult = { data: null, error: { message: "boom" } };
    expect(await readUserRoles(USER)).toBeNull();
    expect(await readUserRoles(USER)).toBeNull();
    expect(await readUserRoles(USER)).toBeNull();
    expect(queries, "each call must retry, not serve a cached failure").toBe(3);

    // …and it recovers the moment the table does.
    nextResult = { data: [{ role: "admin" }], error: null };
    expect(await readUserRoles(USER)).toEqual(["admin"]);
  });

  it("tells 'no roles' apart from 'could not read'", async () => {
    // `[]` is a real answer — this person has no roles. `null` is not an
    // answer at all. Collapsing them is how a blip starts looking like a
    // deliberate state.
    const { readUserRoles } = await freshModule();
    expect(await readUserRoles(USER)).toEqual([]);
    nextResult = { data: null, error: { message: "boom" } };
    expect(await readUserRoles("22222222-2222-2222-2222-222222222222")).toBeNull();
  });

  it("re-reads after invalidation", async () => {
    const { readUserRoles, invalidateRolesCache } = await freshModule();
    await readUserRoles(USER);
    expect(queries).toBe(1);
    invalidateRolesCache(USER);
    await readUserRoles(USER);
    expect(queries, "invalidate must force a fresh read").toBe(2);
  });

  it("caches per user, not globally", async () => {
    const { readUserRoles } = await freshModule();
    await readUserRoles(USER);
    await readUserRoles("33333333-3333-3333-3333-333333333333");
    expect(queries).toBe(2);
  });
});

describe("the crew gate on top of it", () => {
  it("still answers exactly what it used to", async () => {
    vi.resetModules();
    const { isCrewOnlyUser, crewOnlyStatus } = await import("@/lib/commercial/crew-access");
    const { invalidateRolesCache } = await import("@/lib/commercial/user-roles");

    const cases: [string[], boolean, string][] = [
      [[], false, "not-crew"], // no roles is NOT crew-only
      [["crew"], true, "crew"],
      [["crew", "crew"], true, "crew"],
      [["crew", "admin"], false, "not-crew"], // a second role lifts it
      [["admin"], false, "not-crew"],
      [["pm"], false, "not-crew"],
    ];
    for (const [roles, wantCrewOnly, wantStatus] of cases) {
      invalidateRolesCache();
      nextResult = { data: roles.map((role) => ({ role })), error: null };
      expect(await crewOnlyStatus(USER), JSON.stringify(roles)).toBe(wantStatus);
      invalidateRolesCache();
      expect(await isCrewOnlyUser(USER), JSON.stringify(roles)).toBe(wantCrewOnly);
    }
  });

  it("fails CLOSED when the roles table cannot be read", async () => {
    // The whole crew boundary hangs off this one predicate. `unknown` must
    // lean shut for ACCESS — a painter briefly seeing their own crew home is a
    // support call; the other direction serves them the book of business.
    vi.resetModules();
    const { isCrewOnlyUser, crewOnlyStatus } = await import("@/lib/commercial/crew-access");
    const { invalidateRolesCache } = await import("@/lib/commercial/user-roles");
    invalidateRolesCache();
    nextResult = { data: null, error: { message: "boom" } };
    expect(await crewOnlyStatus(USER)).toBe("unknown");
    expect(await isCrewOnlyUser(USER), "unknown must restrict").toBe(true);
  });
});
