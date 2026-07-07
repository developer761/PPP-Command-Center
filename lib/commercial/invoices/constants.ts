/**
 * Phase 3 · Invoicing — constants (source of truth).
 *
 * Karan 2026-07-05 decisions:
 *   - Retainage deferred to a later phase (add later).
 *   - No auto-email; "Mark as sent" flips status only.
 *   - USD only. NYC-uniform tax → flat tax_pct field per invoice.
 *   - Numbering starts at PPP-INV-0001.
 */

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
 *  default; the runtime uses the settings-table value if present. */
export const DEFAULT_INVOICE_PREFIX = "PPP-INV";

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
  const graceMs = OVERDUE_GRACE_DAYS * 86_400_000;
  return Date.now() > dueMs + graceMs;
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
