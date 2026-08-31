import { describe, it, expect } from "vitest";
import { platformAccess } from "@/lib/auth/profile";
import { ALL_PLATFORMS } from "@/lib/platform-cookie";

/**
 * `accessible` drives the picker, the switcher and the set-cookie guard. It
 * replaced hasBoth/hasNeither, which could only ever describe two platforms —
 * the shape these tests exist to protect.
 */
const profile = (cc: boolean, np: boolean, msg = false) =>
  ({
    user_id: "u", email: "e@x.com", sf_user_id: null, sf_user_name: null,
    is_admin: false, is_active: true,
    has_command_center_access: cc, has_new_platform_access: np,
    has_messaging_access: msg,
  }) as Parameters<typeof platformAccess>[0];

describe("platformAccess", () => {
  it("lists both platforms for a dual-access profile", () => {
    expect(platformAccess(profile(true, true)).accessible).toEqual(["command_center", "new_platform"]);
  });

  it("lists all three when messaging is granted too", () => {
    expect(platformAccess(profile(true, true, true)).accessible).toEqual([
      "command_center", "new_platform", "messaging",
    ]);
  });

  it("does NOT grant messaging by inheritance — it must be set explicitly", () => {
    // The whole point of the flag: this surface can text a customer, so an
    // admin with both other platforms still gets nothing until granted.
    expect(platformAccess(profile(true, true)).hasMessaging).toBe(false);
    expect(platformAccess(profile(true, true)).accessible).not.toContain("messaging");
    expect(platformAccess(null).accessible).not.toContain("messaging");
  });

  it("can hold messaging alone", () => {
    expect(platformAccess(profile(false, false, true)).accessible).toEqual(["messaging"]);
  });

  it("lists only the platform a single-access profile holds", () => {
    expect(platformAccess(profile(true, false)).accessible).toEqual(["command_center"]);
    expect(platformAccess(profile(false, true)).accessible).toEqual(["new_platform"]);
  });

  it("returns an empty list when the profile holds neither", () => {
    expect(platformAccess(profile(false, false)).accessible).toEqual([]);
  });

  it("defaults a null profile to Command Center only, as the flags do", () => {
    // has_command_center_access defaults true so nobody loses prior access;
    // has_new_platform_access defaults false so it must be granted.
    expect(platformAccess(null).accessible).toEqual(["command_center"]);
  });

  it("keeps accessible a subset of ALL_PLATFORMS in registry order", () => {
    const a = platformAccess(profile(true, true)).accessible;
    expect(a).toEqual(ALL_PLATFORMS.filter((p) => a.includes(p)));
  });

  it("agrees with the individual booleans the route guards still use", () => {
    for (const [cc, np] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      const acc = platformAccess(profile(cc, np));
      expect(acc.accessible.includes("command_center")).toBe(acc.hasCommandCenter);
      expect(acc.accessible.includes("new_platform")).toBe(acc.hasNewPlatform);
      expect(acc.accessible.includes("messaging")).toBe(acc.hasMessaging);
    }
  });
});
