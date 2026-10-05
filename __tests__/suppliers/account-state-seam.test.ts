import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankVendors } from "@/lib/supplier-order/vendor-ranking";

/**
 * Karan 2026-10-05: everyone sets their own state from Account settings, so the
 * NJ/NY vendor filter stops depending on an admin typing twenty codes.
 *
 * That makes a SEAM, and the seam is the whole risk: the value is written by
 * /api/account/state and read back by /api/suppliers/favorites. If those two
 * disagree about whose row to touch, or about the shape of the value, the box
 * saves cleanly and the vendor list never changes — the exact bug nobody
 * reports as "broken", only as "it doesn't do anything".
 *
 * These assert the two halves agree. The pure ranking behavior is covered by
 * vendor-ranking.test.ts and is not repeated here.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Source with comments and string literals stripped, so a rule can never be
 *  satisfied by prose describing it. (See the repo's own note about a test that
 *  matched its own docblock.) */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

describe("the state a person saves is the state their vendor list reads", () => {
  it("writes with the real signed-in id, not a proxy target", () => {
    // /api/suppliers/favorites reads the state with resolveViewer().supabaseUserId,
    // which is the REAL signed-in user even mid-proxy. The writer therefore has
    // to resolve the same person, which supabase.auth.getUser() does.
    //
    // A future edit to resolveViewer/getProfileByUserId here would save onto the
    // proxy target's row while the picker kept reading the admin's — so this
    // pins the one call that keeps them on the same row.
    const route = code("app/api/account/state/route.ts");
    expect(route).toMatch(/supabase\.auth\.getUser\(\)/);
    expect(route).not.toMatch(/getProfileByUserId|resolveViewer/);
  });

  it("never lets the caller name whose row to write", () => {
    // The reason this route is allowed to live outside app/api/admin/. The body
    // carries a state and nothing else; the moment it reads a user id from the
    // request, any signed-in person could set anybody's vendor list.
    const route = code("app/api/account/state/route.ts");
    expect(route).not.toMatch(/body\.user_?[Ii]d|body\.userId/);
    expect(route).toMatch(/user_id:\s*userId/);
  });

  it("goes through updateUserState, so the profile cache is cleared", () => {
    // The 30-second profile cache is why this matters. /api/account/phone writes
    // the column directly and skips invalidateProfileCache; copying that here
    // would mean a person sets their state, orders immediately, and sees the old
    // vendor list for half a minute with no clue why.
    const route = code("app/api/account/state/route.ts");
    expect(route).toMatch(/updateUserState/);
    expect(route).not.toMatch(/from\(["']profiles["']\)/);

    // …and updateUserState is in fact the thing that clears it.
    expect(code("lib/auth/user-management.ts")).toMatch(
      /updateUserState[\s\S]{0,1400}invalidateProfileCache/
    );
  });

  it("stores the uppercase two-letter form the filter compares against", () => {
    // vendorIsInScope requires exactly two characters; it treats anything else
    // as "unset" and shows every vendor. So "nj " or "Nj" reaching the column
    // would silently disable the filter for that person.
    const mgmt = code("lib/auth/user-management.ts");
    expect(mgmt).toMatch(/updateUserState[\s\S]{0,400}toUpperCase\(\)/);
    expect(mgmt).toMatch(/updateUserState[\s\S]{0,600}\/\^\[A-Z\]\{2\}\$\//);

    // Proven at the consuming end rather than assumed: a stored "NJ" filters,
    // and the untrimmed forms the input could produce do not reach the column.
    const vendors = [
      { accountId: "ricciardi", name: "Ricciardi Brothers Clifton", state: "NJ" },
      { accountId: "aboffs", name: "Aboffs", state: "NY" },
    ];
    expect(rankVendors({ vendors, userState: "NJ" }).map((r) => r.vendor.accountId)).toEqual([
      "ricciardi",
    ]);
  });

  it("clearing the box shows every vendor rather than none", () => {
    // The deliberate escape hatch. Someone who empties the field must not end up
    // with an empty picker and no way to understand why.
    const route = code("app/api/account/state/route.ts");
    // An empty string must survive to updateUserState, which maps "" -> null.
    expect(route).toMatch(/typeof body\.state === ["']string["']/);
    expect(code("lib/auth/user-management.ts")).toMatch(
      /updateUserState[\s\S]{0,500}raw \|\| null/
    );

    const vendors = [
      { accountId: "ricciardi", name: "Ricciardi Brothers Clifton", state: "NJ" },
      { accountId: "aboffs", name: "Aboffs", state: "NY" },
    ];
    expect(rankVendors({ vendors, userState: null })).toHaveLength(2);
  });
});

describe("the control is reachable by the people who need it", () => {
  it("sits on the account page, which is NOT admin-gated", () => {
    const page = code("app/dashboard/account/page.tsx");
    expect(page).toMatch(/AccountStateForm/);
    // The whole point of the change. If this page ever grows an admin redirect,
    // the self-serve rollout is silently undone.
    expect(page).not.toMatch(/redirect\(["']\/dashboard["']\)/);
  });

  it("is linked from the top-right menu", () => {
    // Karan's words were "clicking account settings on the top right". That link
    // already existed; this pins that it still points where the form lives.
    expect(code("components/user-menu.tsx")).toMatch(/\/dashboard\/account/);
  });

  it("shows the row it will write to, even mid-proxy", () => {
    // getProfileByUserId swaps in the proxy TARGET's profile, but the route
    // writes the real user's row. Without ignoreProxy the field would display
    // one person's state and overwrite another's.
    const page = code("app/dashboard/account/page.tsx");
    expect(page).toMatch(/ignoreProxy:\s*true/);
    expect(page).toMatch(/AccountStateForm\s+initial=\{ownProfile\?\.state/);
  });
});

describe("a two-letter typo cannot empty the vendor picker", () => {
  it("rejects a code that is shaped like a state but isn't one", () => {
    // Found by using it: POST {state:"ZZ"} returned 200 and saved. "ZZ" then
    // matched no vendor, so vendorIsInScope filtered EVERY vendor out and the
    // picker rendered an empty box. One slipped key on NJ — "NU", "MJ", "NH" —
    // did the same, and the person had no way to tell what had happened.
    const mgmt = code("lib/auth/user-management.ts");
    expect(mgmt).toMatch(/US_STATE_CODES/);
    expect(mgmt).toMatch(/updateUserState[\s\S]{0,900}US_STATE_CODES\.has\(raw\)/);

    // The real codes are present and the invented ones are not.
    for (const real of ["NY", "NJ", "FL", "CT", "PA"]) {
      expect(mgmt, real).toMatch(new RegExp(`"${real}"`));
    }
    for (const fake of ["ZZ", "NU", "QX"]) {
      expect(mgmt, fake).not.toMatch(new RegExp(`"${fake}"`));
    }
  });

  it("explains an empty picker instead of rendering nothing", () => {
    // The empty branch judged `filtered` (post-search) while the state filter
    // ran afterwards into `ranked`. A state matching no vendor therefore had
    // filtered.length > 0 and ranked.length === 0, fell through every branch,
    // and drew a blank box. Still reachable without a typo: a real state we
    // have no vendor in yet, e.g. a first hire in CT.
    const list = code("components/supplier-pick-list.tsx");
    expect(list).toMatch(/ranked\.length === 0/);
    expect(list).not.toMatch(/!error && filtered\.length === 0/);
    // …and the message has to name the state and offer the way out, or it is
    // an empty screen that still doesn't say why.
    expect(list).toMatch(/No vendors in/);
    expect(list).toMatch(/\/dashboard\/account/);
  });
});
