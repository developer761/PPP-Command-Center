import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

import { ASSIGNMENT_ROLES } from "@/lib/commercial/accounts/assignment-roles";
import { CONTACT_ROLES } from "@/lib/commercial/contacts/roles";
import { EXCLUSION_CATEGORIES, EXCLUSION_KINDS } from "@/lib/commercial/exclusions/constants";
import { OPPORTUNITY_STATUSES } from "@/lib/commercial/opportunities/constants";
import { PROPOSAL_STATUSES } from "@/lib/commercial/proposals/constants";
import { INVOICE_STATUSES } from "@/lib/commercial/invoices/constants";
import { SUBMITTAL_STATUSES } from "@/lib/commercial/opportunities/submittal-constants";
import { WORK_ORDER_STATUSES } from "@/lib/commercial/work-orders/constants";
import { CLOSEOUT_ITEM_STATUSES } from "@/lib/commercial/closeout/constants";
import { EMPLOYEE_ROLES } from "@/lib/commercial/field-ops/employees";

/**
 * THE AUDIT THAT SHOULD HAVE EXISTED.
 *
 * Karan 2026-08-21: "why did we have so many issues if we did so many audits.
 * We need to rethink how we audit."
 *
 * This exact bug has now shipped to a user TWICE:
 *
 *   136 — Brendan's four roles were added to the app and never to the DB.
 *         Karan hit it adding Test Partner to Devin's Contracting.
 *   166 — the SAME four, on commercial_team_members, which 136 missed.
 *         Stephanie hit it as "I can't add team members"; the table had zero
 *         rows because nobody had ever managed to submit that form.
 *
 * Both were the same shape: a picker offering values Postgres refuses. Nothing
 * catches it, because the two lists are the same list maintained in two
 * languages — and a type-check can only see one of them. It fails at the
 * moment a real person presses Save, with a raw constraint error.
 *
 * A human audit cannot reliably catch this: it means holding ~79 CHECK
 * constraints in your head while reading TypeScript. So it is a test.
 *
 * ADDING A PICKER-BACKED COLUMN? Add it here. An entry that is missing is a
 * bug waiting for the person who picks the third option in a dropdown.
 */

const MIG_DIR = "supabase/migrations";

/**
 * Which values does the DB actually permit for this constraint?
 *
 * Later migrations replace earlier ones, so the LAST definition wins —
 * the same way they do when applied in order. ROLLBACK_* files are
 * excluded: they exist to be run by hand if something goes wrong, and
 * treating one as current would test a schema nobody is running.
 */
function allowedByDb(table: string, column: string): string[] {
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && !f.startsWith("ROLLBACK"))
    .sort();
  let allowed: string[] = [];
  for (const f of files) {
    // Strip `--` comments FIRST. Migration 136's own comment reads
    // "-- Brendan's four, the only ones the UI offers." — and that apostrophe
    // opens a phantom SQL string, so quote-pair parsing over the raw file
    // returns garbage instead of the role list. The first version of this test
    // silently fell back to the pre-136 values because of it, and reported the
    // two tables that HAD been fixed as still broken.
    const sql = readFileSync(`${MIG_DIR}/${f}`, "utf8").replace(/--[^\n]*/g, "");

    // Form 1 — a NAMED constraint added later to widen or replace:
    //   ALTER TABLE x ADD CONSTRAINT x_col_check CHECK (col IN ('a','b'))
    const named = new RegExp(
      `ALTER\\s+TABLE\\s+(?:public\\.)?${table}\\b[\\s\\S]{0,400}?ADD\\s+CONSTRAINT[\\s\\S]{0,120}?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
      "i"
    );
    // Form 2 — declared INLINE in the CREATE TABLE. Postgres auto-names these
    // `<table>_<column>_check`, so the name never appears in the SQL and a
    // name-based search finds nothing. That gap is why the first version of
    // this test reported "no CHECK found" for half the registry.
    const createAt = new RegExp(`create\\s+table[^(]*?(?:public\\.)?${table}\\s*\\(`, "i").exec(sql);
    let inlineMatch: RegExpExecArray | null = null;
    if (createAt) {
      const body = sql.slice(createAt.index + createAt[0].length);
      inlineMatch = new RegExp(
        `\\b${column}\\s+text[^,]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
        "i"
      ).exec(body);
    }

    const m = named.exec(sql) ?? inlineMatch;
    if (!m) continue;
    const values = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    if (values.length > 0) allowed = values;
  }
  return allowed;
}

type Row = {
  /** Where a person picks the value. */
  where: string;
  table: string;
  column: string;
  appValues: readonly string[];
};

const REGISTRY: Row[] = [
  // The two that actually broke, in production, on a real person.
  { where: "Account → Team", table: "commercial_account_assignments", column: "role", appValues: ASSIGNMENT_ROLES },
  { where: "Settings → Teams", table: "commercial_team_members", column: "role", appValues: ASSIGNMENT_ROLES },

  { where: "Opportunity → Contacts on this job", table: "commercial_opportunity_contacts", column: "role", appValues: CONTACT_ROLES },
  { where: "Exclusions library — category", table: "commercial_exclusions", column: "category", appValues: EXCLUSION_CATEGORIES },
  { where: "Exclusions library — prints under", table: "commercial_exclusions", column: "kind", appValues: EXCLUSION_KINDS },
  { where: "Opportunity status picker", table: "commercial_opportunities", column: "status", appValues: OPPORTUNITY_STATUSES },
  { where: "Proposal lifecycle", table: "commercial_proposals", column: "status", appValues: PROPOSAL_STATUSES },
  { where: "Invoice lifecycle", table: "commercial_invoices", column: "status", appValues: INVOICE_STATUSES },
  { where: "Submittal status", table: "commercial_opp_submittals", column: "status", appValues: SUBMITTAL_STATUSES },
  { where: "Work order status", table: "commercial_work_orders", column: "status", appValues: WORK_ORDER_STATUSES },
  { where: "Field Ops → employee role", table: "commercial_employees", column: "role", appValues: EMPLOYEE_ROLES },
];

describe("every value the app can WRITE is permitted by the database", () => {
  for (const row of REGISTRY) {
    it(`${row.where} — ${row.table}.${row.column}`, () => {
      const allowed = allowedByDb(row.table, row.column);
      expect(
        allowed.length,
        `No CHECK found for ${row.table}.${row.column} — either the column lost its ` +
          `constraint, or this registry entry now checks nothing.`
      ).toBeGreaterThan(0);
      const rejected = row.appValues.filter((v) => !allowed.includes(v));
      expect(
        rejected,
        `${row.where} offers ${JSON.stringify(rejected)}, which Postgres will REJECT. ` +
          `Picking one gives the user a raw constraint error. Widen ${row.table}.${row.column} ` +
          `in a new migration — widen, never replace, or rows already stored stop validating.`
      ).toEqual([]);
    });
  }
});

describe("closeout item status", () => {
  // Not in the registry above because the app deliberately relabels rather than
  // renames: Stephanie asked for "Sent" instead of "Received", and the STORED
  // value stayed `received` precisely so the constraint and every existing row
  // keep working. This pins that decision — a future rename of the value would
  // have to change the DB too.
  it("still stores the values the constraint permits", () => {
    expect([...CLOSEOUT_ITEM_STATUSES]).toEqual(["pending", "received", "na"]);
  });
});
