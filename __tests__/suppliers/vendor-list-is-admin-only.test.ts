/**
 * ONLY ADMINS CHANGE THE VENDOR LIST.
 *
 * Karan, 2026-10-14: "can the non-admins in PPP command center add Vendors, or
 * is that limited to admins? We want it to be admins only, otherwise the guys
 * will make the list get out of control."
 *
 * They cannot, and could not — the settings page redirects a non-admin and
 * every method on /api/admin/supplier-settings answers 403. What was wrong was
 * the OFFER: the vendor picker showed everyone an "Add" button, and a rep who
 * pressed it got a new tab that bounced straight back to the dashboard.
 *
 * Two different things are asserted below, and the difference matters:
 *
 *   - the GATE, which is the guarantee. A sweep, so a new route that writes
 *     the table cannot quietly skip it.
 *   - the OFFER, which is only tidiness. Hiding a button grants nothing; if
 *     these came apart again the list would still be safe.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isAdminProfile } from "@/lib/auth/roles";
import { stripComments } from "../helpers/strip-comments";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) =>
  stripComments(s);

function routeFiles(dir: string, out: string[] = []): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) routeFiles(rel, out);
    else if (e.name === "route.ts") out.push(rel);
  }
  return out;
}

/** Files that can change the curated vendor list, found rather than listed. */
const WRITERS = routeFiles("app/api").filter((f) => {
  const s = strip(read(f));
  return (
    s.includes('from("supplier_settings")') &&
    /\.(insert|upsert|update|delete)\s*\(/.test(s)
  );
});

describe("the gate — what actually keeps the list under control", () => {
  it("found the writer(s) to check", () => {
    // An audit that scanned nothing passes for the wrong reason.
    expect(routeFiles("app/api").length).toBeGreaterThan(50);
    expect(WRITERS.length).toBeGreaterThan(0);
  });

  it("every route that writes the vendor list refuses a non-admin", () => {
    const ungated = WRITERS.filter((f) => {
      const s = strip(read(f));
      const decides = s.includes("isAdminProfile(") || s.includes('roleForProfile(');
      const refuses = /403/.test(s);
      return !(decides && refuses);
    });
    expect(ungated, `writes supplier_settings with no admin refusal:\n${ungated.join("\n")}`)
      .toEqual([]);
  });

  it("gates each HTTP method, not just one of them", () => {
    // A route whose POST is gated and whose PUT is not is the shape this
    // misses if you only check the file as a whole.
    for (const f of WRITERS) {
      const s = strip(read(f));
      const methods = [...s.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
      expect(methods.length, `${f} exports no handlers?`).toBeGreaterThan(0);
      const gates = (s.match(/isAdminProfile\(|roleForProfile\(/g) ?? []).length;
      expect(gates, `${f}: ${methods.length} handlers but only ${gates} admin check(s)`)
        .toBeGreaterThanOrEqual(methods.length);
    }
  });

  it("the settings page turns a non-admin away too", () => {
    // Otherwise the form renders and every save 403s.
    const s = strip(read("app/dashboard/settings/suppliers/page.tsx"));
    expect(s).toContain("isAdminProfile(");
    expect(s).toMatch(/redirect\(["']\/dashboard["']\)/);
  });

  it("uses the shared derivation, so it cannot drift from the sidebar", () => {
    // The 2026-10-05 bug: one surface read is_admin directly, the others
    // normalized the role, and jason.eng@ was offered a page he was refused.
    for (const f of [...WRITERS, "app/dashboard/settings/suppliers/page.tsx"]) {
      expect(strip(read(f)), f).not.toMatch(/profile\??\.is_admin\s*\?\?/);
    }
  });

  it("agrees that an account manager is not an admin", () => {
    // The roles that exist on real rows. AMs place orders; they do not curate.
    expect(isAdminProfile({ role: "admin", is_admin: false })).toBe(true);
    expect(isAdminProfile({ role: "account_manager", is_admin: true })).toBe(false);
    expect(isAdminProfile({ role: "rep", is_admin: true })).toBe(false);
    expect(isAdminProfile(null)).toBe(false);
  });
});

describe("the one write a non-admin CAN make", () => {
  const favorites = () => strip(read("app/api/suppliers/favorites/route.ts"));

  it("starring a vendor cannot create one", () => {
    // Favorites are ungated on purpose — a preference, not a permission. The
    // hole would be if they wrote the vendor table instead of their own.
    const s = favorites();
    expect(s).not.toContain('from("supplier_settings")');
    expect(s).toContain('from("supplier_favorites")');
  });

  it("scopes every favorite write to the person making it", () => {
    const s = favorites();
    expect(s).toMatch(/upsert\(\{\s*user_id: userId/);
    expect(s).toMatch(/\.delete\(\)[\s\S]{0,80}?\.eq\("user_id", userId\)/);
  });
});

describe("the offer — not a guarantee, just not a dead end", () => {
  const picker = () => strip(read("components/supplier-pick-list.tsx"));

  it("hides Add from anyone who cannot use it", () => {
    expect(picker()).toMatch(/\{canManageVendors && \(\s*<a/);
  });

  it("defaults to hidden, so a slow or failed check shows no dead button", () => {
    expect(picker()).toMatch(/useState\(false\)[^\n]*\n?/);
    expect(picker()).toContain("const [canManageVendors, setCanManageVendors] = useState(false)");
  });

  it("tells a rep who CAN add one instead of leaving a blank", () => {
    expect(picker()).toMatch(/Ask an admin to add one/);
  });

  it("takes the answer from the viewer, never recomputing it", () => {
    const s = favoritesSrc();
    expect(s).toContain("resolveViewer");
    expect(s).toMatch(/canManageVendors = v\?\.isAdmin === true/);
    // No private opinion about who is an admin.
    expect(s).not.toContain("isAdminEmail");
  });

  function favoritesSrc() {
    return strip(read("app/api/suppliers/favorites/route.ts"));
  }

  it("sends it on the response the picker already fetches", () => {
    // A second round trip for one boolean would be the wrong fix.
    expect(favoritesSrc()).toMatch(/canManageVendors,/);
    expect(picker()).toMatch(/setCanManageVendors\(data\?\.canManageVendors === true\)/);
  });
});
