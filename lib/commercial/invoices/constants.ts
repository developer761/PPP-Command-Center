/**
 * Phase 3 · Invoicing — constants (source of truth).
 *
 * Karan 2026-07-05 decisions:
 *   - Retainage deferred to a later phase (add later).
 *   - No auto-email; "Mark as sent" flips status only.
 *   - USD only. NYC-uniform tax → flat tax_pct field per invoice.
 *   - Numbering: new invoices are INV-#### (Katie 2026-07-20 rename).
 *     Pre-2026-07-20 invoices keep their original PPP-INV-#### numbers
 *     — immutable audit trail. Sibling-nav regex handles both prefixes.
 */

import { daysFromTodayEt } from "@/lib/date-et";

/** Status DAG for invoices. Terminal-ish states: paid + void.
 *  overdue is a computed pseudo-state (derived from due_at + balance),
 *  not stored on the row. See `deriveInvoiceStatus()` in db.ts. */
export type InvoiceStatus = "draft" | "sent" | "viewed" | "partial" | "paid" | "overdue" | "void";

/** ALL statuses that appear in the DB `status` column. `overdue` isn't
 *  here because it's computed on read (based on due_at). */
export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  "draft",
  "sent",
  "viewed",
  "partial",
  "paid",
  "void",
] as const;

/** Human-friendly label per status. */
export function invoiceStatusLabel(s: InvoiceStatus): string {
  switch (s) {
    case "draft": return "Draft";
    case "sent": return "Sent";
    case "viewed": return "Viewed";
    case "partial": return "Partial";
    case "paid": return "Paid";
    case "overdue": return "Overdue";
    case "void": return "Void";
  }
}

/** DAG — which `to_status` is allowed from each `from_status`.
 *  Enforced in lib + DB trigger + UI (dropdown filtering).
 *
 *  Karan 2026-07-07: user asked for "mark and unmark as sent anytime" +
 *  the ability to void or restore from any state. So:
 *    - draft ↔ sent flips both ways (unsend a mistake, resend a draft)
 *    - void can come back to draft (mis-void recovery)
 *    - paid can come back to sent (mis-recording recovery) — this is
 *      always a signal that a payment needs to be removed too, but the
 *      UI shows both actions so the user knows what to do
 *  Payment-driven states (partial, paid) still can't be set BY HAND; the
 *  trigger owns them. The UI just shows the un-transitions. */
export const ALLOWED_INVOICE_TRANSITIONS: Record<InvoiceStatus, ReadonlyArray<InvoiceStatus>> = {
  draft: ["sent", "void"],
  sent: ["draft", "viewed", "void"],
  viewed: ["sent", "void"],
  partial: ["void"],
  paid: ["sent", "void"],
  overdue: ["sent", "void"],
  void: ["draft"],
};

/** Statuses that mean "this invoice is done" — reporting rolls these
 *  out of the "outstanding AR" bucket. */
export const TERMINAL_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(["paid", "void"]);

/** Statuses that mean "this invoice is CURRENTLY billing the customer" —
 *  drives AR aging calculations. */
export const BILLABLE_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  "sent",
  "viewed",
  "partial",
  "overdue",
]);

/** Default net terms if the account doesn't override. */
export const DEFAULT_PAYMENT_TERMS = "Net 30";
export const DEFAULT_DUE_DAYS = 30;

/**
 * When an invoice falls due — from its own due date, or from the day it went
 * out plus the standard terms.
 *
 * 🔴 WITHOUT THE FALLBACK, A SENT INVOICE CAN NEVER BE LATE.
 *
 * `daysPastDue(null)` is 0 and 0 buckets as Current, so an invoice with no due
 * date sits in Current for ever however long ago it was sent. Measured on
 * 2026-10-15: six live billable invoices carried no due date, $31,277.14 —
 * and FOUR of them, $31,107.14 of it, had a perfectly good issue or sent date.
 * Station Yards' $17,757.14 went out on 9/17 and read as current a month later.
 *
 * The Accounting page explained the gap as Salesforce sending terms but no
 * invoice date. That is true of exactly two rows, worth $170 between them.
 * Three of the four are invoices raised in this platform, not migrated at all.
 *
 * AIA has had this ladder from the start (`aiaDueAtFrom`); invoices never got
 * one, which is why the same money ages on one surface and not the other.
 *
 * Returns null only when there is genuinely no date to reckon from — unknown,
 * never "today", and `noDueDateCents` still counts those honestly.
 */
export function invoiceDueAtFrom(
  dueAt: string | null | undefined,
  issuedAt: string | null | undefined,
  dueDays: number = DEFAULT_DUE_DAYS,
): string | null {
  if (dueAt) return dueAt;
  if (!issuedAt) return null;
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) return null;
  return new Date(issued + dueDays * 86_400_000).toISOString();
}

/** Grace period before we flip a sent invoice to "overdue" on read.
 *  Currently 0 = the day due_at passes. Bump if customers complain
 *  about aggressive labeling. */
export const OVERDUE_GRACE_DAYS = 0;

/** Payment methods surfaced in the "Add payment" modal picker. */
export const PAYMENT_METHODS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "check", label: "Check" },
  { key: "ach", label: "ACH" },
  { key: "wire", label: "Wire" },
  { key: "credit_card", label: "Credit card" },
  { key: "other", label: "Other" },
] as const;

/** Invoice number prefix — matches the seed in commercial_settings
 *  (see lib/commercial/settings.ts). Kept here as a compile-time
 *  default; the runtime uses the settings-table value if present.
 *  Karan 2026-07-20 (Katie ask): renamed PPP-INV → INV. Existing
 *  invoices keep their original PPP-INV numbers (immutable + audit
 *  trail); only new invoices get the shorter INV-#### format. */
export const DEFAULT_INVOICE_PREFIX = "INV";

/**
 * Predicate — is an invoice past-due right now?
 * Sent/viewed/partial with due_at < now() (minus grace) counts as overdue.
 */
export function isInvoiceOverdue(row: {
  status: InvoiceStatus;
  due_at: string | null;
  balance_cents: number;
}): boolean {
  if (row.status === "paid" || row.status === "void" || row.status === "draft") return false;
  if (row.balance_cents <= 0) return false;
  if (!row.due_at) return false;
  const dueMs = new Date(row.due_at).getTime();
  if (!Number.isFinite(dueMs)) return false;
  // Overdue = the ET DUE DATE is more than `grace` days before ET-today. Comparing
  // instants (Date.now() > noon-ET dueMs) flipped every invoice overdue at midday
  // on its own due date; an invoice is only past due after the day has ended in ET.
  const dueEtDate = new Date(row.due_at).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return daysFromTodayEt(dueEtDate) < -OVERDUE_GRACE_DAYS;
}

/**
 * Derive the display status — same as row.status, EXCEPT when the row
 * is sent/viewed/partial past its due date we return "overdue". Pure
 * function; caller passes the plain row.
 */
export function deriveInvoiceStatus(row: {
  status: InvoiceStatus;
  due_at: string | null;
  balance_cents: number;
}): InvoiceStatus {
  if (isInvoiceOverdue(row)) return "overdue";
  return row.status;
}

/**
 * An invoice the Salesforce migration created to carry a work order's balance
 * (`stageInvoices` in scripts/import-tomco.mjs numbers them `SF-<work order>`).
 *
 * Its balance is the WORK ORDER's — contract less payments — not a document
 * anybody sent. On most jobs that is still the right figure to chase (checked
 * 2026-10-15: several small open balances on the office's hand-kept AR sheet
 * match these rows to the cent), so they stay receivables. But once the job's
 * real billing is in the
 * platform as an issued AIA application, the placeholder and the certificate
 * are the same money twice. Applied by `getReceivablesReport` and `getArAging`.
 */
export function isSalesforceCarryoverInvoice(inv: { invoice_number?: string | null }): boolean {
  return /^SF-\d+$/.test((inv.invoice_number ?? "").trim());
}
