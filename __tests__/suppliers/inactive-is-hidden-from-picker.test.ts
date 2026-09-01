import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kate 2026-09-01: she deactivated the real suppliers so Jason + Alex would see
 * only "Vendor - Kate Test" while testing. Two things stood between her and
 * that outcome — the settings page served a cached list (fixed separately),
 * and `/api/suppliers/active` never filtered on `is_active` at all. It
 * returned 14 of 14 rows; the picker just dimmed the retired ones. The
 * checkbox has always claimed "Inactive — hidden from order workflow", so the
 * label was right and the code was wrong.
 *
 * This asserts the FILTER, not the wording.
 */

const ROOT = join(__dirname, "..", "..");
const ROUTE = join(ROOT, "app/api/suppliers/active/route.ts");

type Row = {
  supplier_account_id?: string;
  supplier_name?: string;
  order_email?: string | null;
  is_active?: boolean;
  phone_only?: boolean;
  phone_number?: string | null;
};

/** The predicate as the route applies it. Pinned to the shipped file below. */
function usable(r: Row): boolean {
  if (!r.supplier_account_id) return false;
  if (r.is_active === false) return false;
  const hasEmail = typeof r.order_email === "string" && r.order_email.length > 0;
  const hasPhone =
    Boolean(r.phone_only) && typeof r.phone_number === "string" && r.phone_number.length > 0;
  return hasEmail || hasPhone;
}

const PRODUCTION_SHAPE: Row[] = [
  { supplier_account_id: "a1", supplier_name: "Ricciardi Brothers Paint", order_email: "r@x.com", is_active: false },
  { supplier_account_id: "a2", supplier_name: "Ricciardi Brothers Clifton", order_email: "r2@x.com", is_active: false },
  { supplier_account_id: "a3", supplier_name: "Willis Paint Place", order_email: "w@x.com", is_active: false },
  { supplier_account_id: "a4", supplier_name: "Aboffs", order_email: "a@x.com", is_active: false },
  { supplier_account_id: "a5", supplier_name: "Vendor - Kate Test", order_email: "kate@x.com", is_active: true },
];

describe("inactive suppliers are hidden from the order picker", () => {
  it("leaves Jason + Alex with only the test vendor", () => {
    const shown = PRODUCTION_SHAPE.filter(usable).map((r) => r.supplier_name);
    expect(shown).toEqual(["Vendor - Kate Test"]);
  });

  it("a row predating the column still counts as active", () => {
    expect(usable({ supplier_account_id: "x", order_email: "e@x.com" })).toBe(true);
  });

  it("active but unconfigured is still excluded", () => {
    expect(usable({ supplier_account_id: "x", order_email: "", is_active: true })).toBe(false);
    expect(
      usable({ supplier_account_id: "x", order_email: null, is_active: true, phone_only: true, phone_number: "516-555-0100" })
    ).toBe(true);
  });

  it("the route really applies the is_active guard", () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toMatch(/if \(r\.is_active === false\) return false;/);
    expect(src).toMatch(/export const dynamic = "force-dynamic";/);
  });

  it("both callers ask for a fresh list", () => {
    for (const f of ["components/supplier-pick-list.tsx", "components/order-builder-view.tsx"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).toMatch(/fetch\("\/api\/suppliers\/active", \{ cache: "no-store" \}\)/);
    }
  });
});
