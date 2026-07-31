/**
 * `/commercial/invoices/[id]` — Phase 3 invoice detail page.
 *
 * Sections (single scroll, no tabs — this is a working surface, not
 * navigational):
 *   1. Hero — invoice number + status + amount + due date
 *   2. Status action card (Send / Mark viewed / Void / Add payment)
 *   3. Line items table (add row + remove row inline)
 *   4. Payments log (add payment + delete)
 *   5. Details grid (Info + Bill-to + Account cards, same shape as opp)
 *   6. Status history timeline
 */
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  getCommercialInvoice,
  listInvoiceLineItems,
  listInvoicePayments,
  listInvoiceStatusLog,
  addLineItem,
  removeLineItem,
  addPayment,
  removePayment,
  updateInvoiceCoreFields,
  getInvoiceContext,
  listCommercialInvoices,
} from "@/lib/commercial/invoices/db";
import {
  changeInvoiceStatus,
  softDeleteInvoice,
  allowedNextStatuses,
} from "@/lib/commercial/invoices/status";
import { getInvoiceLienWaiver } from "@/lib/commercial/invoices/lien-waiver";
import {
  listMilestonesForInvoice,
  addMilestone,
  updateMilestone,
  deleteMilestone,
  getMilestoneLienWaiver,
  getMilestonePaidMap,
  allocateMilestonePaid,
} from "@/lib/commercial/invoices/milestones";
import { LienWaiverUpload } from "@/components/commercial/lien-waiver-upload";
import {
  deriveInvoiceStatus,
  invoiceStatusLabel,
  PAYMENT_METHODS,
  type InvoiceStatus,
} from "@/lib/commercial/invoices/constants";
import { formatCentsFull, fmtEtDate, parseDollarsToCents, daysBetween } from "@/lib/commercial/invoices/format";
import { productUnitLabel } from "@/lib/commercial/products/constants";
import { PaymentProgressBar } from "@/components/commercial/payment-progress-bar";
import { SegmentedMeter, type MeterSegment } from "@/components/commercial/segmented-meter";
import { getCommercialAccount, formatAccountNumber } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName, formatOpportunityNumber } from "@/lib/commercial/opportunities/db";
import { getProposal, formatProposalNumber } from "@/lib/commercial/proposals/db";
import { isWon } from "@/lib/commercial/opportunities/constants";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import DueDatePickerWithPresets from "@/components/commercial/due-date-picker-with-presets";
import DatePicker from "@/components/commercial/date-picker";
import CopyInvoiceLinkButton from "@/components/commercial/copy-invoice-link";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<{
  error?: string;
  saved?: string;
  capped?: string;
  applied?: string;
  requested?: string;
  from?: string;
  /** Phase G: set when this invoice was just created to bill a change order. */
  co_billed?: string;
}>;

// ────────────── Server actions ──────────────

/**
 * Revalidate every surface that shows this invoice's data. Called after
 * any mutation (payment recorded, status flipped, line item added, etc.)
 * so the opp detail's InvoicesPanel and the account 360 rollup tiles
 * update at the same time as the invoice detail itself.
 *
 * Karan 2026-07-07: without this, the parent opp's progress bar was
 * stale until Next's default revalidation window kicked in.
 */
async function revalidateInvoiceContext(invoice_id: string): Promise<void> {
  const { opportunity_id, account_id } = await getInvoiceContext(invoice_id);
  revalidatePath(`/commercial/invoices/${invoice_id}`);
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  if (opportunity_id) revalidatePath(`/commercial/opportunities/${opportunity_id}`);
  if (account_id) revalidatePath(`/commercial/accounts/${account_id}`);
}

/**
 * Append the `?from=<url>` return context to an invoice URL so that after ANY
 * action the Back button (and the next action) still returns the user to where
 * they opened the invoice from — the deal page, the Invoices tab, wherever.
 * Open-redirect-guarded: only /commercial/ paths are honored.
 */
function withFrom(url: string, from: string): string {
  if (!from || !from.startsWith("/commercial/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}from=${encodeURIComponent(from)}`;
}

async function addLineItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const description = String(formData.get("description") ?? "").trim();
  const quantity = parseFloat(String(formData.get("quantity") ?? "1"));
  const unit = String(formData.get("unit") ?? "").trim() || null;
  const priceRaw = String(formData.get("unit_price") ?? "");
  const unit_price_cents = parseDollarsToCents(priceRaw);
  if (!description || !Number.isFinite(quantity) || quantity <= 0 || unit_price_cents === null) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent("Fill description, quantity, and price."), from));
  }
  const result = await addLineItem(invoice_id, { description, quantity, unit, unit_price_cents: unit_price_cents! }, user.id);
  if (!result.ok) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Failed to add line item."), from));
  }
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}`, from));
}

async function removeLineItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  const item_id = String(formData.get("item_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(item_id)) redirect("/commercial/invoices");
  const rm = await removeLineItem(invoice_id, item_id, user.id);
  if (!rm.ok) {
    const msg = rm.error === "milestone_line_item"
      ? "That charge is part of a milestone — remove it from the Milestones section below instead."
      : rm.error ?? "Couldn't remove that line.";
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(msg), from));
  }
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}`, from));
}

async function addPaymentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const amount = parseDollarsToCents(String(formData.get("amount") ?? ""));
  const paid_at = String(formData.get("paid_at") ?? "").trim() || undefined;
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (amount === null || amount <= 0) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent("Enter a positive dollar amount (e.g., 250.00)."), from));
  }
  // Karan 2026-07-07 TZ bug fix: `<input type="date">` returns
  // YYYY-MM-DD; `new Date(...)` interprets as UTC midnight which
  // renders one calendar day earlier in ET. Anchor at 16:00 UTC (noon
  // ET) so the payment displays on the day the recorder actually typed.
  const paid_at_iso = paid_at
    ? /^\d{4}-\d{2}-\d{2}$/.test(paid_at)
      ? `${paid_at}T16:00:00.000Z`
      : new Date(paid_at).toISOString()
    : undefined;
  const result = await addPayment(invoice_id, {
    amount_cents: amount!,
    paid_at: paid_at_iso,
    method,
    reference,
    notes,
    recorded_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Failed to record payment."), from));
  }
  await revalidateInvoiceContext(invoice_id);
  // If the payment was over the balance, surface the capped amount so the
  // recorder isn't confused when their $10k input records as $5k. The UI
  // reads `capped` + `applied` + `requested` from the query and shows an
  // amber note next to the success toast.
  if (result.capped && result.applied_cents !== undefined && result.requested_cents !== undefined) {
    const q = new URLSearchParams({
      saved: "payment",
      capped: "1",
      applied: String(result.applied_cents),
      requested: String(result.requested_cents),
    });
    redirect(withFrom(`/commercial/invoices/${invoice_id}?${q.toString()}`, from));
  }
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=payment`, from));
}

async function removePaymentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  const payment_id = String(formData.get("payment_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(payment_id)) redirect("/commercial/invoices");
  await removePayment(invoice_id, payment_id, user.id);
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}`, from));
}

function milestoneDue(raw: string): string | null | undefined {
  const v = raw.trim();
  if (v === "") return null; // explicit clear
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T16:00:00.000Z`;
  return undefined; // malformed — leave unchanged
}

async function addMilestoneAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const name = String(formData.get("name") ?? "").trim();
  const amount = parseDollarsToCents(String(formData.get("amount") ?? ""));
  const due_at = milestoneDue(String(formData.get("due_at") ?? "")) ?? null;
  if (!name || amount === null || amount <= 0) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent("Name the milestone and enter an amount."), from));
  }
  const res = await addMilestone(invoice_id, { name, amount_cents: amount!, due_at }, user.id);
  if (!res.ok) redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(res.error), from));
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=milestone`, from));
}

async function updateMilestoneAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  const milestone_id = String(formData.get("milestone_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(milestone_id)) redirect("/commercial/invoices");
  const name = String(formData.get("name") ?? "").trim();
  const amount = parseDollarsToCents(String(formData.get("amount") ?? ""));
  const due_at = milestoneDue(String(formData.get("due_at") ?? ""));
  if (!name || amount === null || amount <= 0) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent("Name the milestone and enter an amount."), from));
  }
  const patch: Parameters<typeof updateMilestone>[1] = { name, amount_cents: amount! };
  if (due_at !== undefined) patch.due_at = due_at;
  const res = await updateMilestone(milestone_id, patch, user.id);
  if (!res.ok) redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(res.error), from));
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=milestone`, from));
}

async function deleteMilestoneAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  const milestone_id = String(formData.get("milestone_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(milestone_id)) redirect("/commercial/invoices");
  await deleteMilestone(milestone_id, user.id);
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=milestone`, from));
}

/** Record a payment against a specific milestone (the ✓ Record payment button).
 *  Captures method / reference / date / notes; caps to the milestone's balance
 *  and rolls up to the invoice via the same trigger as invoice-level payments. */
async function recordMilestonePaymentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  const milestone_id = String(formData.get("milestone_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(milestone_id)) redirect("/commercial/invoices");
  const amount = parseDollarsToCents(String(formData.get("amount") ?? ""));
  const paid_at = String(formData.get("paid_at") ?? "").trim() || undefined;
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (amount === null || amount <= 0) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent("Enter a positive dollar amount for the milestone payment."), from));
  }
  const paid_at_iso = paid_at
    ? /^\d{4}-\d{2}-\d{2}$/.test(paid_at)
      ? `${paid_at}T16:00:00.000Z`
      : new Date(paid_at).toISOString()
    : undefined;
  const result = await addPayment(invoice_id, {
    amount_cents: amount!,
    paid_at: paid_at_iso,
    method,
    reference,
    notes,
    recorded_by_user_id: user.id,
    milestone_id,
  });
  if (!result.ok) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error === "milestone_already_paid" ? "That milestone is already fully paid." : result.error ?? "Failed to record payment."), from));
  }
  await revalidateInvoiceContext(invoice_id);
  if (result.capped && result.applied_cents !== undefined && result.requested_cents !== undefined) {
    const q = new URLSearchParams({ saved: "payment", capped: "1", applied: String(result.applied_cents), requested: String(result.requested_cents) });
    redirect(withFrom(`/commercial/invoices/${invoice_id}?${q.toString()}`, from));
  }
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=payment`, from));
}

async function changeStatusAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  const to_status = String(formData.get("to_status") ?? "") as InvoiceStatus;
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const result = await changeInvoiceStatus({ invoice_id, to_status, acting_user_id: user.id });
  if (!result.ok) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error), from));
  }
  revalidatePath("/commercial/invoices");
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=status`, from));
}

/** Save ONLY the internal notes (the dedicated Notes box at the bottom of the
 *  invoice). Kept separate from the details form so saving notes never touches
 *  PO / terms / message / due date. */
async function saveInvoiceNotesAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const notes = (String(formData.get("notes") ?? "").trim() || null) as string | null;
  const result = await updateInvoiceCoreFields(invoice_id, { notes }, user.id);
  if (!result.ok) redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Could not save notes."), from));
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=notes`, from));
}

async function updateCoreFieldsAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  // 2026-07-29 re-audit fix (HIGH): tax field is always present, so blank is
  // an explicit "no tax" (tax-exempt), not "leave unchanged." Blank → 0 so
  // clearing the field actually exempts the invoice instead of silently
  // keeping the prior rate. A malformed value leaves it untouched.
  const tax_pct_raw = String(formData.get("tax_pct") ?? "").trim();
  const tax_pct = tax_pct_raw === "" ? 0 : parseFloat(tax_pct_raw);
  // Due date arrives as "YYYY-MM-DD" from <input type="date">. We store
  // TIMESTAMPTZ, so noon-ET (16:00Z) is our anchor — that avoids "one day
  // off" bugs when displayed in ET vs UTC boundaries. Empty string = clear.
  const due_at_raw = String(formData.get("due_at") ?? "").trim();
  let due_at: string | null | undefined;
  if (due_at_raw === "") {
    due_at = null;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(due_at_raw)) {
    due_at = `${due_at_raw}T16:00:00.000Z`;
  } else {
    due_at = undefined; // malformed — leave unchanged
  }
  const patch: Parameters<typeof updateInvoiceCoreFields>[1] = {
    payment_terms: String(formData.get("payment_terms") ?? "").trim() || undefined,
    customer_message: (String(formData.get("customer_message") ?? "").trim() || null) as string | null,
    po_number: (String(formData.get("po_number") ?? "").trim() || null) as string | null,
    notes: (String(formData.get("notes") ?? "").trim() || null) as string | null,
  };
  if (due_at !== undefined) patch.due_at = due_at;
  if (Number.isFinite(tax_pct)) patch.tax_pct = tax_pct;
  const result = await updateInvoiceCoreFields(invoice_id, patch, user.id);
  if (!result.ok) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Could not save details."), from));
  }
  await revalidateInvoiceContext(invoice_id);
  redirect(withFrom(`/commercial/invoices/${invoice_id}?saved=details`, from));
}

async function deleteDraftAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  // Karan 2026-07-15: honor the `from` context so deleting an invoice
  // opened from an account/opportunity Invoices tab returns the user
  // to THAT tab (with the undo toast) instead of dumping them onto
  // the global /commercial/invoices list. Open-redirect defense: only
  // accept URLs that start with /commercial to prevent malicious form
  // input from bouncing the user off-domain.
  const rawFrom = String(formData.get("from") ?? "").trim();
  // 2026-07-29: invoices live under the account now. Only honor a `from` that
  // points at a canonical invoice surface (the global list or an account view).
  // A stale opp-tab `from` (`/commercial/opportunities/…?tab=invoices`) can
  // bounce/404 for a post-sale deal — reject it and fall back to the account
  // invoices view below.
  const safeFrom =
    rawFrom.startsWith("/commercial/invoices") ||
    rawFrom.startsWith("/commercial/accounts/")
      ? rawFrom.split("#")[0]
      : null;
  // Capture context BEFORE the soft-delete so we can revalidate the
  // parent opp + account. After deleted_at is set, the row is still in
  // the DB, but semantically the panel should re-render without it —
  // the roll-up + progress bar totals need to drop this invoice's share.
  const ctx = await getInvoiceContext(invoice_id);
  // Karan 2026-07-11 signature-moments: capture the invoice_number for
  // the undo-toast label BEFORE deletion so users see "Deleted INV-042"
  // instead of just "Deleted invoice".
  const preInvoice = await getCommercialInvoice(invoice_id);
  const result = await softDeleteInvoice(invoice_id, user.id);
  if (!result.ok) {
    redirect(withFrom(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Delete failed"), from));
  }
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  if (ctx.opportunity_id) revalidatePath(`/commercial/opportunities/${ctx.opportunity_id}`);
  if (ctx.account_id) revalidatePath(`/commercial/accounts/${ctx.account_id}`);
  const undoLabel = preInvoice?.invoice_number ?? "";
  const undoQuery = `deleted=1&undo_id=${invoice_id}&undo_kind=invoice&undo_label=${encodeURIComponent(undoLabel)}`;
  // Fallback lands on the account's invoices view (canonical home) when we have
  // the account; otherwise the global list. Never the opp tab.
  const fallback = ctx.account_id
    ? `/commercial/invoices?account_id=${ctx.account_id}`
    : "/commercial/invoices";
  const target = safeFrom
    ? `${safeFrom}${safeFrom.includes("?") ? "&" : "?"}${undoQuery}`
    : `${fallback}${fallback.includes("?") ? "&" : "?"}${undoQuery}`;
  redirect(target);
}

/**
 * Karan 2026-07-08: bulk-delete every sibling invoice for the current
 * invoice's parent (deal OR account, based on the `scope` field). Same
 * safety envelope as the list-page variants — the parent must be
 * soft-deleted, and any recorded payment blocks the wipe. Landing
 * here happens from the "Delete all N invoices" button on the invoice
 * detail page when the parent is gone.
 */
async function bulkDeleteInvoicesFromDetailAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const scope = String(formData.get("scope") ?? "");
  const parent_id = String(formData.get("parent_id") ?? "");
  const confirmed = formData.get("confirm") === "yes";
  const back_href = String(formData.get("back_href") ?? "/commercial/invoices");
  if (!UUID_RE.test(parent_id) || (scope !== "opp" && scope !== "account")) {
    redirect("/commercial/invoices");
  }
  if (!confirmed) {
    redirect(back_href);
  }
  const { commercialDb } = await import("@/lib/commercial/db");
  const sb = commercialDb();
  // Guard 1: parent must be soft-deleted (orphan-cleanup only).
  if (scope === "opp") {
    const { data: row } = await sb.from("commercial_opportunities").select("id, deleted_at").eq("id", parent_id).maybeSingle();
    if (!row || !(row as { deleted_at: string | null }).deleted_at) {
      redirect(`${back_href}${back_href.includes("?") ? "&" : "?"}error=${encodeURIComponent("Bulk delete only allowed on deleted deals.")}`);
    }
  } else {
    const { data: row } = await sb.from("commercial_accounts").select("id, deleted_at").eq("id", parent_id).maybeSingle();
    if (!row || !(row as { deleted_at: string | null }).deleted_at) {
      redirect(`${back_href}${back_href.includes("?") ? "&" : "?"}error=${encodeURIComponent("Bulk delete only allowed on deleted accounts.")}`);
    }
  }
  // Karan 2026-07-08: auto-void paid non-void invoices then wipe. The
  // operator is cleaning up an orphan cluster — refusing to wipe
  // because one had a payment leaves them stuck. Voiding first
  // preserves the audit trail (payments log + paid_cents intact).
  const parentCol = scope === "opp" ? "opportunity_id" : "account_id";
  const { data: invRows } = await sb
    .from("commercial_invoices")
    .select("id, status, paid_cents")
    .eq(parentCol, parent_id)
    .is("deleted_at", null);
  const rows = (invRows ?? []) as { id: string; status: string; paid_cents: number }[];
  const now = new Date().toISOString();
  const paidNonVoid = rows.filter((r) => (r.paid_cents ?? 0) > 0 && r.status !== "void");
  if (paidNonVoid.length > 0) {
    await sb
      .from("commercial_invoices")
      .update({ status: "void", voided_at: now })
      .in("id", paidNonVoid.map((r) => r.id));
  }
  if (rows.length > 0) {
    await sb
      .from("commercial_invoices")
      .update({ deleted_at: now })
      .in("id", rows.map((r) => r.id));
    // 2026-07-29 re-audit fix: batch-log the bulk void/delete so the money
    // trail survives orphan cleanup (matches the invoices-list bulk actions).
    await sb.from("commercial_invoice_status_log").insert(
      rows.map((r) => ({
        invoice_id: r.id,
        from_status: r.status,
        to_status: "void",
        actor_user_id: user.id,
        note: `Bulk-deleted (orphan cleanup, ${scope})${(r.paid_cents ?? 0) > 0 ? ` — had $${((r.paid_cents ?? 0) / 100).toFixed(2)} paid; auto-voided` : ""}`.slice(0, 500),
      }))
    );
  }
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  redirect(`/commercial/invoices?bulk_deleted=${rows.length}`);
}

// ────────────── Page ──────────────

export default async function InvoiceDetailPage({ params, searchParams }: { params: PP; searchParams: SP }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const sp = await searchParams;
  const errorMsg = pickFirst(sp.error);
  const savedTarget = pickFirst(sp.saved);

  const invoice = await getCommercialInvoice(id);
  if (!invoice) notFound();
  const [lineItems, payments, statusLog, account, opp, siblingInvoices, lienWaiver, milestones] = await Promise.all([
    listInvoiceLineItems(invoice.id),
    listInvoicePayments(invoice.id),
    listInvoiceStatusLog(invoice.id),
    getCommercialAccount(invoice.account_id),
    getCommercialOpportunity(invoice.opportunity_id),
    listCommercialInvoices({ opportunityId: invoice.opportunity_id }),
    getInvoiceLienWaiver(invoice.id),
    listMilestonesForInvoice(invoice.id),
  ]);
  // Per-milestone lien-waiver docs (for the ✓/download state on each row).
  const milestoneWaivers = new Map<string, Awaited<ReturnType<typeof getMilestoneLienWaiver>>>();
  await Promise.all(
    milestones.map(async (m) => milestoneWaivers.set(m.id, await getMilestoneLienWaiver(m.id)))
  );
  const hasMilestones = milestones.length > 0;
  const milestoneSum = milestones.reduce((s, m) => s + m.amount_cents, 0);
  // Per-milestone paid (Σ payments tagged to each). Invoice paid_cents is
  // unchanged — the trigger sums ALL payments; this is just the milestone slice.
  // Effective per-milestone paid: tagged payments + an allocation of any
  // untagged (invoice-level) payment, so the segments never read $0 paid while
  // the invoice is actually Paid (audit 1A).
  const milestonePaid = hasMilestones
    ? allocateMilestonePaid(milestones, await getMilestonePaidMap(invoice.id), invoice.paid_cents)
    : new Map<string, number>();
  // Per-milestone segments for the segmented progress bar.
  const nowIso = new Date().toISOString();
  const milestoneSegments: MeterSegment[] = milestones.map((m) => {
    const paid = milestonePaid.get(m.id) ?? 0;
    return {
      name: m.name,
      due: m.due_at ? fmtEtDate(m.due_at) : null,
      amountCents: m.amount_cents,
      paidCents: paid,
      overdue: !!m.due_at && m.due_at < nowIso && paid < m.amount_cents,
    };
  });
  // If milestones don't cover the whole subtotal (a flat line item still sits
  // alongside them), show a remainder segment so the bar spans the full bill
  // (audit 1C).
  const unscheduledCents = invoice.subtotal_cents - milestoneSum;
  if (hasMilestones && unscheduledCents > 0) {
    milestoneSegments.push({ name: "Unscheduled", due: null, amountCents: unscheduledCents, paidCents: 0 });
  }
  // Invoice ↔ proposal: when this invoice bills against a proposal, resolve the
  // proposal + its sibling progress invoices so we can show "invoice N of M
  // against PROP-000N · $billed of $contract." Snapshot total (at bill time)
  // is preferred so a later proposal edit doesn't rewrite history.
  const linkedProposal = invoice.proposal_id ? await getProposal(invoice.proposal_id) : null;
  const proposalSiblings = invoice.proposal_id
    ? siblingInvoices
        .filter((s) => s.proposal_id === invoice.proposal_id && s.status !== "void" && !s.deleted_at)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    : [];
  const proposalIssuedSiblings = proposalSiblings.filter((s) => s.status !== "draft");
  const billedAgainstProposalCents = proposalIssuedSiblings.reduce((s, i) => s + i.total_cents, 0);
  const proposalContractCents = invoice.proposal_total_cents_at_bill ?? linkedProposal?.total_cents ?? null;
  const thisInvoiceProposalIndex = proposalSiblings.findIndex((s) => s.id === invoice.id);
  // Karan 2026-07-07: sibling-invoice nav. If this opp has multiple
  // invoices (progress billing), show a compact strip so users can hop
  // between them without going back to the opp panel. Sort by
  // created_at so the strip reads chronologically.
  const siblingsSorted = [...siblingInvoices].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const siblingIdx = siblingsSorted.findIndex((s) => s.id === invoice.id);
  const prevSibling = siblingIdx > 0 ? siblingsSorted[siblingIdx - 1] : null;
  const nextSibling = siblingIdx >= 0 && siblingIdx < siblingsSorted.length - 1 ? siblingsSorted[siblingIdx + 1] : null;
  const hasSiblings = siblingsSorted.length > 1;

  const displayStatus = deriveInvoiceStatus(invoice);
  const nextStatuses = allowedNextStatuses(invoice.status);
  const daysUntilDue = daysBetween(new Date().toISOString(), invoice.due_at);
  const isDraft = invoice.status === "draft";
  const isVoid = invoice.status === "void";
  // Karan 2026-07-08: orphan detection. If the parent deal or account
  // was soft-deleted before the cascade guard shipped, this invoice can
  // exist without a live parent. Surface a clear "Orphan" affordance
  // so the user knows their options are Void or Delete.
  const isOrphan = !opp || !account;

  // Karan 2026-07-08: prominent Back button. Reads `?from=<url>` off
  // the query so a click coming from /commercial/invoices?opportunity_id=X
  // (the deleted-deal cluster) returns to that scoped view, not the
  // whole list. Falls back to the natural parent when `from` is missing.
  const fromRaw = pickFirst(sp.from);
  const backHref = (() => {
    if (fromRaw && fromRaw.startsWith("/commercial/")) return fromRaw;
    // 2026-07-29: invoices are account-scoped now — return to the account's
    // invoices view (guaranteed valid), NOT the opp tab (which can bounce/
    // 404 for a post-sale deal). Scroll to this opp's group.
    if (account) return `/commercial/invoices?account_id=${account.id}${opp ? `#opp-${opp.id}` : ""}`;
    return "/commercial/invoices";
  })();

  return (
    <div className="space-y-5">
      {/* Prominent back button — Karan 2026-07-08. The breadcrumb below
          is still there for hop-anywhere navigation, but the primary
          "back" affordance is a big button so users can bounce to their
          previous surface in one glance. */}
      <div className="flex items-center gap-2 -ml-1">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-ppp-charcoal-700 hover:text-ppp-charcoal hover:bg-ppp-charcoal-100 min-h-[40px] touch-manipulation"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back
        </Link>
      </div>
      {/* Karan 2026-07-08 Batch 3: swapped the "← All invoices" back
          link for a proper breadcrumb — Invoices / [Account] / [Deal] /
          [Invoice #]. Mirrors the deal-detail breadcrumb so users learn
          one hierarchy pattern across the platform. Each hop is
          keyboard/tap-friendly at 32px min-height. */}
      <nav aria-label="Breadcrumb" className="text-[12.5px] font-medium text-ppp-charcoal-500 flex items-center gap-1 flex-wrap min-h-[32px] -ml-1 px-1">
        <Link
          href="/commercial/invoices"
          className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 min-h-[32px] px-1 touch-manipulation"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          Invoices
        </Link>
        {account && (
          <>
            <span aria-hidden className="text-ppp-charcoal-300">/</span>
            <Link
              href={`/commercial/accounts/${account.id}`}
              className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 min-h-[32px] px-1 touch-manipulation max-w-[220px] truncate"
              title={account.company_name}
            >
              {account.company_name}
            </Link>
          </>
        )}
        {opp && (
          <>
            <span aria-hidden className="text-ppp-charcoal-300">/</span>
            <Link
              href={`/commercial/opportunities/${opp.id}`}
              className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 min-h-[32px] px-1 touch-manipulation max-w-[220px] truncate"
              title={derivedOppName(opp, account?.company_name ?? null)}
            >
              {derivedOppName(opp, account?.company_name ?? null)}
            </Link>
          </>
        )}
        <span aria-hidden className="text-ppp-charcoal-300">/</span>
        <span className="inline-flex items-center min-h-[32px] px-1 text-ppp-charcoal-700 font-mono truncate max-w-[220px]" title={invoice.invoice_number}>
          {invoice.invoice_number}
        </span>
      </nav>

      {isOrphan && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 flex items-start gap-2.5">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-amber-700 mt-0.5 flex-shrink-0">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-bold text-amber-900">
              {!opp && !account
                ? "Parent deal and account were deleted"
                : !opp
                ? "Parent deal was deleted"
                : "Parent account was deleted"}
            </div>
            <div className="text-[11.5px] text-amber-800 mt-0.5 leading-snug">
              This invoice still exists on file. Void it (keeps history) or delete it (removes it from lists) using the actions below.
            </div>
          </div>
        </div>
      )}

      {/* Sibling nav — only shown when this opp has multiple invoices
          (progress billing). Prev/Next hops + "N of M" counter + link
          back to the opp panel. Alex-love feature for staying in a
          single opp's billing story. */}
      {hasSiblings && opp && (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-600">
            <span className="inline-flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400">
                <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              <span className="font-semibold text-ppp-charcoal">
                Invoice {siblingIdx + 1} of {siblingsSorted.length}
              </span>
              <span aria-hidden>·</span>
              {/* 2026-07-21 audit fix (#7): was ?tab=info, which the deal
                  page bounces to the account — a dead trap. Route straight
                  to the deal's real home: the account drill-in sheet.
                  Re-audit (Finding C): invoices outlive archival, so carry
                  ?archived=1 for archived deals — otherwise the ?edit=
                  sheet never opens (archived deals are excluded from the
                  account tab's list) and the user lands on a bare page. */}
              <Link
                href={`/commercial/accounts/${opp.account_id}?tab=opportunities&edit=${opp.id}${opp.archived_at ? "&archived=1" : ""}#deal-row-${opp.id}`}
                className="text-cc-brand-700 hover:text-cc-brand-800 underline underline-offset-2"
              >
                {derivedOppName(opp, account?.company_name ?? null)}
              </Link>
            </span>
          </div>
          <div className="flex items-center gap-1">
            {prevSibling ? (
              <Link
                href={`/commercial/invoices/${prevSibling.id}`}
                aria-label={`Previous invoice: ${prevSibling.invoice_number}`}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 min-h-[36px] touch-manipulation"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                <span className="font-mono">{prevSibling.invoice_number.replace(/^(PPP-INV|INV)-/, "…")}</span>
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-100 text-[12px] font-medium text-ppp-charcoal-300 min-h-[36px]" aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                First
              </span>
            )}
            {nextSibling ? (
              <Link
                href={`/commercial/invoices/${nextSibling.id}`}
                aria-label={`Next invoice: ${nextSibling.invoice_number}`}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 min-h-[36px] touch-manipulation"
              >
                <span className="font-mono">{nextSibling.invoice_number.replace(/^(PPP-INV|INV)-/, "…")}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-100 text-[12px] font-medium text-ppp-charcoal-300 min-h-[36px]" aria-hidden>
                Last
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
            )}
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800">
          {errorMsg}
        </div>
      )}
      {savedTarget === "details" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-emerald-600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg></span>
          <span>Details saved.</span>
        </div>
      )}
      {savedTarget === "created" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-emerald-600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg></span>
          <span>Invoice created.</span>
        </div>
      )}
      {pickFirst(sp.co_billed) === "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-emerald-600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg></span>
          <span>Draft invoice created for this change order. Review the terms and send it when you&rsquo;re ready.</span>
        </div>
      )}
      {savedTarget === "status" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-emerald-600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg></span>
          <span>Status updated.</span>
        </div>
      )}
      {savedTarget === "milestone" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-emerald-600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg></span>
          <span>Milestones updated.</span>
        </div>
      )}
      {savedTarget === "notes" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-emerald-600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg></span>
          <span>Notes saved.</span>
        </div>
      )}
      {savedTarget === "payment" && pickFirst(sp.capped) !== "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-emerald-600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg></span>
          <span>Payment recorded.</span>
        </div>
      )}
      {savedTarget === "payment" && pickFirst(sp.capped) === "1" && (() => {
        const requested = Number(pickFirst(sp.requested) ?? 0);
        const applied = Number(pickFirst(sp.applied) ?? 0);
        return (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            <div className="flex items-center gap-2 font-semibold">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><path d="M20 6L9 17l-5-5" /></svg>
              <span>Payment recorded — capped to invoice balance</span>
            </div>
            <div className="mt-1 text-[12.5px] text-amber-800">
              You entered <span className="font-mono">${(requested / 100).toFixed(2)}</span> but only{" "}
              <span className="font-mono">${(applied / 100).toFixed(2)}</span> was owed. The extra{" "}
              <span className="font-mono">${((requested - applied) / 100).toFixed(2)}</span> was not recorded — refund the payer separately if needed.
            </div>
          </div>
        );
      })()}

      {/* Hero */}
      <header className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        {/* In-hero "Invoices" back-link removed — the top Back button + the
            breadcrumb directly above already cover it (was a 3rd back path in
            the first ~200px). */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight text-ppp-charcoal font-mono">
                {invoice.invoice_number}
              </h1>
              <StatusPill status={displayStatus} />
            </div>
            <div className="text-[12px] text-ppp-charcoal-500 mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              {account && (
                <>
                  <Link href={`/commercial/accounts/${account.id}`} className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 underline underline-offset-2 font-medium">
                    {account.company_name}
                    {formatAccountNumber(account.account_seq) && (
                      <span className="no-underline font-mono text-[10px] text-ppp-navy-600">
                        {formatAccountNumber(account.account_seq)}
                      </span>
                    )}
                  </Link>
                  <span aria-hidden>·</span>
                </>
              )}
              {opp && (
                <>
                  {/* Route to the opportunity's real home (account drill-in
                      sheet), archived-safe — /opportunities/[id] bounces. */}
                  <Link
                    href={`/commercial/accounts/${opp.account_id}?tab=opportunities&edit=${opp.id}${opp.archived_at ? "&archived=1" : ""}#deal-row-${opp.id}`}
                    className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 underline underline-offset-2"
                  >
                    {derivedOppName(opp, account?.company_name ?? null)}
                    {formatOpportunityNumber(opp.project_number) && (
                      <span className="no-underline font-mono text-[10px] text-ppp-navy-600">
                        {formatOpportunityNumber(opp.project_number)}
                      </span>
                    )}
                  </Link>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>Created {fmtEtDate(invoice.created_at)}</span>
              {invoice.sent_at && (
                <>
                  <span aria-hidden>·</span>
                  <span>Sent {fmtEtDate(invoice.sent_at)}</span>
                </>
              )}
            </div>
            {invoice.proposal_id && (
              <div className="mt-2 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/60 px-3 py-1.5 text-[11.5px] text-ppp-charcoal-600">
                <span className="inline-flex items-center gap-1 font-semibold text-ppp-charcoal-700">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
                  {linkedProposal ? formatProposalNumber(linkedProposal.proposal_seq) || `R${linkedProposal.revision_number}` : "Linked proposal"}
                </span>
                {thisInvoiceProposalIndex >= 0 && proposalSiblings.length > 1 && (
                  <span>Progress invoice {thisInvoiceProposalIndex + 1} of {proposalSiblings.length}</span>
                )}
                {proposalContractCents != null && (
                  <span>
                    <strong className="text-ppp-charcoal-700 tabular-nums">{formatCentsFull(billedAgainstProposalCents)}</strong> of <span className="tabular-nums">{formatCentsFull(proposalContractCents)}</span> billed
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <CopyInvoiceLinkButton />
            {/* New invoice for this opp — Karan 2026-07-07: "give the
                ability to add another invoice even after the first one
                is created." Only shown when the parent opp is Won +
                exists (all created invoices satisfy that but be safe). */}
            {opp && isWon(opp) && (
              <Link
                href={`/commercial/invoices/new?opp=${opp.id}`}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30"
                title={`Add another invoice for ${derivedOppName(opp, account?.company_name ?? null)}. Progress-billing friendly.`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14 M5 12h14" />
                </svg>
                New invoice for this opp
              </Link>
            )}
            <form action={deleteDraftAction} className="inline">
              <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
              {/* Karan 2026-07-15: honor `from` so deleting an invoice
                  opened from an account or opp Invoices tab lands the
                  undo toast on THAT tab, not the global invoices list. */}
              {fromRaw && <input type="hidden" name="from" value={fromRaw} />}
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-rose-200 text-rose-700 text-[12px] font-semibold hover:bg-rose-50 min-h-[44px] touch-manipulation"
                title="Remove this invoice from the list. The row stays in the DB for audit but is hidden everywhere."
              >
                Delete invoice
              </button>
            </form>
            {/* Karan 2026-07-08: bulk-delete siblings when the parent
                (deal or account) is soft-deleted. Same guards as the
                cluster-header variant on /commercial/invoices — must
                be an orphan cleanup, no invoice with recorded payments.
                Prefers deal scope when the deal is deleted; falls back
                to account scope when only the account is deleted. */}
            {isOrphan && hasSiblings && (() => {
              const scope: "opp" | "account" | null = !opp
                ? "opp"
                : !account
                ? "account"
                : null;
              if (!scope) return null;
              const parent_id = scope === "opp" ? invoice.opportunity_id : invoice.account_id;
              const scopeLabel = scope === "opp" ? "opportunity" : "account";
              const siblingsForBulk = siblingsSorted;
              const paidCount = siblingsForBulk.filter((s) => (s.paid_cents ?? 0) > 0 && s.status !== "void").length;
              return (
                <details className="relative">
                  <summary
                    className="list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-semibold min-h-[44px] touch-manipulation bg-rose-600 text-white hover:bg-rose-700 shadow-sm shadow-rose-600/25"
                    title={`Delete every invoice attached to this deleted ${scopeLabel}. Paid invoices auto-void first.`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                    Delete all {siblingsForBulk.length}
                  </summary>
                  <div className="absolute right-0 top-full mt-1.5 w-[calc(100vw-2rem)] max-w-xs bg-surface border border-rose-200 rounded-lg shadow-lg p-3 z-10">
                    <div className="text-[12px] text-ppp-charcoal-700 mb-2 leading-snug">
                      Permanently hide all <strong>{siblingsForBulk.length}</strong> invoice
                      {siblingsForBulk.length === 1 ? "" : "s"} attached to this deleted {scopeLabel}.
                      {paidCount > 0 && (
                        <> {paidCount} paid invoice{paidCount === 1 ? "" : "s"} will auto-void first — payment history stays in the audit log.</>
                      )}
                      {" "}Rows stay in the DB for audit history.
                    </div>
                    <form action={bulkDeleteInvoicesFromDetailAction}>
                      <input type="hidden" name="scope" value={scope} />
                      <input type="hidden" name="parent_id" value={parent_id} />
                      <input type="hidden" name="confirm" value="yes" />
                      <input type="hidden" name="back_href" value={backHref} />
                      <button
                        type="submit"
                        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-rose-600 text-white text-[12px] font-semibold hover:bg-rose-700 min-h-[36px] touch-manipulation"
                      >
                        Yes, delete all {siblingsForBulk.length}
                      </button>
                    </form>
                  </div>
                </details>
              );
            })()}
          </div>
        </div>

        {/* Payment progress bar — always shown when there's a total.
            Karan 2026-07-07: makes the "how paid is this" glanceable
            without opening the payments log. Filled portion = paid_cents,
            total width = total_cents. Emerald because "money in" is a
            semantic win. */}
        {invoice.total_cents > 0 && !isVoid && (
          <a
            href="#payments"
            className="mt-5 block rounded-lg -mx-1 px-1 py-1 hover:bg-ppp-charcoal-50/60 transition-colors focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
            title="Jump to Payments"
          >
            <PaymentProgressBar
              paidCents={invoice.paid_cents}
              totalCents={invoice.total_cents}
              overdue={deriveInvoiceStatus(invoice) === "overdue"}
              label="Payment progress"
              amounts={{ paid: formatCentsFull(invoice.paid_cents), total: formatCentsFull(invoice.total_cents) }}
            />
          </a>
        )}

        {/* Per-milestone breakdown — the bar splits into one labeled chunk per
            milestone (name · due date · paid state) so the schedule reads at a
            glance. */}
        {hasMilestones && !isVoid && (
          <div className="mt-4">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ppp-charcoal-500 mb-2">Milestones</div>
            <SegmentedMeter segments={milestoneSegments} />
          </div>
        )}

        {/* Big numbers */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <BigNumber label="Total invoiced" value={formatCentsFull(invoice.total_cents)} tone="cc-brand" />
          <BigNumber label="Paid" value={formatCentsFull(invoice.paid_cents)} tone="emerald" />
          {invoice.balance_cents < 0 ? (
            // Overpaid (a line item was removed after payment, or an overpayment
            // landed) — show it as a credit, not a negative "outstanding".
            <BigNumber label="Overpaid (credit)" value={formatCentsFull(-invoice.balance_cents)} tone="emerald" />
          ) : (
            <BigNumber label="Outstanding balance" value={formatCentsFull(invoice.balance_cents)} tone={invoice.balance_cents > 0 ? "cc-brand" : "neutral"} />
          )}
          <BigNumber
            label="Due"
            value={fmtEtDate(invoice.due_at)}
            sub={daysUntilDue === null ? undefined : daysUntilDue < 0 ? `${Math.abs(daysUntilDue)} days overdue` : daysUntilDue === 0 ? "Due today" : `In ${daysUntilDue} days`}
            tone={
              daysUntilDue !== null && daysUntilDue < 0 && !isVoid && invoice.balance_cents > 0
                ? "rose"
                : "neutral"
            }
          />
        </div>
      </header>

      {/* Status actions */}
      {nextStatuses.length > 0 && !isVoid && (
        <section className="bg-surface border border-cc-brand-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
            <div>
              <h2 className="text-sm font-bold text-ppp-charcoal">Status</h2>
              <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
                Currently <strong className="text-ppp-charcoal">{invoiceStatusLabel(invoice.status)}</strong>. Flip whenever it fits your flow — payments record regardless.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {nextStatuses.map((s) => (
              <form key={s} action={changeStatusAction} className="inline">
                <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
                <input type="hidden" name="to_status" value={s} />
                <button
                  type="submit"
                  className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold min-h-[44px] touch-manipulation transition-colors ${
                    s === "void"
                      ? "border border-rose-200 text-rose-700 bg-surface hover:bg-rose-50"
                      : "bg-cc-brand-600 text-white hover:bg-cc-brand-700 active:bg-cc-brand-800 shadow-sm shadow-cc-brand-600/30"
                  }`}
                >
                  {s === "sent" ? "Mark as sent" : s === "viewed" ? "Mark as viewed" : s === "void" ? "Void" : invoiceStatusLabel(s)}
                </button>
              </form>
            ))}
          </div>
        </section>
      )}

      {/* What this charge is for. Karan 2026-07-07: renamed from "Line
          items" — this platform's model is one bill per line, so "line
          items" reads as accountant-speak. Clearer plain-English name. */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal">{hasMilestones ? "Totals" : "What this charge is for"}</h2>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
              {lineItems.length === 0
                ? "Nothing on this bill yet."
                : hasMilestones
                ? "The breakdown is in Milestones below."
                : `Subtotal ${formatCentsFull(invoice.subtotal_cents)}`}
            </p>
          </div>
        </div>

        {/* Milestone invoices: a compact totals block (the per-line breakdown
            lives in the Milestones section, so the full table is redundant). */}
        {lineItems.length > 0 && hasMilestones && (
          <div className="text-[12.5px] text-ppp-charcoal-600 space-y-1 max-w-xs">
            <div className="flex justify-between gap-4"><span>Subtotal</span><span className="tabular-nums font-semibold text-ppp-charcoal">{formatCentsFull(invoice.subtotal_cents)}</span></div>
            {invoice.tax_pct > 0 && <div className="flex justify-between gap-4"><span>Tax ({invoice.tax_pct}%)</span><span className="tabular-nums">{formatCentsFull(invoice.total_cents - invoice.subtotal_cents)}</span></div>}
            <div className="flex justify-between gap-4 border-t border-ppp-charcoal-100 pt-1 font-bold text-ppp-charcoal"><span>Total</span><span className="tabular-nums text-cc-brand-700">{formatCentsFull(invoice.total_cents)}</span></div>
          </div>
        )}

        {lineItems.length > 0 && !hasMilestones && (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-[12px] font-semibold text-ppp-charcoal-700 border-b border-ppp-charcoal-100">
                  <th className="py-2 pr-3">Description</th>
                  <th className="py-2 pr-3 text-right w-24">Qty</th>
                  <th className="py-2 pr-3 w-24">Unit</th>
                  <th className="py-2 pr-3 text-right w-28">Unit price</th>
                  <th className="py-2 pr-3 text-right w-28">Subtotal</th>
                  <th className="py-2 pl-2 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li) => (
                  <tr key={li.id} className="border-b border-ppp-charcoal-50 last:border-b-0 hover:bg-ppp-charcoal-50/40">
                    <td className="py-2.5 pr-3 text-ppp-charcoal align-top">{li.description}</td>
                    <td className="py-2.5 pr-3 text-right text-ppp-charcoal-700 tabular-nums align-top">
                      {li.quantity.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                    </td>
                    <td className="py-2.5 pr-3 text-ppp-charcoal-600 align-top">{li.unit ? productUnitLabel(li.unit) : "—"}</td>
                    <td className="py-2.5 pr-3 text-right text-ppp-charcoal-700 tabular-nums align-top">{formatCentsFull(li.unit_price_cents)}</td>
                    <td className="py-2.5 pr-3 text-right font-semibold text-ppp-charcoal tabular-nums align-top">{formatCentsFull(li.subtotal_cents)}</td>
                    <td className="py-2.5 pl-2 text-right align-top">
                      {/* When milestones drive the charges, they own add/remove —
                          editing a line item directly here would desync the
                          milestone/charge pairing. Manage via Milestones below. */}
                      {!isVoid && !hasMilestones && (
                        <form action={removeLineItemAction} className="inline">
                          <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
                          <input type="hidden" name="item_id" value={li.id} />
                          <button
                            type="submit"
                            title="Remove line item — recalculates total + progress"
                            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg text-ppp-charcoal-500 hover:bg-rose-50 hover:text-rose-700 touch-manipulation"
                          >
                            ×
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="py-3 pr-3 text-right text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Subtotal</td>
                  <td className="py-3 pr-3 text-right font-bold text-ppp-charcoal tabular-nums">{formatCentsFull(invoice.subtotal_cents)}</td>
                  <td />
                </tr>
                {invoice.tax_pct > 0 && (
                  <tr>
                    <td colSpan={4} className="py-1 pr-3 text-right text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Tax ({invoice.tax_pct}%)</td>
                    <td className="py-1 pr-3 text-right text-ppp-charcoal-700 tabular-nums">{formatCentsFull(invoice.total_cents - invoice.subtotal_cents)}</td>
                    <td />
                  </tr>
                )}
                <tr className="border-t border-ppp-charcoal-100">
                  <td colSpan={4} className="py-2 pr-3 text-right text-[11px] font-bold uppercase tracking-wider text-cc-brand-700">Total invoiced</td>
                  <td className="py-2 pr-3 text-right font-bold text-cc-brand-700 tabular-nums">{formatCentsFull(invoice.total_cents)}</td>
                  <td />
                </tr>
                {/* Karan 2026-07-07: inline paid + balance rows so the
                    reconciliation reads without scrolling to the
                    Payments section below. */}
                {invoice.paid_cents > 0 && (
                  <tr>
                    <td colSpan={4} className="py-1 pr-3 text-right text-[11px] font-bold uppercase tracking-wider text-emerald-700">Paid</td>
                    <td className="py-1 pr-3 text-right font-semibold text-emerald-700 tabular-nums">− {formatCentsFull(invoice.paid_cents)}</td>
                    <td />
                  </tr>
                )}
                {invoice.paid_cents > 0 && (
                  <tr className="border-t border-ppp-charcoal-100">
                    <td colSpan={4} className="py-2 pr-3 text-right text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-700">
                      {invoice.balance_cents < 0 ? "Overpaid (credit)" : "Outstanding balance"}
                    </td>
                    <td className={`py-2 pr-3 text-right font-bold tabular-nums ${
                      invoice.balance_cents === 0 ? "text-emerald-700" : invoice.balance_cents < 0 ? "text-emerald-700" : "text-ppp-charcoal"
                    }`}>{formatCentsFull(invoice.balance_cents < 0 ? -invoice.balance_cents : invoice.balance_cents)}</td>
                    <td />
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        )}

        {/* Karan 2026-07-07: dropped the "Add another line" form entirely.
            The single-line-per-invoice model is cleaner — if you need to
            bill for something else on this deal, use "+ New invoice for
            this opp" in the hero above and it becomes its own row in
            progress billing. Line-item edits (existing rows) still work
            via the removeLineItemAction button next to each row. */}
      </section>

      {/* Payments */}
      <section id="payments" className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 scroll-mt-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal">Payments</h2>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
              {payments.length === 0 ? "No payments recorded yet." : `${payments.length} payment${payments.length === 1 ? "" : "s"} · ${formatCentsFull(invoice.paid_cents)} of ${formatCentsFull(invoice.total_cents)} paid`}
            </p>
          </div>
        </div>

        {payments.length > 0 && (
          <ul className="divide-y divide-ppp-charcoal-100">
            {payments.map((p) => (
              <li key={p.id} className="py-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-ppp-charcoal tabular-nums">{formatCentsFull(p.amount_cents)}</span>
                    <span className="text-[11px] text-ppp-charcoal-500">· {fmtEtDate(p.paid_at)}</span>
                    {p.method && (
                      <span className="inline-flex items-center px-1.5 py-0 rounded bg-cc-brand-50 text-cc-brand-700 border border-cc-brand-200 text-[10px] font-medium">
                        {PAYMENT_METHODS.find((m) => m.key === p.method)?.label ?? p.method}
                      </span>
                    )}
                  </div>
                  {(p.reference || p.notes) && (
                    <div className="text-[12px] text-ppp-charcoal-600 mt-0.5">
                      {p.reference && <span>Ref: {p.reference}</span>}
                      {p.reference && p.notes && <span aria-hidden> · </span>}
                      {p.notes && <span>{p.notes}</span>}
                    </div>
                  )}
                </div>
                {!isVoid && (
                  <form action={removePaymentAction} className="inline">
                    <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
                    <input type="hidden" name="payment_id" value={p.id} />
                    <button
                      type="submit"
                      className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-lg text-rose-700 text-[11px] font-semibold hover:bg-rose-50 touch-manipulation"
                    >
                      Remove
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        {invoice.balance_cents > 0 && !isVoid && (
          <form action={addPaymentAction} className="mt-4 pt-4 border-t border-ppp-charcoal-100 grid grid-cols-1 sm:grid-cols-12 gap-2">
            <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
            <div className="sm:col-span-3">
              <label htmlFor="pmt-amount" className={LABEL_CLS}>Amount *</label>
              <input id="pmt-amount" name="amount" type="text" required inputMode="decimal" placeholder={formatCentsFull(invoice.balance_cents)} className={INPUT_CLS} />
            </div>
            <div className="sm:col-span-3">
              <label htmlFor="pmt-date" className={LABEL_CLS}>Paid on</label>
              <DatePicker id="pmt-date" name="paid_at" defaultValue={new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })} placeholder="Payment date" ariaLabel="Payment date" />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="pmt-method" className={LABEL_CLS}>Method</label>
              <select id="pmt-method" name="method" defaultValue="" className={SELECT_CLS} style={SELECT_BG_STYLE}>
                <option value="">—</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-3">
              <label htmlFor="pmt-reference" className={LABEL_CLS}>Reference</label>
              <input id="pmt-reference" name="reference" type="text" maxLength={80} placeholder="Check #, wire memo" className={INPUT_CLS} />
            </div>
            <div className="sm:col-span-1 flex items-end">
              <button
                type="submit"
                className="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
              >
                Record
              </button>
            </div>
            <div className="sm:col-span-12">
              <label htmlFor="pmt-notes" className={LABEL_CLS}>Notes</label>
              <input id="pmt-notes" name="notes" type="text" maxLength={500} placeholder="Optional — internal notes" className={INPUT_CLS} />
            </div>
          </form>
        )}
        {invoice.balance_cents === 0 && payments.length > 0 && (
          <p className="mt-2 text-[12px] text-emerald-700 font-medium inline-flex items-center gap-1"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg> Fully paid.</p>
        )}
      </section>

      {/* Details — Karan 2026-07-07: due date + PO + terms + messages
          editable at ANY status (they're presentation fields). Only tax
          is draft-only because it changes the total (guarded server-side
          in verifyEditable). Void/deleted invoices can't be edited at all.
          Karan 2026-07-07 (follow-up): wrapped in <details> so the form
          doesn't dominate the page — most viewers just want the hero +
          progress; the form only opens when someone needs to change
          the due date or add a note. */}
      <details
        open={savedTarget === "details"}
        className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 group/details"
      >
        <summary className="list-none cursor-pointer flex items-center justify-between gap-3 min-h-[36px]">
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open/details:rotate-90 text-ppp-charcoal-500">
                <path d="M9 18l6-6-6-6" />
              </svg>
              Details
            </h2>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 ml-[18px]">
              {isVoid
                ? "This invoice is void. Restore it to draft to make changes."
                : "Payment terms, PO#, tax %, message to the GC, and the invoice due date."}
            </p>
          </div>
          <span className="text-[11px] font-semibold text-cc-brand-700 group-open/details:hidden">Edit</span>
          <span className="text-[11px] font-semibold text-ppp-charcoal-500 hidden group-open/details:inline">Close</span>
        </summary>
        {/* Karan 2026-07-07: Details form used to render as 6 fields
            stacked in 2 loud ALL-CAPS columns — got crowded fast when a
            deal had multiple invoices. New layout uses softer sentence-
            case labels (SOFT_LABEL_CLS below) and puts the 4 short fields
            on a single 4-col row when width allows, then Message + Notes
            span full-width. Same fields, half the vertical footprint. */}
        <form action={updateCoreFieldsAction} className="mt-4 pt-4 border-t border-ppp-charcoal-100 space-y-3">
          <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
          {/* Row 1 — 4 short fields side-by-side on md+, 2 per row on sm,
              stacked on mobile. Due-date presets keep the taller footprint
              but fit within the same 4-col track. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label htmlFor="dt-due" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">
                {hasMilestones ? "Invoice due (overall)" : "Due date"}
              </label>
              <DueDatePickerWithPresets
                id="dt-due"
                name="due_at"
                defaultValue={invoice.due_at ? invoice.due_at.slice(0, 10) : ""}
                disabled={isVoid}
              />
              {hasMilestones && <p className="text-[10px] text-ppp-charcoal-400 mt-1">Each milestone has its own due date — edit those on the milestones above.</p>}
            </div>
            <div>
              <label htmlFor="dt-terms" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">Payment terms</label>
              {/* Karan 2026-07-07 Alex-love: datalist gives Alex a picker
                  (Net 15/30/45/60/EOM) but keeps the free-text field so
                  custom wording like "Net 30 upon delivery" still works. */}
              <input
                id="dt-terms"
                name="payment_terms"
                type="text"
                maxLength={60}
                list="dt-terms-presets"
                defaultValue={invoice.payment_terms ?? ""}
                disabled={isVoid}
                placeholder="Net 30"
                className={INPUT_CLS}
              />
              <datalist id="dt-terms-presets">
                <option value="Due on receipt" />
                <option value="Net 15" />
                <option value="Net 30" />
                <option value="Net 45" />
                <option value="Net 60" />
                <option value="Net 90" />
                <option value="End of month" />
                <option value="50% deposit, 50% on completion" />
                <option value="Progress billing per contract" />
              </datalist>
            </div>
            <div>
              <label htmlFor="dt-tax" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">
                Tax % (flat)
                {!isDraft && !isVoid && <span className="ml-1 text-[10px] font-normal text-ppp-charcoal-400">(draft-only)</span>}
              </label>
              <input id="dt-tax" name="tax_pct" type="text" inputMode="decimal" pattern="[0-9.]*" defaultValue={invoice.tax_pct} disabled={!isDraft} className={INPUT_CLS} />
            </div>
            <div>
              <label htmlFor="dt-po" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">PO number</label>
              <input id="dt-po" name="po_number" type="text" maxLength={80} defaultValue={invoice.po_number ?? ""} disabled={isVoid} className={INPUT_CLS} />
            </div>
          </div>
          {/* Message to the GC — appears on the customer copy. Internal notes
              moved to their own section at the bottom. */}
          <div>
            <label htmlFor="dt-msg" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">Message to GC</label>
            <textarea id="dt-msg" name="customer_message" rows={2} maxLength={1000} defaultValue={invoice.customer_message ?? ""} disabled={isVoid} placeholder="Optional — appears above line items on the GC's copy." className={TEXTAREA_CLS} />
          </div>
          {!isVoid && (
            <div className="flex justify-end">
              <button type="submit" className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px]">
                Save details
              </button>
            </div>
          )}
        </form>
      </details>

      {/* Milestones — an optional schedule-of-values breakdown of this invoice.
          Each milestone has its own amount, due date and lien waiver. Flat
          invoices (no milestones) keep a single invoice-level lien waiver. */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
        <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <h2 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            {hasMilestones ? "Milestones & lien waivers" : "Lien waiver"}
          </h2>
          {hasMilestones && (
            <span className="text-[11px] font-semibold text-ppp-charcoal-500 tabular-nums">
              {milestones.length} milestone{milestones.length === 1 ? "" : "s"} · {formatCentsFull(milestoneSum)}
              {milestoneSum !== invoice.subtotal_cents && (
                <span className="ml-1 text-amber-700">≠ subtotal {formatCentsFull(invoice.subtotal_cents)}</span>
              )}
            </span>
          )}
        </div>

        {hasMilestones ? (
          <>
            <p className="text-[12px] text-ppp-charcoal-500 mb-3">This invoice is billed in milestones. Set each one&rsquo;s due date and upload its signed lien waiver as the GC returns them.</p>
            <ul className="space-y-3">
              {milestones.map((m, idx) => {
                const w = milestoneWaivers.get(m.id) ?? null;
                const mPaid = milestonePaid.get(m.id) ?? 0;
                const mDue = Math.max(0, m.amount_cents - mPaid);
                const mFullyPaid = m.amount_cents > 0 && mPaid >= m.amount_cents;
                const mPartial = mPaid > 0 && !mFullyPaid;
                const mPayments = payments.filter((pp) => pp.milestone_id === m.id);
                return (
                  <li key={m.id} className="rounded-xl border border-ppp-charcoal-100 p-3.5">
                    {/* Header — reads at a glance: name, amount, status, due. */}
                    <div className="flex items-start justify-between gap-3 mb-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-ppp-blue-700">Milestone {idx + 1}</span>
                          {mFullyPaid ? (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-[9.5px] font-bold uppercase tracking-wide text-emerald-700"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>Paid</span>
                          ) : mPartial ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-ppp-blue-50 border border-ppp-blue-200 text-[9.5px] font-bold uppercase tracking-wide text-ppp-blue-800 tabular-nums">{formatCentsFull(mPaid)} paid</span>
                          ) : null}
                        </div>
                        <div className="text-[13px] font-semibold text-ppp-charcoal mt-0.5 truncate">{m.name}</div>
                        <div className="text-[11px] text-ppp-charcoal-500">
                          {m.due_at ? `Due ${fmtEtDate(m.due_at)}` : "No due date"}
                          {m.change_order_id && <span className="text-ppp-navy-600"> · from change order</span>}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[15px] font-bold tabular-nums text-ppp-charcoal">{formatCentsFull(m.amount_cents)}</div>
                        {mDue > 0 && mPaid > 0 && <div className="text-[10px] text-ppp-charcoal-500 tabular-nums">{formatCentsFull(mDue)} left</div>}
                      </div>
                    </div>

                    {/* Actions — Record payment is a clear green button; Edit +
                        Remove tuck behind toggles so the card stays clean. */}
                    {!isVoid && !mFullyPaid && (
                      <details className="group/mp mb-2.5">
                        <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 hover:text-emerald-800 min-h-[32px] select-none">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14 M5 12h14" /></svg>
                          Record payment
                        </summary>
                        <form action={recordMilestonePaymentAction} className="px-3 pb-3 pt-1 space-y-2">
                          <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
                          <input type="hidden" name="milestone_id" value={m.id} />
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div>
                              <label className={LABEL_CLS} htmlFor={`mp-amt-${m.id}`}>Amount</label>
                              <input id={`mp-amt-${m.id}`} name="amount" required inputMode="decimal" defaultValue={(mDue / 100).toFixed(2)} className={INPUT_CLS} />
                            </div>
                            <div>
                              <label className={LABEL_CLS} htmlFor={`mp-date-${m.id}`}>Paid on</label>
                              <input id={`mp-date-${m.id}`} name="paid_at" type="date" className={INPUT_CLS} />
                            </div>
                            <div>
                              <label className={LABEL_CLS} htmlFor={`mp-method-${m.id}`}>Method</label>
                              <select id={`mp-method-${m.id}`} name="method" defaultValue="" className={SELECT_CLS} style={SELECT_BG_STYLE}>
                                <option value="">—</option>
                                {PAYMENT_METHODS.map((pm) => <option key={pm.key} value={pm.key}>{pm.label}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className={LABEL_CLS} htmlFor={`mp-ref-${m.id}`}>Reference</label>
                              <input id={`mp-ref-${m.id}`} name="reference" maxLength={200} placeholder="Check #" className={INPUT_CLS} />
                            </div>
                          </div>
                          <div>
                            <label className={LABEL_CLS} htmlFor={`mp-notes-${m.id}`}>Notes</label>
                            <input id={`mp-notes-${m.id}`} name="notes" maxLength={500} placeholder="Optional — deposit received, partial, etc." className={INPUT_CLS} />
                          </div>
                          <div className="flex justify-end">
                            <button type="submit" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 text-white text-[12px] font-semibold hover:bg-emerald-700 min-h-[44px] touch-manipulation">Record payment</button>
                          </div>
                        </form>
                      </details>
                    )}

                    {/* Payment history for this milestone — where the notes land. */}
                    {mPayments.length > 0 && (
                      <ul className="mb-2.5 space-y-1">
                        {mPayments.map((pp) => (
                          <li key={pp.id} className="flex items-start justify-between gap-2 text-[11px] pl-2.5 border-l-2 border-emerald-200">
                            <span className="min-w-0">
                              <span className="font-semibold text-emerald-700 tabular-nums">{formatCentsFull(pp.amount_cents)}</span>
                              <span className="text-ppp-charcoal-400"> · {fmtEtDate(pp.paid_at)}{pp.method ? ` · ${pp.method}` : ""}{pp.reference ? ` · ${pp.reference}` : ""}</span>
                              {pp.notes && <span className="block text-ppp-charcoal-500">{pp.notes}</span>}
                            </span>
                            <form action={removePaymentAction} className="inline shrink-0">
                              <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
                              <input type="hidden" name="payment_id" value={pp.id} />
                              <button type="submit" className="text-ppp-charcoal-300 hover:text-rose-600 min-h-[28px] px-1" title="Remove this payment" aria-label="Remove payment">×</button>
                            </form>
                          </li>
                        ))}
                      </ul>
                    )}

                    <LienWaiverUpload
                      milestoneId={m.id}
                      hasWaiver={!!w}
                      downloadHref={w ? `/api/commercial/documents/${w.id}/download` : null}
                      fileName={w?.file_name ?? null}
                      compact
                    />

                    {/* Edit name/amount/due + Remove — tucked away so the card
                        stays clean. */}
                    {!isVoid && (
                      <div className="flex items-center gap-3 mt-2.5">
                        <details className="group/edit flex-1 min-w-0">
                          <summary className="list-none cursor-pointer inline-flex items-center gap-1 text-[11px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal min-h-[32px] select-none">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" /></svg>
                            Edit
                          </summary>
                          <form action={updateMilestoneAction} className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_9rem_auto] gap-2 items-end mt-2">
                            <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
                            <input type="hidden" name="milestone_id" value={m.id} />
                            <div>
                              <label className={LABEL_CLS} htmlFor={`m-name-${m.id}`}>Name</label>
                              <input id={`m-name-${m.id}`} name="name" defaultValue={m.name} maxLength={200} className={INPUT_CLS} />
                            </div>
                            <div>
                              <label className={LABEL_CLS} htmlFor={`m-amt-${m.id}`}>Amount</label>
                              <input id={`m-amt-${m.id}`} name="amount" defaultValue={(m.amount_cents / 100).toFixed(2)} inputMode="decimal" className={INPUT_CLS} />
                            </div>
                            <div>
                              <label className={LABEL_CLS} htmlFor={`m-due-${m.id}`}>Due date</label>
                              <input id={`m-due-${m.id}`} name="due_at" type="date" defaultValue={m.due_at ? m.due_at.slice(0, 10) : ""} className={INPUT_CLS} />
                            </div>
                            <button type="submit" className="inline-flex items-center justify-center px-3 py-2 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation">Save</button>
                          </form>
                        </details>
                        <form action={deleteMilestoneAction} className="inline shrink-0">
                          <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
                          <input type="hidden" name="milestone_id" value={m.id} />
                          <button type="submit" className="text-[11px] font-medium text-ppp-charcoal-400 hover:text-rose-700 min-h-[32px] px-1.5" title="Remove this milestone (also removes its charge from the invoice)">Remove</button>
                        </form>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <p className="text-[12px] text-ppp-charcoal-500 mb-3">Upload the signed lien waiver the GC sends back — it also lands in this deal&rsquo;s Documents. Or break this invoice into milestones below.</p>
            <LienWaiverUpload
              invoiceId={invoice.id}
              hasWaiver={!!lienWaiver}
              downloadHref={lienWaiver ? `/api/commercial/documents/${lienWaiver.id}/download` : null}
              fileName={lienWaiver?.file_name ?? null}
            />
          </>
        )}

        {/* Add a milestone — a scheduled charge that grows the invoice total.
            Also how a flat invoice gets broken into milestones. */}
        {!isVoid && (
          <details className="group mt-3">
            <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[12px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[40px]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open:rotate-45"><path d="M12 5v14 M5 12h14" /></svg>
              Add a milestone
            </summary>
            <form action={addMilestoneAction} className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_7rem_9rem_auto] gap-2 items-end">
              <input type="hidden" name="invoice_id" value={invoice.id} />
                          <input type="hidden" name="from" value={fromRaw ?? ""} />
              <div>
                <label className={LABEL_CLS} htmlFor="am-name">Name</label>
                <input id="am-name" name="name" required maxLength={200} placeholder="e.g. Retainage release" className={INPUT_CLS} />
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="am-amt">Amount</label>
                <input id="am-amt" name="amount" required inputMode="decimal" placeholder="0.00" className={INPUT_CLS} />
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="am-due">Due date</label>
                <input id="am-due" name="due_at" type="date" className={INPUT_CLS} />
              </div>
              <button type="submit" className="inline-flex items-center justify-center px-3 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation">Add</button>
            </form>
            <p className="text-[10.5px] text-ppp-charcoal-400 mt-1.5">Adds a scheduled charge to this invoice (raises the total by the amount). Each milestone then carries its own lien waiver.</p>
          </details>
        )}
      </section>

      {/* Notes — a simple internal-notes box that saves on its own (never
          touches the other fields, never on the GC copy). */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-1 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-ppp-blue-500" />
          Notes
        </h2>
        <p className="text-[12px] text-ppp-charcoal-500 mb-3">Internal only — never shown to the GC. Saved to this invoice and visible on the deal.</p>
        <form action={saveInvoiceNotesAction} className="space-y-2">
          <input type="hidden" name="invoice_id" value={invoice.id} />
          <input type="hidden" name="from" value={fromRaw ?? ""} />
          <textarea name="notes" rows={3} maxLength={2000} defaultValue={invoice.notes ?? ""} disabled={isVoid} placeholder="Add a note — payment arrangement, GC contact, anything the team should see." className={TEXTAREA_CLS} />
          {!isVoid && (
            <div className="flex justify-end">
              <button type="submit" className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-blue-600 text-white text-[13px] font-semibold hover:bg-ppp-blue-700 min-h-[44px]">Save notes</button>
            </div>
          )}
        </form>
      </section>

      {/* Status history */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Status history</h2>
        {statusLog.length === 0 ? (
          <p className="text-[12px] text-ppp-charcoal-500 italic">Nothing logged yet.</p>
        ) : (
          <ol className="relative border-l border-ppp-charcoal-100 ml-1 space-y-4">
            {statusLog.map((row) => (
              <li key={row.id} className="ml-4 relative">
                <span
                  aria-hidden
                  className="absolute -left-[21px] top-1 h-3 w-3 rounded-full bg-cc-brand-500 border-2 border-white shadow-sm"
                />
                <div className="text-sm font-semibold text-ppp-charcoal">
                  {row.from_status ? `${invoiceStatusLabel(row.from_status as InvoiceStatus)} → ${invoiceStatusLabel(row.to_status as InvoiceStatus)}` : invoiceStatusLabel(row.to_status as InvoiceStatus)}
                </div>
                <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                  {fmtEtDate(row.created_at)}
                  {row.note && <span> · {row.note}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function BigNumber({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "cc-brand" | "blue" | "emerald" | "rose" | "neutral" }) {
  // "Paid" is a success metric → emerald; blue stripe now paints real blue
  // (was cc-brand-500 red on a blue label).
  const stripe = tone === "cc-brand" ? "bg-cc-brand-600" : tone === "emerald" ? "bg-emerald-500" : tone === "blue" ? "bg-ppp-blue-500" : tone === "rose" ? "bg-rose-500" : "bg-ppp-charcoal-200";
  const valueCls = tone === "rose" ? "text-rose-700" : tone === "emerald" ? "text-emerald-700" : "text-ppp-charcoal";
  return (
    <div className="relative border border-ppp-charcoal-100 rounded-lg px-4 py-3 overflow-hidden bg-gradient-to-br from-surface to-ppp-charcoal-50/40">
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[12px] font-semibold text-ppp-charcoal-700">
        {label}
      </div>
      <div className={`font-condensed text-2xl sm:text-3xl font-black mt-1 leading-none tabular-nums ${valueCls}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: InvoiceStatus }) {
  const cls =
    status === "paid"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "overdue"
      ? "bg-rose-100 text-rose-800 border-rose-300"
      : status === "void"
      ? "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200"
      : status === "sent" || status === "viewed"
      ? "bg-ppp-blue-100 text-ppp-blue-800 border-ppp-blue-200"
      : status === "partial"
      ? "bg-amber-100 text-amber-900 border-amber-300"
      : "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border ${cls}`}>
      {invoiceStatusLabel(status)}
    </span>
  );
}
