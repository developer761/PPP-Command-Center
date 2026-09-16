import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The wipe script, checked against the schema it has to empty.
 *
 * It had never been run when it was needed, and reading it against the live
 * schema found three faults: it deleted work orders BEFORE the jobs that
 * reference them (so the first real run would have rolled the whole thing
 * back), it missed six tables, and it could not get past the e-signature
 * trail's append-only guard.
 *
 * A table added later would be missed the same silent way — the wipe would
 * "succeed" and leave rows pointing at records that no longer exist, which is
 * exactly what a fresh client database must not start with. So every
 * commercial_* table has to be named in ONE of two places: the script, or the
 * KEEP list below with a reason.
 */

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "scripts", "wipe-commercial-data.sql"), "utf8");

/** Setup Tomco needs on the other side of the wipe. Everything else is data. */
const KEEP: Record<string, string> = {
  commercial_operating_company: "who we are on every document",
  commercial_vendors: "the 44 vendors imported from Salesforce",
  commercial_products: "the price book",
  commercial_customer_prices: "per-GC pricing, tied to the price book",
  commercial_exclusions: "the proposal exclusions library",
  commercial_tax_jurisdictions: "sales tax by ZIP",
  commercial_account_rating_labels: "A/B/C labels",
  commercial_settings: "settings (one stale key is deleted by hand)",
  commercial_user_roles: "who is an admin",
  commercial_user_email_prefs: "email opt-ins",
  commercial_teams: "Tomco Suffolk survives; test teams are deleted by name",
  commercial_team_members: "same",
  commercial_notification_rules: "custom alert rules",
  commercial_report_folders: "Manager / Finance / Field Users",
  commercial_report_folder_items: "which reports are in them",
  commercial_report_folder_members: "who is in them",
  commercial_audit_log: "the record of what was done, kept on purpose",
  commercial_user_slack: "table was dropped in migration 077",
};

/** Every commercial_* table the migrations create. */
function createdTables(): string[] {
  const dir = join(ROOT, "supabase", "migrations");
  const found = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const src = readFileSync(join(dir, f), "utf8")
      // Comments first: "CREATE TABLE ... commercial_foo" inside a note is not
      // a table, and this file has plenty of prose about tables.
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(commercial_[a-z_]+)/gi)) {
      found.add(m[1].toLowerCase());
    }
  }
  return [...found].sort();
}

/**
 * Emptied vs pruned. `DELETE FROM x;` clears the table; `DELETE FROM x WHERE …`
 * removes some rows and keeps the rest — which is how "Tomco Suffolk stays, the
 * test teams go" is expressed. Treating the second as a wipe would let a table
 * that is only partly cleared pass as fully handled.
 */
function deletesIn(sql: string): { full: Set<string>; pruned: Set<string> } {
  const full = new Set<string>();
  const pruned = new Set<string>();
  for (const stmt of sql.replace(/--[^\n]*/g, "").split(";")) {
    const m = /DELETE\s+FROM\s+(?:public\.)?(commercial_[a-z_]+)/i.exec(stmt);
    if (!m) continue;
    (/\bWHERE\b/i.test(stmt) ? pruned : full).add(m[1].toLowerCase());
  }
  return { full, pruned };
}

const { full: deleted, pruned } = deletesIn(SQL);

describe("the wipe empties every commercial table, or says why not", () => {
  it("names every table either in the script or in the KEEP list", () => {
    const created = createdTables();
    // Sanity: if this ever reads zero tables the whole test is vacuous.
    expect(created.length).toBeGreaterThan(40);
    const unaccounted = created.filter((t) => !deleted.has(t) && !(t in KEEP));
    expect(unaccounted, `not wiped and not on the KEEP list: ${unaccounted.join(", ")}`).toEqual([]);
  });

  it("never EMPTIES a table it claims to keep", () => {
    // A KEEP table may be pruned (test teams out, Tomco Suffolk in). Emptying
    // one would take the setup with it.
    const emptied = Object.keys(KEEP).filter((t) => deleted.has(t));
    expect(emptied, `KEEP says keep, the script empties: ${emptied.join(", ")}`).toEqual([]);
  });

  it("prunes rather than empties the tables that hold both setup and test rows", () => {
    for (const t of ["commercial_settings", "commercial_teams", "commercial_team_members"]) {
      expect(pruned.has(t), `${t} should be pruned with a WHERE, not emptied`).toBe(true);
    }
  });

  it("deletes field-ops jobs BEFORE the work orders they point at", () => {
    // commercial_jobs.work_order_id references commercial_work_orders with no
    // ON DELETE rule (migration 112). The other order aborts the transaction.
    const jobs = SQL.indexOf("DELETE FROM public.commercial_jobs");
    const workOrders = SQL.indexOf("DELETE FROM public.commercial_work_orders");
    expect(jobs).toBeGreaterThan(-1);
    expect(workOrders).toBeGreaterThan(-1);
    expect(jobs, "jobs must be deleted before work orders").toBeLessThan(workOrders);
  });

  it("opts out of the e-signature append-only guard, inside the transaction", () => {
    // Without this the cascade from proposals hits the guard and NOTHING runs.
    const guard = SQL.indexOf("commercial.allow_signature_event_delete");
    const begin = SQL.indexOf("BEGIN;");
    const commit = SQL.indexOf("COMMIT;");
    expect(guard).toBeGreaterThan(begin);
    expect(guard).toBeLessThan(commit);
    expect(SQL).toMatch(/SET\s+LOCAL\s+commercial\.allow_signature_event_delete\s*=\s*'on'/i);
  });

  it("only clears commercial rows from the SHARED notifications table", () => {
    const line = SQL.split("\n").find((l) => /DELETE FROM public\.notifications/.test(l));
    expect(line, "the wipe should clear commercial bells").toBeTruthy();
    // A bare DELETE here would wipe the residential Command Center's bells too.
    expect(line).toMatch(/WHERE kind LIKE 'commercial/i);
  });

  it("runs as one transaction, so a failure leaves the data intact", () => {
    expect(SQL.indexOf("BEGIN;")).toBeGreaterThan(-1);
    expect(SQL.indexOf("COMMIT;")).toBeGreaterThan(SQL.indexOf("BEGIN;"));
  });
});
