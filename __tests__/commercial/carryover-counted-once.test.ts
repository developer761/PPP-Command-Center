import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";
import { foldPeriodBilling, type PeriodInvoice, type PeriodAiaApp } from "@/lib/commercial/reports/period-billing";

/**
 * The migrated `SF-####` invoice and the AIA certificates on the same job are
 * ONE bill (lib/commercial/invoices/carryover.ts). LMJ Cipla read $187,754.18
 * billed on an $88,627.09 contract because a surface added both.
 *
 * Two halves:
 *
 *  1. VALUES — the dashboard's Gross revenue fold, given a carry-over on a job
 *     with an issued certificate, counts the job once. The other surfaces fixed
 *     with it (account hover card, assistant, Tomco deal reports, cash flow,
 *     due-date alerts) read the database and cannot be reached from a pure
 *     suite; they are covered by half 2.
 *
 *  2. COVERAGE — any file that reads the invoice ledger AND the AIA ledger has
 *     to call the guard, or be listed below with the reason it does not add
 *     the two together. Matched on code with comments stripped, so a docblock
 *     naming the helper does not count as calling it.
 */

const RANGE_ALL = null;

const inv = (over: Partial<PeriodInvoice>): PeriodInvoice => ({
  invoice_number: "INV-0001",
  status: "paid",
  subtotal_cents: 0,
  issued_at: "2026-03-01T15:00:00Z",
  created_at: "2026-03-01T15:00:00Z",
  opportunity_id: "cipla",
  ...over,
});
const app = (over: Partial<PeriodAiaApp>): PeriodAiaApp => ({
  id: "a1",
  opportunity_id: "cipla",
  application_number: 1,
  status: "paid",
  frozen_at: "2026-09-20T15:00:00Z",
  period_to: "2025-11-30",
  ...over,
});

describe("Gross revenue counts a carried-over job once", () => {
  // LMJ Cipla, to the cent: five paid certificates to $87,627.09, and the
  // importer's SF-00268177 at a $100,127.09 subtotal for the same work.
  const certified = new Map([["a5", 87_627_09]]);
  const apps = [app({ id: "a5", application_number: 5 })];
  const carryover = inv({ invoice_number: "SF-00268177", subtotal_cents: 100_127_09 });

  it("drops the SF- invoice on a job billed by issued certificate", () => {
    const b = foldPeriodBilling([carryover], apps, certified, RANGE_ALL, new Set(["cipla"]));
    expect(b.byOpp.get("cipla")).toBe(87_627_09);
    expect(b.totalCents).toBe(87_627_09);
  });

  it("still counts an ordinary invoice on that job — only the carry-over is the same money", () => {
    const extra = inv({ invoice_number: "INV-0042", subtotal_cents: 1_000_00 });
    const b = foldPeriodBilling([carryover, extra], apps, certified, RANGE_ALL, new Set(["cipla"]));
    expect(b.totalCents).toBe(87_627_09 + 1_000_00);
  });

  it("keeps the SF- invoice when the job's only certificate is a draft", () => {
    // A draft has billed nothing; the carry-over is still the only bill.
    const draftOnly = [app({ id: "d1", status: "draft" })];
    const b = foldPeriodBilling([carryover], draftOnly, new Map([["d1", 50_000_00]]), RANGE_ALL, new Set(["cipla"]));
    expect(b.totalCents).toBe(100_127_09);
  });

  it("keeps an SF- invoice on a different job", () => {
    const elsewhere = inv({ invoice_number: "SF-00273389", opportunity_id: "wip", subtotal_cents: 12_00 });
    const b = foldPeriodBilling([carryover, elsewhere], apps, certified, RANGE_ALL, new Set(["cipla", "wip"]));
    expect(b.byOpp.get("wip")).toBe(12_00);
    expect(b.byOpp.get("cipla")).toBe(87_627_09);
  });

  it("drops it from the monthly trend too, not just the total", () => {
    const b = foldPeriodBilling([carryover], apps, certified, RANGE_ALL, new Set(["cipla"]));
    expect(b.monthly.get("2026-03") ?? 0).toBe(0);
    expect(b.monthly.get("2025-11")).toBe(87_627_09);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "worktrees"].includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const READS_INVOICES = /["'`]commercial_invoices["'`]|["'`]commercial_invoice_payments["'`]|\blistCommercialInvoices\b/;
const READS_AIA =
  /\b(aiaBillingRollupBulk|aiaBillingRollup|aiaBilledCollectedFrom|foldPeriodBilling|loadPeriodBilling)\b|["'`]commercial_aia_(payments|line_items|applications)["'`]/;
const APPLIES_GUARD = /\b(isSupersededByAia|withoutCarryoverDuplicates)\s*\(/;

/**
 * Files that read both ledgers and do NOT add them together — each with why.
 * Being listed is a claim somebody made about the file; the stale-entry test
 * below makes sure the claim at least refers to a file that still holds both.
 */
const DOES_NOT_FOLD: Record<string, string> = {
  "lib/commercial/aia/db.ts": "defines the AIA rollup; its invoice reads resolve which change-order lines are already invoiced",
  "lib/commercial/accounting/entry-options.ts": "payment pickers: one option per invoice / certificate, no total",
  "lib/commercial/change-orders/db.ts": "bills a change order onto an invoice or the next application; writes, no totals",
  "lib/commercial/invoices/lien-waiver-link.ts": "attaches a lien-waiver document to one row",
  "lib/commercial/projects/ensure.ts": "a list of table names for the project cascade",
  "lib/commercial/reports/jobs.ts": "money comes from projects/db (guarded); AIA is read for retainage only",
  "lib/commercial/reports/transactions.ts":
    "a payment LEDGER, one row per recorded cheque for deposit tick-off; which copy of a cheque recorded on both ledgers to hide is an open decision, not a sum",
  "lib/commercial/reports/tomco/transactions.ts": "the same payment ledger, Tomco's layout",
  "app/commercial/accounts/[id]/change-orders/[dealId]/change-orders-tool.tsx":
    "reads draft invoices a change order can join, and whether the job bills by AIA",
  "app/commercial/opportunities/[id]/page.tsx": "shows the invoice ledger and the AIA ledger in separate tiles",
  "app/commercial/page.tsx": "hands its invoices to loadPeriodBilling, which applies the guard",
};

describe("every fold of invoices and AIA applies the carry-over guard", () => {
  const holders = [...walk("lib"), ...walk("app")].filter((f) => {
    const src = stripComments(readFileSync(f, "utf8"));
    return READS_INVOICES.test(src) && READS_AIA.test(src);
  });

  it("found the files at all", () => {
    // A zero-file scan that reports a pass has shipped here before.
    expect(holders.length).toBeGreaterThanOrEqual(15);
  });

  it("no file folds the two ledgers without the guard", () => {
    const unguarded = holders.filter(
      (f) => !(f in DOES_NOT_FOLD) && !APPLIES_GUARD.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(
      unguarded,
      "call isSupersededByAia / withoutCarryoverDuplicates (lib/commercial/invoices/carryover.ts) — or add the file to DOES_NOT_FOLD with the reason it never adds the two ledgers together",
    ).toEqual([]);
  });

  it("the surfaces fixed for this are guarded in code, not exempted", () => {
    for (const f of [
      "lib/commercial/reports/period-billing.ts",
      "lib/commercial/reports/cash-flow.ts",
      "lib/commercial/assistant/tools.ts",
      "lib/commercial/reports/tomco/opportunities.ts",
      "lib/commercial/cron/custom-notification-rules.ts",
      "lib/commercial/projects/db.ts",
    ]) {
      expect(f in DOES_NOT_FOLD, f).toBe(false);
      expect(APPLIES_GUARD.test(stripComments(readFileSync(f, "utf8"))), f).toBe(true);
    }
  });

  it("every exemption still names a file that reads both ledgers", () => {
    const stale = Object.keys(DOES_NOT_FOLD).filter((f) => !holders.includes(f));
    expect(stale, "remove these from DOES_NOT_FOLD").toEqual([]);
  });
});
