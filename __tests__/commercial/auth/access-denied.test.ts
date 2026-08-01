import { describe, it, expect } from "vitest";
import { rawAccessDenied, commercialAccessDenied } from "@/lib/commercial/auth";
import type { Profile } from "@/lib/auth/profile";

/**
 * Phase 0 Group B security gate. Both predicates decide whether to DENY a
 * commercial request. rawAccessDenied guards API routes (partial DB rows, no
 * admin exemption); commercialAccessDenied guards server actions (full Profile,
 * admin-exempt). These pin the deactivation-bypass fix so it can't regress.
 */
describe("rawAccessDenied (API-route guard)", () => {
  it("denies when there is no row at all", () => {
    expect(rawAccessDenied(null)).toBe(true);
    expect(rawAccessDenied(undefined)).toBe(true);
  });
  it("allows an active commercial user", () => {
    expect(rawAccessDenied({ has_new_platform_access: true, is_active: true })).toBe(false);
  });
  it("denies a deactivated user even with the platform flag (the core fix)", () => {
    expect(rawAccessDenied({ has_new_platform_access: true, is_active: false })).toBe(true);
  });
  it("denies anyone without the commercial flag", () => {
    expect(rawAccessDenied({ has_new_platform_access: false, is_active: true })).toBe(true);
  });
  it("treats a null/absent is_active as active (legacy rows default to on)", () => {
    expect(rawAccessDenied({ has_new_platform_access: true, is_active: null })).toBe(false);
    expect(rawAccessDenied({ has_new_platform_access: true })).toBe(false);
  });
});

describe("commercialAccessDenied (server-action guard)", () => {
  const base: Profile = {
    user_id: "u1",
    email: "crew@tomcopainting.com",
    sf_user_id: null,
    sf_user_name: null,
    is_admin: false,
    is_active: true,
    last_login_at: null,
    created_at: "",
    updated_at: "",
    has_new_platform_access: true,
    has_command_center_access: false,
  };

  it("denies a null profile", () => {
    expect(commercialAccessDenied(null)).toBe(true);
  });
  it("allows an active commercial user", () => {
    expect(commercialAccessDenied(base)).toBe(false);
  });
  it("denies a deactivated non-admin commercial user", () => {
    expect(commercialAccessDenied({ ...base, is_active: false })).toBe(true);
  });
  it("denies a user without commercial access", () => {
    expect(commercialAccessDenied({ ...base, has_new_platform_access: false })).toBe(true);
  });
});
