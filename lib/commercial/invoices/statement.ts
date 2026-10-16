import "server-only";

/**
 * Phase 1C — Open-invoice AR statement (per GC/account).
 *
 * A "statement of account": every OPEN invoice a customer owes on — unpaid,
 * partially paid, or overdue (excludes draft/void/fully-paid) — with its
 * balance, plus the total outstanding and a standard 5-bucket aging (current /
 * 1-30 / 31-60 / 61-90 / 90+ days past due). Pure/server so the on-screen view
 * and the branded PDF share one source of truth.
 */

import { listCommercialInvoices } from "./db";
import { listCommercialOpportunities, derivedOppName } from "@/lib/commercial/opportunities/db";
import { deriveInvoiceStatus, DEFAULT_DUE_DAYS, type InvoiceStatus } from "./constants";
import { isSupersededByAia } from "./carryover";
import { aiaDueAtFrom } from "@/lib/commercial/aia/constants";
import { daysPastDue as arDaysPastDue } from "@/lib/commercial/reports/ar-aging";
import { safeNowMs } from "@/lib/commercial/now";

export type ARStatementRow = {
  invoiceId: string;
  invoiceNumber: string;
  /** "invoice" | "aia" — an AIA-billed job raises no invoice, so its payment
   *  application IS the receivable. The GC recognises "Application No. 3"
   *  exactly as it recognises an invoice number. */
  kind?: "invoice" | "aia";
  dealName: string;
  issuedAt: string | null;
  dueAt: string | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  /** Derived status (sent/viewed/partial/overdue). */
  status: InvoiceStatus;
  /** Whole days past the due date (0 or negative → not yet due). null → no due date. */
  daysPastDue: number | null;
};

export type ARAgingBucket = { cents: number; count: number };
export type ARAging = {
  current: ARAgingBucket; // not yet due (or no due date)
  d1_30: ARAgingBucket;
  d31_60: ARAgingBucket;
  d61_90: ARAgingBucket;
  d90_plus: ARAgingBucket;
};

export type ARStatement = {
  accountId: string;
  rows: ARStatementRow[];
  totalOutstandingCents: number;
  /** Retainage the GC holds across this account's AIA jobs. Deliberately NOT in
   *  `totalOutstandingCents`: it isn't payable until close-out, and bucketing it
   *  by age would show every progress-billed job as 90+ days past due when the
   *  GC is perfectly current. Stated as its own line so it is never invisible. */
  retainageHeldCents: number;
  aging: ARAging;
  /** ISO timestamp the statement was generated (caller stamps for the PDF). */
  generatedAt: string;
};

const emptyBucket = (): ARAgingBucket => ({ cents: 0, count: 0 });

/**
 * Which aging column an open invoice lands in. `daysPastDue` floors the elapsed
 * days (null → no due date). `isOverdue` is the derived-status verdict, which
 * flips the instant `now > due_at` — so an invoice overdue by < 1 day floors to
 * 0 yet must NOT read as "Current" (it's already red + in overdue_count). Pure +
 * exported so the boundary is unit-tested (audit F8).
 */
export function agingBucketKey(daysPastDue: number | null, isOverdue: boolean): keyof ARAging {
  if (daysPastDue == null || (daysPastDue <= 0 && !isOverdue)) return "current";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90_plus";
}

/**
 * Build the open-invoice statement for one account. `now` is injectable so the
 * PDF route + the on-screen view render identical aging for the same request.
 */
export async function getOpenInvoiceStatementForAccount(
  accountId: string,
  now: number = Date.now()
): Promise<ARStatement> {
  now = safeNowMs(now, "statement");
  const [invoices, opps] = await Promise.all([
    listCommercialInvoices({ accountId }),
    listCommercialOpportunities({ accountId, includeArchived: true }),
  ]);
  const oppById = new Map(opps.map((o) => [o.id, o]));

  const rows: ARStatementRow[] = [];
  const aging: ARAging = {
    current: emptyBucket(),
    d1_30: emptyBucket(),
    d31_60: emptyBucket(),
    d61_90: emptyBucket(),
    d90_plus: emptyBucket(),
  };
  let totalOutstandingCents = 0;

  /*
   * 🔴 THE CARRY-OVER GUARD HAS TO RUN ON THE DOCUMENT THAT LEAVES THE BUILDING.
   *
   * `isSalesforceCarryoverInvoice` exists because once a job's real billing is
   * in the platform as an issued AIA application, the migrated `SF-####`
   * placeholder and the certificate are the same money twice. Its own docblock
   * says it is "applied by getReceivablesReport and getArAging" — both of which
   * are INTERNAL. It was applied on neither customer-facing surface.
   *
   * Measured 2026-10-16 on LMJ Management & Construction: the statement we
   * email reads $372,962.39 and our own AR aging reads $361,412.40. The
   * difference is exactly SF-00268177, $11,549.99, on the Cipla job — a job
   * whose AIA ledger reads billed $87,627.09, collected $87,627.09, due $0.00.
   * Billed and paid in full through its certificates, and we were asking the GC
   * for it again.
   *
   * This is the $94,000 shape — one question, two internally-consistent answers
   * — except the wrong one is addressed to the customer. So the rollups are
   * resolved BEFORE the invoice loop now, purely so the loop can see which
   * deals bill through AIA.
   */
  const { aiaBillingRollupBulk } = await import("@/lib/commercial/aia/db");
  const liveOpps = opps.filter((o) => !o.deleted_at);
  const rollups = await aiaBillingRollupBulk(liveOpps.map((o) => o.id));
  const billsViaAia = new Set(rollups.keys());

  for (const inv of invoices) {
    // Same rule, same helper, as the receivables report and AR aging.
    if (isSupersededByAia(inv, billsViaAia)) continue;
    // OPEN = still owed. Exclude draft (not billed yet), void, and anything with
    // no positive balance (paid / credit). Clamp each balance at 0 so an
    // overpaid invoice can't shrink the total (matches the AR-KPI rule).
    if (inv.status === "draft" || inv.status === "void") continue;
    const balance = Math.max(0, inv.balance_cents);
    if (balance <= 0) continue;

    const opp = oppById.get(inv.opportunity_id);
    const daysPastDue = inv.due_at ? arDaysPastDue(inv.due_at, now) : null;
    const status = deriveInvoiceStatus(inv);
    // Overdue for AGING uses ET CALENDAR days off the injected `now` (same rule as
    // the AR-Aging report + isInvoiceOverdue) so the on-screen view, PDF, and report
    // bucket an invoice identically — a noon-ET due date must not flip overdue mid-
    // afternoon ET. Balance is already > 0 here.
    const isOverdue = daysPastDue != null && daysPastDue > 0;

    rows.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      dealName: opp ? derivedOppName(opp, null) : "Deleted deal",
      issuedAt: inv.issued_at ?? null,
      dueAt: inv.due_at,
      totalCents: inv.total_cents,
      paidCents: inv.paid_cents,
      balanceCents: balance,
      status,
      daysPastDue,
    });
    totalOutstandingCents += balance;

    // Route by aging bucket — "Current" is strictly not-yet-due (audit F8).
    const bucket = aging[agingBucketKey(daysPastDue, isOverdue)];
    bucket.cents += balance;
    bucket.count += 1;
  }

  // ── AIA payment applications ────────────────────────────────────────────
  //
  // A job billed through G702/G703 writes NO `commercial_invoices` row, so
  // before this the statement we hand a GC omitted the progress billing
  // entirely — a GC being billed $400k could receive a statement reading $0
  // outstanding. The application is the receivable; it belongs on the statement
  // under the number the GC already knows it by.
  //
  // Amount = earned-less-retainage minus collected (2026-08-17 decision), so
  // this is what they owe today. Due date = issue (frozen_at) + net terms.
  // Batched — the first cut called `aiaBillingRollup` (several queries) plus
  // `listAiaApplications` once per opportunity, in sequence.
  let retainageHeldCents = 0;
  const oppRowById = new Map(liveOpps.map((o) => [o.id, o] as const));
  for (const [oppId, roll] of rollups) {
    retainageHeldCents += roll.retainageHeldCents;
    if (roll.dueNowCents <= 0) continue;
    const opp = oppRowById.get(oppId);
    if (!opp) continue;

    /*
     * THE SHARED LADDER, not a fourth copy of it.
     *
     * This preferred `frozen_at` outright. `aiaDueAtFrom` → `aiaIssuedAtFrom`
     * carries the back-dating correction Katie asked for on 2026-10-15: Mary
     * back-entered each job's history when Tomco moved over, so 25 of 41 issued
     * applications were frozen more than 30 days after the period they bill,
     * and dating them by frozen_at makes old money look new. Water Lilies App
     * 3, $15,175.71, read 27 days overdue on the aging report and "not yet due"
     * on the statement we hand the GC — a 39-day disagreement about the same
     * receivable. `aiaDueAtFrom`'s own docblock says "ONE definition. This
     * ladder was written out three times"; this was the fourth and the stale one.
     */
    const dueAt = aiaDueAtFrom(
      roll.latestIssuedFrozenAt,
      roll.latestIssuedPeriodTo,
      DEFAULT_DUE_DAYS
    );
    // Shown on the statement as the date the certificate went out. Same ladder,
    // minus the terms, so the two dates on a row can never disagree.
    const issuedAt = dueAt
      ? new Date(new Date(dueAt).getTime() - DEFAULT_DUE_DAYS * 86_400_000).toISOString()
      : null;
    const aiaDaysPastDue = dueAt ? arDaysPastDue(dueAt, now) : null;
    const isOverdue = aiaDaysPastDue != null && aiaDaysPastDue > 0;

    rows.push({
      invoiceId: roll.latestIssuedId,
      /**
       * NAMED AS CUMULATIVE, because that is what the figures are.
       *
       * This said "Application No. 3" while `totalCents` and `paidCents` carry
       * the JOB-TO-DATE position across every certificate — so a GC holding
       * Application 3 for $141,962.49 read a statement line saying
       * "Application No. 3 … $1,200,000.00". The balance was right; the two
       * columns next to it described something else entirely, and it is their
       * own document they would check it against.
       *
       * AIA billing IS cumulative — G702 line 6 is a running total — so the
       * figures are correct and it was only the label that lied. Naming the
       * latest certificate as the point it runs THROUGH keeps the reference a
       * GC can match without implying the amount belongs to that one sheet.
       */
      invoiceNumber: `AIA through App. No. ${roll.latestIssuedNumber}`,
      kind: "aia",
      dealName: derivedOppName(opp, null),
      issuedAt,
      dueAt,
      totalCents: roll.billedCents,
      paidCents: roll.collectedCents,
      balanceCents: roll.dueNowCents,
      status: isOverdue ? "overdue" : "sent",
      daysPastDue: aiaDaysPastDue,
    });
    totalOutstandingCents += roll.dueNowCents;
    const aiaBucket = aging[agingBucketKey(aiaDaysPastDue, isOverdue)];
    aiaBucket.cents += roll.dueNowCents;
    aiaBucket.count += 1;
  }

  // Oldest first (most-overdue at the top of the statement).
  rows.sort((a, b) => (b.daysPastDue ?? -Infinity) - (a.daysPastDue ?? -Infinity));

  return {
    accountId,
    rows,
    totalOutstandingCents,
    retainageHeldCents,
    aging,
    generatedAt: new Date(now).toISOString(),
  };
}
