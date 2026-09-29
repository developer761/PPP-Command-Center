import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Proxy login — "log in as" another user (Katie, 2026-09-29, after Jason hit a
 * paint-tool problem and took no screenshots).
 *
 * This is an AUTH feature, so what is tested here is the boundary rather than
 * the pixels: who may start one, who may end one, and whether the substitution
 * reaches the code that actually gates things. The last one is the point —
 * View As already existed and changed only what an admin could SEE, which is
 * why it could never reproduce a permissions bug.
 */

let cookieStore: Record<string, string> = {};
const cookieJar = {
  get: (k: string) => (k in cookieStore ? { value: cookieStore[k] } : undefined),
  set: (k: string, v: string) => { cookieStore[k] = v; },
  delete: (k: string) => { delete cookieStore[k]; },
};
vi.mock("next/headers", () => ({ cookies: async () => cookieJar }));

/** profiles, by user id. */
const PROFILES: Record<string, Record<string, unknown>> = {
  "admin-1": { user_id: "admin-1", email: "katie@precisionpaintingplus.com", full_name: "Katie", role: "admin", is_admin: true, is_active: true, sf_user_id: "005ADMIN" },
  "jason-1": { user_id: "jason-1", email: "jason.ng@precisionpaintingplus.com", full_name: "Jason Ng", role: "rep", is_admin: false, is_active: true, sf_user_id: "005JASON" },
  "amy-1":   { user_id: "amy-1", email: "amy@precisionpaintingplus.com", full_name: "Amy", role: "account_manager", is_admin: false, is_active: true, sf_user_id: "005AMY" },
  "gone-1":  { user_id: "gone-1", email: "gone@precisionpaintingplus.com", full_name: "Gone", role: "rep", is_admin: false, is_active: false, sf_user_id: null },
  // A SECOND admin. Needed to see the "only the current user" guard fail: a
  // lookup of a non-admin never reaches the substitution anyway, so a test
  // using one passes with the guard deleted (found by mutation testing).
  "admin-2": { user_id: "admin-2", email: "alex@precisionpaintingplus.com", full_name: "Alex", role: "admin", is_admin: true, is_active: true, sf_user_id: "005ALEX" },
};

let currentUserId = "admin-1";
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => ({ id: currentUserId, email: PROFILES[currentUserId]?.email }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAdminEmail: () => false }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => ({ data: PROFILES[id] ?? null, error: null }),
        }),
      }),
      insert: async () => ({ error: null }),
    }),
  }),
}));

const { getProfileByUserId, invalidateProfileCache } = await import("@/lib/auth/profile");
const { PROXY_COOKIE } = await import("@/lib/auth/proxy");

beforeEach(() => {
  cookieStore = {};
  currentUserId = "admin-1";
  for (const id of Object.keys(PROFILES)) invalidateProfileCache(id);
});

describe("an admin proxying as a rep", () => {
  it("is handed the REP's profile, not their own", async () => {
    cookieStore[PROXY_COOKIE] = "jason-1";
    const p = await getProfileByUserId("admin-1");
    expect(p?.email).toBe("jason.ng@precisionpaintingplus.com");
    expect(p?.role).toBe("rep");
  });

  it("which is what makes the permission bug reproduce", async () => {
    // The whole reason this exists. View As left `role: admin` in place, so an
    // admin standing in Jason's shoes still had Jason's DATA and their own
    // BUTTONS. Here the role travels, and every screen and API route reads it
    // from this one function.
    const { capabilitiesFor, normalizeRole } = await import("@/lib/auth/roles");
    cookieStore[PROXY_COOKIE] = "amy-1";
    const p = await getProfileByUserId("admin-1");
    const caps = capabilitiesFor(normalizeRole(p?.role, p?.is_admin ?? false));
    expect(caps.isAdmin).toBe(false);
    // An account manager is the one role that cannot order materials — if the
    // proxy did not carry the role, this would still be true.
    expect(caps.canOrderMaterials).toBe(false);
    expect(caps.canManageSettings).toBe(false);
  });

  it("can still be undone, because the real profile is always reachable", async () => {
    cookieStore[PROXY_COOKIE] = "jason-1";
    const real = await getProfileByUserId("admin-1", { ignoreProxy: true });
    expect(real?.role).toBe("admin");
  });
});

describe("what the substitution must NOT do", () => {
  it("does not apply to a lookup of somebody else's profile", async () => {
    // Routes look up other people all the time — the customer list, an
    // order's creator. If the proxy leaked into those, every name on the page
    // would become the proxied user.
    cookieStore[PROXY_COOKIE] = "jason-1";
    const amy = await getProfileByUserId("amy-1");
    expect(amy?.email).toBe("amy@precisionpaintingplus.com");

    // …including when the OTHER person is themselves an admin, which is the
    // only shape where the guard is load-bearing: a non-admin lookup falls out
    // at the admin check regardless.
    const alex = await getProfileByUserId("admin-2");
    expect(alex?.email).toBe("alex@precisionpaintingplus.com");
    expect(alex?.role).toBe("admin");
  });

  it("does nothing at all for a non-admin holding the cookie", async () => {
    // A rep who somehow acquires the cookie must not become anybody. The check
    // is made against their REAL profile, so it cannot be escalated by first
    // proxying into an admin.
    currentUserId = "jason-1";
    cookieStore[PROXY_COOKIE] = "admin-1";
    const p = await getProfileByUserId("jason-1");
    expect(p?.role).toBe("rep");
    expect(p?.email).toBe("jason.ng@precisionpaintingplus.com");
  });

  it("does nothing when there is no cookie", async () => {
    const p = await getProfileByUserId("admin-1");
    expect(p?.role).toBe("admin");
  });

  it("ignores a cookie pointing at yourself", async () => {
    cookieStore[PROXY_COOKIE] = "admin-1";
    const p = await getProfileByUserId("admin-1");
    expect(p?.role).toBe("admin");
  });

  it("falls back to the real profile if the target has vanished", async () => {
    // A deleted account must not log anybody out or blank the shell.
    cookieStore[PROXY_COOKIE] = "no-such-user";
    const p = await getProfileByUserId("admin-1");
    expect(p?.role).toBe("admin");
  });
});
