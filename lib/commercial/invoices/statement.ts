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
import { daysPastDue as arDaysPastDue } from "@/lib/commercial/reports/ar-aging";

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

  for (const inv of invoices) {
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
  let retainageHeldCents = 0;
  const { aiaBillingRollup, listAiaApplications } = await import("@/lib/commercial/aia/db");
  for (const opp of opps) {
    if (opp.deleted_at) continue;
    const roll = await aiaBillingRollup(opp.id).catch(() => null);
    if (!roll || !roll.hasAia) continue;
    retainageHeldCents += roll.retainageHeldCents;
    if (roll.dueNowCents <= 0) continue;

    const apps = await listAiaApplications(opp.id).catch(() => []);
    const issuedApps = apps.filter((a) => a.status === "submitted" || a.status === "paid");
    const latest = issuedApps[issuedApps.length - 1];
    if (!latest) continue;

    const issuedAt = latest.frozen_at ?? (latest.period_to ? `${latest.period_to}T16:00:00Z` : null);
    const dueAt = issuedAt
      ? new Date(new Date(issuedAt).getTime() + DEFAULT_DUE_DAYS * 86_400_000).toISOString()
      : null;
    const daysPastDue = dueAt ? arDaysPastDue(dueAt, now) : null;
    const isOverdue = daysPastDue != null && daysPastDue > 0;

    rows.push({
      invoiceId: latest.id,
      invoiceNumber: `Application No. ${latest.application_number}`,
      kind: "aia",
      dealName: derivedOppName(opp, null),
      issuedAt,
      dueAt,
      totalCents: roll.billedCents,
      paidCents: roll.collectedCents,
      balanceCents: roll.dueNowCents,
      status: isOverdue ? "overdue" : "sent",
      daysPastDue,
    });
    totalOutstandingCents += roll.dueNowCents;
    const bucket = aging[agingBucketKey(daysPastDue, isOverdue)];
    bucket.cents += roll.dueNowCents;
    bucket.count += 1;
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
