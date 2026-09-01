import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilitiesFor, USER_ROLE_VALUES, type UserRole } from "@/lib/auth/roles";

/**
 * Kate 2026-09-01: "materials ordering should be available to all but Account
 * Management", and (same day) field users must be able to enter colours.
 *
 * The reason this file exists rather than a plain matrix test: BOTH of those
 * asks were shipped by editing `capabilitiesFor()` alone, and BOTH were still
 * broken on screen afterwards, because `components/materials-view.tsx` and
 * `lib/materials/order-page-data.ts` each spelled the rule out again from
 * `viewer.isAdmin` / `viewer.isAccountManager`. The server routes opened; the
 * buttons stayed hidden. A capability that the UI re-derives is not a
 * capability, so the seam is what gets asserted here — not just the function.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Files that render or serve the materials gates. */
const CONSUMERS = [
  "components/materials-view.tsx",
  "lib/materials/order-page-data.ts",
  "app/dashboard/materials/[woId]/order/page.tsx",
  "app/dashboard/materials/[woId]/order/[supplierId]/page.tsx",
];

describe("materials capability matrix", () => {
  const rows: Record<UserRole, { order: boolean; colors: boolean }> = {
    admin: { order: true, colors: true },
    // The ONE exclusion. If this ever flips to true, the greyed-button copy
    // and the two order-page denial screens are dead code.
    account_manager: { order: false, colors: true },
    regional_manager: { order: true, colors: true },
    rep: { order: true, colors: true },
  };

  for (const role of USER_ROLE_VALUES) {
    it(`${role}: ordering=${rows[role].order}, colours=${rows[role].colors}`, () => {
      const caps = capabilitiesFor(role);
      expect(caps.canOrderMaterials).toBe(rows[role].order);
      expect(caps.canEnterColors).toBe(rows[role].colors);
    });
  }

  it("the account manager is the only role that cannot order", () => {
    const blocked = USER_ROLE_VALUES.filter((r) => !capabilitiesFor(r).canOrderMaterials);
    expect(blocked).toEqual(["account_manager"]);
  });
});

describe("the gates reach the screen", () => {
  it.each(CONSUMERS)("%s derives from capabilitiesFor, never from isAdmin", (file) => {
    const src = read(file);

    // Strip comments — this very file's explanatory prose names the old
    // pattern, and so do the fix notes left in the source. Matching them
    // would make the test pass on a comment while the code stayed broken.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    // The banned shape: deciding a materials gate from the raw flags.
    const reDerived = [
      /canOrderMaterials\s*[:=]\s*[^;,\n]*\bviewer[?.\w]*\.isAdmin/,
      /canEnterColors\s*[:=]\s*[^;,\n]*\bviewer[?.\w]*\.(isAdmin|isAccountManager)/,
      /canOrderMaterials\s*[:=]\s*[^;,\n]*\bbundle\.viewer[?.\w]*\.isAdmin/,
    ];
    for (const re of reDerived) {
      expect(src.length > 0 && re.test(code), `${file} re-derives a gate: ${re}`).toBe(false);
    }
  });

  it("materials-view resolves both gates through one capability object", () => {
    const code = read("components/materials-view.tsx");
    expect(code).toMatch(/const caps = viewer \? capabilitiesFor\(viewer\.role\) : null;/);
    expect(code).toMatch(/const canOrderMaterials = caps\?\.canOrderMaterials \?\? false;/);
    expect(code).toMatch(/const canEnterColors = caps\?\.canEnterColors \?\? false;/);
  });

  it("no residential surface still tells the user ordering is admin-only", () => {
    for (const file of CONSUMERS) {
      const src = read(file);
      // Only the user-visible strings matter; comments may describe the history.
      const visible = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      expect(visible).not.toMatch(/Only admins can place material orders/);
      expect(visible).not.toMatch(/Ordering is admin-only/);
    }
  });
});
