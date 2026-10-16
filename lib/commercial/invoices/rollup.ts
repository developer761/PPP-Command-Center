/**
 * Phase 3 · Invoicing — per-account roll-up helpers.
 *
 * 2026-07-29 financial truth (supersedes the 2026-07-07 "include drafts"
 * choice): "Invoiced" = ISSUED invoices only (sent/viewed/partial/overdue/
 * paid). A DRAFT isn't billed to the GC yet, so it must NOT inflate Invoiced /
 * Balance — otherwise this rollup disagreed with the project card + Projects
 * tab (which are issued-only). Drafts are carried separately as `drafted_cents`
 * + `draft_count` so the UI can still surface "$X in N drafts not yet sent."
 * Balance = Invoiced (issued) − Paid.
 *
 * Overdue count uses deriveInvoiceStatus so overdue detection matches
 * the read-side derived status everywhere.
 */

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { deriveInvoiceStatus, DEFAULT_DUE_DAYS, type InvoiceStatus } from "./constants";
import { aiaDueAtFrom } from "@/lib/commercial/aia/constants";
import { daysPastDue } from "@/lib/commercial/reports/ar-aging";

export type AccountInvoiceRollup = {
  invoiced_cents: number;
  paid_cents: number;
  /** Net position = Invoiced − Paid (can go negative on an overpayment). Kept
   *  for internal math; the UI shows open_balance_cents / credit_cents so it
   *  ties out with the AR statement (audit F3). */
  balance_cents: number;
  /** TRUE open receivable = Σ max(0, per-invoice balance) over issued invoices —
   *  a credit on one invoice does NOT net away another's real open balance. This
   *  equals the AR statement's total-outstanding by construction. */
  open_balance_cents: number;
  /** Σ max(0, −per-invoice balance) — overpayment credits, surfaced separately
   *  so they never hide a genuine open balance. */
  credit_cents: number;
  invoice_count: number;
  /** Overdue DOCUMENTS — issued invoices past due PLUS AIA applications whose
   *  due-now amount (G702 line 6 − collected) is past due. It was invoices
   *  only, so LMJ's account page read "Overdue invoices 1 · $550" while the
   *  dashboard chased $15,725.71 across two documents — the overdue AIA #3 on
   *  Water Lilies Post Fire ($15,175.71, 27 days) simply wasn't looked at. */
  overdue_count: number;
  /** Σ past-due open balance across those same documents. Same ladder as the
   *  receivables report the dashboard's chase list reads (`aiaDueAtFrom`,
   *  `DEFAULT_DUE_DAYS`), so the two can't disagree about one GC. Retainage
   *  is never in it — it is held, not late. */
  overdue_cents: number;
  /** The AIA share of the two figures above, so a surface can name it. */
  overdue_aia_count: number;
  overdue_aia_cents: number;
  /** DRAFT invoices — not yet billed. Shown separately, never in Invoiced. */
  drafted_cents: number;
  draft_count: number;
  /** AIA billing folded in (2026-08-17). A job billed via G702/G703 writes NO
   *  `commercial_invoices` row, so this rollup — the Account 360 Collections
   *  tiles and the AR statement — read $0 for a GC being progress-billed
   *  hundreds of thousands of dollars. The amounts here are the AIA
   *  contribution ALREADY INCLUDED in the totals above, kept separately so a
   *  surface can say where the money came from. */
  aia_billed_cents: number;
  aia_collected_cents: number;
  /** Retainage the GC holds back. NOT in `open_balance_cents` — it isn't
   *  payable until close-out, and folding it in would age every AIA job past
   *  due by design. Surfaced so it can be shown beside what's owed now. */
  retainage_held_cents: number;
};

/**
 * Split issued-invoice net balances into the TRUE open receivable and the
 * overpayment credit, clamping PER INVOICE. A credit on one invoice must never
 * net away another invoice's real open balance (audit F3) — so this is not
 * `Σ balance`. `openBalance` equals the AR statement's total-outstanding by
 * construction. Pure + exported for unit tests.
 */
export function splitOpenBalance(issuedBalances: number[]): { openBalance: number; credit: number } {
  let openBalance = 0;
  let credit = 0;
  for (const b of issuedBalances) {
    if (b > 0) openBalance += b;
    else if (b < 0) credit += -b;
  }
  return { openBalance, credit };
}

const ZERO: AccountInvoiceRollup = {
  invoiced_cents: 0,
  paid_cents: 0,
  balance_cents: 0,
  open_balance_cents: 0,
  credit_cents: 0,
  invoice_count: 0,
  overdue_count: 0,
  overdue_cents: 0,
  overdue_aia_count: 0,
  overdue_aia_cents: 0,
  drafted_cents: 0,
  draft_count: 0,
  aia_billed_cents: 0,
  aia_collected_cents: 0,
  retainage_held_cents: 0,
};

type InvoiceRow = {
  invoice_number: string | null;
  opportunity_id: string | null;
  status: InvoiceStatus;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  due_at: string | null;
};

export async function getInvoiceRollupForAccount(account_id: string): Promise<AccountInvoiceRollup> {
  const sb = commercialDb();
  // Paginated — a long-running GC can accumulate well over 1000 invoices, and
  // the bare query silently capped at 1000, understating every Account-360 money
  // tile (invoiced / paid / balance) vs the paginated siblings (audit M5).
  const rows = await paginateAll<InvoiceRow>(() =>
    sb
      .from("commercial_invoices")
      // `invoice_number` + `opportunity_id` for the carry-over guard below.
      .select("invoice_number, opportunity_id, status, total_cents, paid_cents, balance_cents, due_at")
      .eq("account_id", account_id)
      .is("deleted_at", null)
      .order("id")
  );
  // AIA runs on its own ledger, so the invoice query above cannot see it. Pull
  // every live opportunity for this GC and fold each one's application rollup
  // in. Done BEFORE the early return: a GC billed only through AIA has zero
  // invoice rows, which is exactly the case that read $0.
  const aia = await aiaRollupForAccount(account_id);
  if (rows.length === 0 && !aia.hasAia) return ZERO;

  /*
   * The `SF-####` placeholder and this GC's certificates are ONE bill.
   *
   * Account 360's "Open balance" is the figure an account manager quotes on the
   * phone, and it read $372,962.39 for LMJ Management while the receivables
   * list we actually chase read $361,412.40 — the difference being invoice
   * SF-00268177 on a job billed and paid in full through its G702s. Same guard
   * as receivables, AR aging, the deal P&L and the GC's statement; see
   * lib/commercial/invoices/carryover.ts for why it is one helper now.
   */
  const { dealsBilledViaAia, isSupersededByAia } = await import("./carryover");
  const billedViaAia = await dealsBilledViaAia(rows.map((r) => r.opportunity_id ?? ""));
  const nonVoid = rows
    .filter((r) => !isSupersededByAia(r, billedViaAia))
    .filter((r) => r.status !== "void");
  const issued = nonVoid.filter((r) => r.status !== "draft");
  const drafts = nonVoid.filter((r) => r.status === "draft");
  const invoiced = issued.reduce((s, r) => s + r.total_cents, 0);
  const paid = issued.reduce((s, r) => s + r.paid_cents, 0);
  const balance = invoiced - paid;
  // Per-invoice clamp so an overpaid invoice's credit can't mask another
  // invoice's real open balance (audit F3). open_balance == AR statement total.
  const { openBalance, credit } = splitOpenBalance(issued.map((r) => r.balance_cents));
  const drafted = drafts.reduce((s, r) => s + r.total_cents, 0);
  const overdueRows = issued.filter((r) => deriveInvoiceStatus(r as unknown as { status: InvoiceStatus; due_at: string | null; balance_cents: number }) === "overdue");
  const overdueInvoiceCents = overdueRows.reduce((s, r) => s + Math.max(0, r.balance_cents), 0);

  return {
    invoiced_cents: invoiced + aia.billedCents,
    paid_cents: paid + aia.collectedCents,
    balance_cents: balance + aia.dueNowCents,
    // Net of retainage — see the type doc + aiaBilledCollectedFrom.
    open_balance_cents: openBalance + aia.dueNowCents,
    credit_cents: credit,
    invoice_count: nonVoid.length,
    overdue_count: overdueRows.length + aia.overdueCount,
    overdue_cents: overdueInvoiceCents + aia.overdueCents,
    overdue_aia_count: aia.overdueCount,
    overdue_aia_cents: aia.overdueCents,
    drafted_cents: drafted,
    draft_count: drafts.length,
    aia_billed_cents: aia.billedCents,
    aia_collected_cents: aia.collectedCents,
    retainage_held_cents: aia.retainageHeldCents,
  };
}

/**
 * Sum every AIA application across a GC's live opportunities.
 *
 * One bulk call rather than a fan-out per opportunity: `aiaBillingRollupBulk`
 * resolves the whole set in two queries and reuses the ONE `aiaBilledCollectedFrom`
 * definition the deal page and the project cards use — a second, account-level
 * SQL rollup is exactly how two surfaces start disagreeing about the same job.
 */
async function aiaRollupForAccount(account_id: string): Promise<{
  billedCents: number;
  collectedCents: number;
  dueNowCents: number;
  retainageHeldCents: number;
  overdueCents: number;
  overdueCount: number;
  hasAia: boolean;
}> {
  const sb = commercialDb();
  // PAGINATED. PostgREST caps a select at 1000 rows SILENTLY, so past that
  // every further opportunity drops out of this rollup and the Account 360
  // Invoiced / Paid / Balance / Retainage tiles understate with no sign of it.
  // The invoice read directly below is paginated for exactly this reason.
  const oppRows = await paginateAll<{ id: string }>(() =>
    sb
      .from("commercial_opportunities")
      .select("id")
      .eq("account_id", account_id)
      .is("deleted_at", null)
      .order("id", { ascending: true }),
  );
  const ids = oppRows.map((o) => o.id);
  const zero = {
    billedCents: 0,
    collectedCents: 0,
    dueNowCents: 0,
    retainageHeldCents: 0,
    overdueCents: 0,
    overdueCount: 0,
    hasAia: false,
  };
  if (ids.length === 0) return zero;
  const { aiaBillingRollupBulk } = await import("@/lib/commercial/aia/db");
  const rollups = await aiaBillingRollupBulk(ids);
  let acc = zero;
  for (const r of rollups.values()) {
    acc = {
      billedCents: acc.billedCents + r.billedCents,
      collectedCents: acc.collectedCents + r.collectedCents,
      dueNowCents: acc.dueNowCents + r.dueNowCents,
      retainageHeldCents: acc.retainageHeldCents + r.retainageHeldCents,
      overdueCents: acc.overdueCents,
      overdueCount: acc.overdueCount,
      hasAia: true,
    };
  }
  const overdue = aiaOverdueFrom([...rollups.values()], Date.now());
  return { ...acc, overdueCents: overdue.cents, overdueCount: overdue.count };
}

/**
 * The past-due part of a GC's AIA billing — per job, the due-now amount
 * (line 6 − collected, retainage excluded) when its latest issued
 * application is past the standard terms.
 *
 * The SAME test the receivables report applies to build its `aia` rows (and
 * so the dashboard's "What needs doing" chase list): due date from
 * `aiaDueAtFrom(frozenAt, periodTo, DEFAULT_DUE_DAYS)`, late when
 * `daysPastDue > 0`. Pure + exported so the rule is testable without a DB.
 */
export function aiaOverdueFrom(
  rollups: { dueNowCents: number; latestIssuedFrozenAt: string | null; latestIssuedPeriodTo: string | null }[],
  nowMs: number,
): { cents: number; count: number } {
  let cents = 0;
  let count = 0;
  for (const r of rollups) {
    if (r.dueNowCents <= 0) continue;
    const dueAt = aiaDueAtFrom(r.latestIssuedFrozenAt, r.latestIssuedPeriodTo, DEFAULT_DUE_DAYS);
    if (!dueAt || daysPastDue(dueAt, nowMs) <= 0) continue;
    cents += r.dueNowCents;
    count += 1;
  }
  return { cents, count };
}
