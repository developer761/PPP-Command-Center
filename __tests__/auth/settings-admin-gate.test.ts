import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilitiesFor, isAdminProfile, roleForProfile } from "@/lib/auth/roles";

/**
 * Who may open Settings, decided the same way in all three places.
 *
 * On 2026-10-05 they disagreed. The Settings hub read
 *
 *     profile?.is_admin ?? isAdminEmail(user.email)
 *
 * while the sidebar and the Access page both normalize the ROLE. `??` only
 * falls through on null/undefined, so a row carrying role 'admin' with the
 * legacy is_admin boolean still false resolved to false — the menu offered
 * Settings and the page bounced them back to /dashboard saying nothing.
 *
 * jason.eng@ is in exactly that state in production today, and is not on the
 * bootstrap email list that would have papered over it.
 *
 * These assert the DECISION for the real rows, not the source text, so the
 * three surfaces cannot drift apart again without this going red.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Both call the SHARED derivation — deliberately, because the first version of
 * this file re-implemented each surface's expression and then agreed with
 * itself after the page was fixed. A test that copies the logic it is checking
 * passes whatever the code does.
 */
const hubAllows = (row: { role?: string | null; is_admin?: boolean | null }, bootstrapEmail = false) =>
  isAdminProfile(row, bootstrapEmail);

const sidebarShowsSettings = (row: { role?: string | null; is_admin?: boolean | null }, bootstrapEmail = false) =>
  capabilitiesFor(roleForProfile(row, bootstrapEmail)).isAdmin;

describe("the menu and the page agree about who is an admin", () => {
  it("lets in an admin whose legacy flag was never mirrored", () => {
    // jason.eng@ — the row that was offered Settings and refused it.
    const jason = { role: "admin", is_admin: false };
    expect(sidebarShowsSettings(jason)).toBe(true);
    expect(hubAllows(jason)).toBe(true); // was false
  });

  it("keeps out a rep whose legacy flag says otherwise", () => {
    // malhotrak038@ — the mirror image, still live. is_admin true, role rep.
    // Role is authoritative now, so the hub refuses, which is what the sidebar
    // and the Access page already did. The two surfaces agreeing is the point;
    // the row itself is a data fix.
    const karan = { role: "rep", is_admin: true };
    expect(sidebarShowsSettings(karan)).toBe(false);
    expect(hubAllows(karan)).toBe(false);
  });

  it("agrees on every combination, which is the actual rule", () => {
    for (const role of [null, "admin", "account_manager", "regional_manager", "rep"]) {
      for (const is_admin of [true, false, null]) {
        for (const bootstrap of [true, false]) {
          const row = { role, is_admin };
          expect(
            hubAllows(row, bootstrap),
            `role=${role} is_admin=${is_admin} bootstrap=${bootstrap}`
          ).toBe(sidebarShowsSettings(row, bootstrap));
        }
      }
    }
  });

  it("still admits a pre-role row on the bootstrap email list", () => {
    // Rows written before the role column existed carry no role at all. The
    // email list is what keeps those admins working.
    expect(hubAllows({ role: null, is_admin: null }, true)).toBe(true);
    expect(hubAllows({ role: null, is_admin: null }, false)).toBe(false);
  });
});

describe("the hub reads the role, not only the legacy flag", () => {
  it("all three surfaces call the shared derivation, not their own", () => {
    const strip = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    const hub = strip(read("app/dashboard/settings/page.tsx"));
    const access = strip(read("app/dashboard/settings/access/page.tsx"));
    const viewer = strip(read("lib/auth/viewer-server.ts"));

    expect(hub).toMatch(/isAdminProfile\(profile, isAdminEmail\(user\.email\)\)/);
    expect(access).toMatch(/roleForProfile\(profile, isAdminEmail\(user\.email\)\)/);
    expect(viewer).toMatch(/roleForProfile\(profile, isAdminEmail\(profile\.email\)\)/);

    // And none of them still rolls its own. `??` between the flag and the
    // allow-list is the exact bug, twice.
    for (const [name, src] of [["hub", hub], ["access", access], ["viewer", viewer]] as const) {
      expect(src, name).not.toMatch(/is_admin \?\? isAdminEmail/);
    }
  });
});

describe("the shared derivation itself", () => {
  /**
   * Hardcoded expectations, NOT a comparison between two callers.
   *
   * The agreement tests above cannot catch this: once the hub and the sidebar
   * both call roleForProfile, they agree no matter what it returns. Reverting
   * the helper to `??` left all of them green — a check that cannot fail.
   * These pin the answer instead.
   */
  const cases: Array<[string, { role: string | null; is_admin: boolean | null }, boolean, boolean]> = [
    // label                            row                                     bootstrap  isAdmin
    ["role admin, flag mirrored",       { role: "admin", is_admin: true },       false,     true],
    ["role admin, flag stale false",    { role: "admin", is_admin: false },      false,     true],
    ["role admin, flag null",           { role: "admin", is_admin: null },       false,     true],
    ["role rep, flag true",             { role: "rep", is_admin: true },         false,     false],
    ["role rep, on the allow-list",     { role: "rep", is_admin: false },        true,      false],
    ["no role, flag true",              { role: null, is_admin: true },          false,     true],
    // THE ONE THAT WAS WRONG: `??` read a false flag as the final answer and
    // never consulted the allow-list behind it.
    ["no role, flag false, allow-list", { role: null, is_admin: false },         true,      true],
    ["no role, flag null, allow-list",  { role: null, is_admin: null },          true,      true],
    ["no role, nothing",                { role: null, is_admin: null },          false,     false],
    ["account manager",                 { role: "account_manager", is_admin: false }, false, false],
  ];

  for (const [label, row, bootstrap, expected] of cases) {
    it(`${label} → ${expected ? "admin" : "not admin"}`, () => {
      expect(isAdminProfile(row, bootstrap)).toBe(expected);
    });
  }

  it("never lets a non-admin role be upgraded by a flag", () => {
    // An explicit role is authoritative. If this ever flips, a deactivated
    // admin demoted to rep would quietly keep Settings.
    for (const role of ["rep", "account_manager", "regional_manager"]) {
      expect(isAdminProfile({ role, is_admin: true }, true), role).toBe(false);
      expect(roleForProfile({ role, is_admin: true }, true), role).toBe(role);
    }
  });
});
