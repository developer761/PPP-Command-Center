import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  INVOICE_STATUSES,
  BILLABLE_INVOICE_STATUSES,
  TERMINAL_INVOICE_STATUSES,
} from "@/lib/commercial/invoices/constants";

/**
 * "Outstanding AR" is defined once — BILLABLE_INVOICE_STATUSES — and read by
 * the dashboard AR tile, the account rollup, and the opportunity's "Still out"
 * figure. Round-3 handoff #4: the opportunity page had hand-rolled a LOCAL set
 * {sent, partial, overdue} that dropped 'viewed', so an invoice a GC had opened
 * but not paid stopped counting as money still out on one screen while the KPI
 * strip beside it still counted it. This pins the canonical set (so 'viewed'
 * can't be dropped again) and checks it against the Postgres CHECK constraint,
 * which TypeScript can't see.
 */

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

/** Values of the LAST `CHECK (status IN (...))` on commercial_invoices across
 *  all migrations (last wins — a later migration can drop and re-add it). */
function checkedInvoiceStatuses(): string[] | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let found: string[] | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    for (const stmt of sql.split(";")) {
      if (!stmt.includes("commercial_invoices")) continue;
      // CHECK-context only, so a WHERE status IN (...) can't masquerade as the
      // constraint. `\bstatus` skips inv_status inside trigger bodies.
      for (const m of stmt.matchAll(/CHECK\s*\(\s*\bstatus\s+IN\s*\(([^)]*)\)/gi)) {
        const vals = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
        if (vals.length > 0) found = vals;
      }
    }
  }
  return found;
}

describe("invoice billable statuses ↔ constants ↔ DB", () => {
  it("BILLABLE includes 'viewed' — the round-3 #4 regression", () => {
    expect(BILLABLE_INVOICE_STATUSES.has("viewed")).toBe(true);
  });

  it("BILLABLE is exactly the outstanding-AR set", () => {
    expect([...BILLABLE_INVOICE_STATUSES].sort()).toEqual(
      ["overdue", "partial", "sent", "viewed"].sort()
    );
  });

  it("BILLABLE excludes not-yet-billed and settled statuses", () => {
    for (const s of ["draft", "paid", "void"] as const) {
      expect(BILLABLE_INVOICE_STATUSES.has(s)).toBe(false);
    }
  });

  it("TERMINAL is exactly paid + void", () => {
    expect([...TERMINAL_INVOICE_STATUSES].sort()).toEqual(["paid", "void"]);
  });

  it("every stored status is permitted by the DB CHECK constraint", () => {
    const checked = checkedInvoiceStatuses();
    expect(checked, "no CHECK (status IN …) found for commercial_invoices").not.toBeNull();
    for (const s of INVOICE_STATUSES) {
      expect(checked, `stored status '${s}' missing from DB CHECK`).toContain(s);
    }
  });

  it("every billable status (except computed 'overdue') is a real stored status", () => {
    // 'overdue' is derived on read, never written, so it isn't in the stored set.
    for (const s of BILLABLE_INVOICE_STATUSES) {
      if (s === "overdue") continue;
      expect(INVOICE_STATUSES).toContain(s);
    }
  });
});
