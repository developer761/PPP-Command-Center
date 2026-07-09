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
import {
  deriveInvoiceStatus,
  invoiceStatusLabel,
  PAYMENT_METHODS,
  type InvoiceStatus,
} from "@/lib/commercial/invoices/constants";
import { formatCentsFull, fmtEtDate, parseDollarsToCents, daysBetween } from "@/lib/commercial/invoices/format";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import DueDatePickerWithPresets from "@/components/commercial/due-date-picker-with-presets";
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

async function addLineItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const description = String(formData.get("description") ?? "").trim();
  const quantity = parseFloat(String(formData.get("quantity") ?? "1"));
  const unit = String(formData.get("unit") ?? "").trim() || null;
  const priceRaw = String(formData.get("unit_price") ?? "");
  const unit_price_cents = parseDollarsToCents(priceRaw);
  if (!description || !Number.isFinite(quantity) || quantity <= 0 || unit_price_cents === null) {
    redirect(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent("Fill description, quantity, and price."));
  }
  const result = await addLineItem(invoice_id, { description, quantity, unit, unit_price_cents: unit_price_cents! });
  if (!result.ok) {
    redirect(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Failed to add line item."));
  }
  await revalidateInvoiceContext(invoice_id);
  redirect(`/commercial/invoices/${invoice_id}`);
}

async function removeLineItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const item_id = String(formData.get("item_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(item_id)) redirect("/commercial/invoices");
  await removeLineItem(invoice_id, item_id);
  await revalidateInvoiceContext(invoice_id);
  redirect(`/commercial/invoices/${invoice_id}`);
}

async function addPaymentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const amount = parseDollarsToCents(String(formData.get("amount") ?? ""));
  const paid_at = String(formData.get("paid_at") ?? "").trim() || undefined;
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (amount === null || amount <= 0) {
    redirect(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent("Enter a positive dollar amount (e.g., 250.00)."));
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
    redirect(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Failed to record payment."));
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
    redirect(`/commercial/invoices/${invoice_id}?${q.toString()}`);
  }
  redirect(`/commercial/invoices/${invoice_id}?saved=payment`);
}

async function removePaymentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const payment_id = String(formData.get("payment_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(payment_id)) redirect("/commercial/invoices");
  await removePayment(invoice_id, payment_id, user.id);
  await revalidateInvoiceContext(invoice_id);
  redirect(`/commercial/invoices/${invoice_id}`);
}

async function changeStatusAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const to_status = String(formData.get("to_status") ?? "") as InvoiceStatus;
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const result = await changeInvoiceStatus({ invoice_id, to_status, acting_user_id: user.id });
  if (!result.ok) {
    redirect(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error));
  }
  revalidatePath("/commercial/invoices");
  await revalidateInvoiceContext(invoice_id);
  redirect(`/commercial/invoices/${invoice_id}?saved=status`);
}

async function updateCoreFieldsAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  const tax_pct_raw = String(formData.get("tax_pct") ?? "");
  const tax_pct = tax_pct_raw ? parseFloat(tax_pct_raw) : undefined;
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
  if (tax_pct !== undefined && Number.isFinite(tax_pct)) patch.tax_pct = tax_pct;
  const result = await updateInvoiceCoreFields(invoice_id, patch);
  if (!result.ok) {
    redirect(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Could not save details."));
  }
  await revalidateInvoiceContext(invoice_id);
  redirect(`/commercial/invoices/${invoice_id}?saved=details`);
}

async function deleteDraftAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  if (!UUID_RE.test(invoice_id)) redirect("/commercial/invoices");
  // Capture context BEFORE the soft-delete so we can revalidate the
  // parent opp + account. After deleted_at is set, the row is still in
  // the DB, but semantically the panel should re-render without it —
  // the roll-up + progress bar totals need to drop this invoice's share.
  const ctx = await getInvoiceContext(invoice_id);
  const result = await softDeleteInvoice(invoice_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/invoices/${invoice_id}?error=` + encodeURIComponent(result.error ?? "Delete failed"));
  }
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  if (ctx.opportunity_id) revalidatePath(`/commercial/opportunities/${ctx.opportunity_id}`);
  if (ctx.account_id) revalidatePath(`/commercial/accounts/${ctx.account_id}`);
  redirect(`/commercial/invoices?deleted=1`);
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
  // Guard 2: block if any invoice has recorded payments.
  const parentCol = scope === "opp" ? "opportunity_id" : "account_id";
  const { data: invRows } = await sb
    .from("commercial_invoices")
    .select("id, paid_cents")
    .eq(parentCol, parent_id)
    .is("deleted_at", null);
  const rows = (invRows ?? []) as { id: string; paid_cents: number }[];
  const paidRows = rows.filter((r) => (r.paid_cents ?? 0) > 0);
  if (paidRows.length > 0) {
    redirect(`${back_href}${back_href.includes("?") ? "&" : "?"}error=${encodeURIComponent(`${paidRows.length} invoice${paidRows.length === 1 ? " has" : "s have"} recorded payments. Void those individually first.`)}`);
  }
  if (rows.length > 0) {
    await sb
      .from("commercial_invoices")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id));
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
  const [lineItems, payments, statusLog, account, opp, siblingInvoices] = await Promise.all([
    listInvoiceLineItems(invoice.id),
    listInvoicePayments(invoice.id),
    listInvoiceStatusLog(invoice.id),
    getCommercialAccount(invoice.account_id),
    getCommercialOpportunity(invoice.opportunity_id),
    listCommercialInvoices({ opportunityId: invoice.opportunity_id }),
  ]);
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
    // Natural parent: opp invoices tab > account invoices tab > list
    if (opp) return `/commercial/opportunities/${opp.id}?tab=invoices`;
    if (account) return `/commercial/accounts/${account.id}?tab=invoices`;
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
          className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 min-h-[32px] px-1 touch-manipulation"
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
              className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 min-h-[32px] px-1 touch-manipulation max-w-[220px] truncate"
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
              className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 min-h-[32px] px-1 touch-manipulation max-w-[220px] truncate"
              title={opp.title}
            >
              {opp.title}
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
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-600">
            <span className="inline-flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400">
                <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              <span className="font-semibold text-ppp-charcoal">
                Invoice {siblingIdx + 1} of {siblingsSorted.length}
              </span>
              <span aria-hidden>·</span>
              <Link
                href={`/commercial/opportunities/${opp.id}?tab=info`}
                className="text-blue-700 hover:text-blue-800 underline underline-offset-2"
              >
                {opp.title}
              </Link>
            </span>
          </div>
          <div className="flex items-center gap-1">
            {prevSibling ? (
              <Link
                href={`/commercial/invoices/${prevSibling.id}`}
                aria-label={`Previous invoice: ${prevSibling.invoice_number}`}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-blue-50 hover:border-blue-300 min-h-[36px] touch-manipulation"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                <span className="font-mono">{prevSibling.invoice_number.replace(/^PPP-INV-/, "…")}</span>
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
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-blue-50 hover:border-blue-300 min-h-[36px] touch-manipulation"
              >
                <span className="font-mono">{nextSibling.invoice_number.replace(/^PPP-INV-/, "…")}</span>
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
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Details saved.</span>
        </div>
      )}
      {savedTarget === "created" && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Invoice created.</span>
        </div>
      )}
      {savedTarget === "status" && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Status updated.</span>
        </div>
      )}
      {savedTarget === "payment" && pickFirst(sp.capped) !== "1" && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Payment recorded.</span>
        </div>
      )}
      {savedTarget === "payment" && pickFirst(sp.capped) === "1" && (() => {
        const requested = Number(pickFirst(sp.requested) ?? 0);
        const applied = Number(pickFirst(sp.applied) ?? 0);
        return (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            <div className="flex items-center gap-2 font-semibold">
              <span aria-hidden>✓</span>
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
      <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
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
                  <Link href={`/commercial/accounts/${account.id}`} className="text-blue-700 hover:text-blue-800 underline underline-offset-2 font-medium">
                    {account.company_name}
                  </Link>
                  <span aria-hidden>·</span>
                </>
              )}
              {opp && (
                <>
                  <Link href={`/commercial/opportunities/${opp.id}`} className="text-blue-700 hover:text-blue-800 underline underline-offset-2">
                    {opp.title}
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
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <CopyInvoiceLinkButton />
            {/* New invoice for this opp — Karan 2026-07-07: "give the
                ability to add another invoice even after the first one
                is created." Only shown when the parent opp is Won +
                exists (all created invoices satisfy that but be safe). */}
            {opp && opp.status === "won" && (
              <Link
                href={`/commercial/invoices/new?opp=${opp.id}`}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30"
                title={`Add another invoice for ${opp.title}. Progress-billing friendly.`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14 M5 12h14" />
                </svg>
                New invoice for this opp
              </Link>
            )}
            <form action={deleteDraftAction} className="inline">
              <input type="hidden" name="invoice_id" value={invoice.id} />
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
              const scopeLabel = scope === "opp" ? "deal" : "account";
              const siblingsForBulk = siblingsSorted;
              const anyPaid = siblingsForBulk.some((s) => (s.paid_cents ?? 0) > 0);
              return (
                <details className="relative">
                  <summary
                    className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-semibold min-h-[44px] touch-manipulation ${
                      anyPaid
                        ? "border border-ppp-charcoal-200 text-ppp-charcoal-500"
                        : "bg-rose-600 text-white hover:bg-rose-700 shadow-sm shadow-rose-600/25"
                    }`}
                    title={
                      anyPaid
                        ? "Some sibling invoices have recorded payments — void those individually first."
                        : `Delete every invoice attached to this deleted ${scopeLabel}.`
                    }
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                    Delete all {siblingsForBulk.length}
                  </summary>
                  {!anyPaid && (
                    <div className="absolute right-0 top-full mt-1.5 w-[calc(100vw-2rem)] max-w-xs bg-white border border-rose-200 rounded-lg shadow-lg p-3 z-10">
                      <div className="text-[12px] text-ppp-charcoal-700 mb-2 leading-snug">
                        Permanently hide all <strong>{siblingsForBulk.length}</strong> invoice
                        {siblingsForBulk.length === 1 ? "" : "s"} attached to this deleted {scopeLabel}. Rows stay in the DB for audit history.
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
                  )}
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
            className="mt-5 block group/pb rounded-lg -mx-1 px-1 py-1 hover:bg-ppp-charcoal-50/60 transition-colors focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
            title="Jump to Payments"
            aria-label={`Payment progress ${Math.min(100, Math.round((invoice.paid_cents / invoice.total_cents) * 100))}%. Click to jump to Payments.`}
          >
            <div className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wider mb-1">
              <span className="text-ppp-charcoal-500 group-hover/pb:text-ppp-charcoal-700 inline-flex items-center gap-1">
                Payment progress
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="opacity-40 group-hover/pb:opacity-100 transition-opacity">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
              <span className="text-ppp-charcoal-700">
                {Math.min(100, Math.round((invoice.paid_cents / invoice.total_cents) * 100))}%
              </span>
            </div>
            <div className="h-2 w-full bg-ppp-charcoal-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  invoice.paid_cents >= invoice.total_cents
                    ? "bg-emerald-500"
                    : invoice.paid_cents > 0
                    ? "bg-blue-500"
                    : "bg-ppp-charcoal-300"
                }`}
                style={{
                  width: `${Math.min(100, (invoice.paid_cents / invoice.total_cents) * 100)}%`,
                }}
              />
            </div>
          </a>
        )}

        {/* Big numbers */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <BigNumber label="Total invoiced" value={formatCentsFull(invoice.total_cents)} tone="cc-brand" />
          <BigNumber label="Paid" value={formatCentsFull(invoice.paid_cents)} tone="blue" />
          <BigNumber label="Outstanding balance" value={formatCentsFull(invoice.balance_cents)} tone={invoice.balance_cents > 0 ? "cc-brand" : "neutral"} />
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
        <section className="bg-white border border-cc-brand-200 rounded-xl p-5 shadow-sm">
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
                <input type="hidden" name="to_status" value={s} />
                <button
                  type="submit"
                  className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold min-h-[44px] touch-manipulation transition-colors ${
                    s === "void"
                      ? "border border-rose-200 text-rose-700 bg-white hover:bg-rose-50"
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
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal">What this charge is for</h2>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
              {lineItems.length === 0 ? "Nothing on this bill yet." : `Subtotal ${formatCentsFull(invoice.subtotal_cents)}`}
            </p>
          </div>
        </div>

        {lineItems.length > 0 && (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 border-b border-ppp-charcoal-100">
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
                    <td className="py-2.5 pr-3 text-ppp-charcoal-600 align-top">{li.unit ?? "—"}</td>
                    <td className="py-2.5 pr-3 text-right text-ppp-charcoal-700 tabular-nums align-top">{formatCentsFull(li.unit_price_cents)}</td>
                    <td className="py-2.5 pr-3 text-right font-semibold text-ppp-charcoal tabular-nums align-top">{formatCentsFull(li.subtotal_cents)}</td>
                    <td className="py-2.5 pl-2 text-right align-top">
                      {!isVoid && (
                        <form action={removeLineItemAction} className="inline">
                          <input type="hidden" name="invoice_id" value={invoice.id} />
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
                    <td colSpan={4} className="py-2 pr-3 text-right text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-700">Outstanding balance</td>
                    <td className={`py-2 pr-3 text-right font-bold tabular-nums ${
                      invoice.balance_cents === 0 ? "text-emerald-700" : "text-ppp-charcoal"
                    }`}>{formatCentsFull(invoice.balance_cents)}</td>
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
      <section id="payments" className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 scroll-mt-4">
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
                      <span className="inline-flex items-center px-1.5 py-0 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-medium">
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
            <div className="sm:col-span-3">
              <label htmlFor="pmt-amount" className={LABEL_CLS}>Amount *</label>
              <input id="pmt-amount" name="amount" type="text" required inputMode="decimal" placeholder={formatCentsFull(invoice.balance_cents)} className={INPUT_CLS} />
            </div>
            <div className="sm:col-span-3">
              <label htmlFor="pmt-date" className={LABEL_CLS}>Paid on</label>
              <input id="pmt-date" name="paid_at" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={INPUT_CLS} />
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
          <p className="mt-2 text-[12px] text-emerald-700 font-medium">✓ Fully paid.</p>
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
        className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 group/details"
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
                : "Due date, payment terms, PO#, tax %, customer message, internal notes."}
            </p>
          </div>
          <span className="text-[11px] font-semibold text-blue-700 group-open/details:hidden">Edit</span>
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
          {/* Row 1 — 4 short fields side-by-side on md+, 2 per row on sm,
              stacked on mobile. Due-date presets keep the taller footprint
              but fit within the same 4-col track. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label htmlFor="dt-due" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">Due date</label>
              <DueDatePickerWithPresets
                id="dt-due"
                name="due_at"
                defaultValue={invoice.due_at ? invoice.due_at.slice(0, 10) : ""}
                disabled={isVoid}
              />
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
              <input id="dt-tax" name="tax_pct" type="number" step="0.001" min="0" max="100" defaultValue={invoice.tax_pct} disabled={!isDraft} className={INPUT_CLS} />
            </div>
            <div>
              <label htmlFor="dt-po" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">PO number</label>
              <input id="dt-po" name="po_number" type="text" maxLength={80} defaultValue={invoice.po_number ?? ""} disabled={isVoid} className={INPUT_CLS} />
            </div>
          </div>
          {/* Row 2 — full-width text areas, 2-col grid on md+ so message
              and internal notes sit side-by-side without wrapping. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="dt-msg" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">Message to customer</label>
              <textarea id="dt-msg" name="customer_message" rows={2} maxLength={1000} defaultValue={invoice.customer_message ?? ""} disabled={isVoid} placeholder="Optional — appears above line items on the customer's copy." className={TEXTAREA_CLS} />
            </div>
            <div>
              <label htmlFor="dt-notes" className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">Internal notes</label>
              <textarea id="dt-notes" name="notes" rows={2} maxLength={2000} defaultValue={invoice.notes ?? ""} disabled={isVoid} placeholder="Never on the customer copy." className={TEXTAREA_CLS} />
            </div>
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

      {/* Status history */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
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

function BigNumber({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "cc-brand" | "blue" | "rose" | "neutral" }) {
  const stripe = tone === "cc-brand" ? "bg-cc-brand-600" : tone === "blue" ? "bg-blue-500" : tone === "rose" ? "bg-rose-500" : "bg-ppp-charcoal-200";
  const valueCls = tone === "rose" ? "text-rose-700" : tone === "cc-brand" ? "text-cc-brand-700" : "text-ppp-charcoal";
  return (
    <div className="relative border border-ppp-charcoal-100 rounded-lg px-4 py-3 overflow-hidden bg-gradient-to-br from-white to-ppp-charcoal-50/40">
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
        {label}
      </div>
      <div className={`text-xl sm:text-2xl font-bold mt-1 tabular-nums ${valueCls}`}>
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
      ? "bg-blue-100 text-blue-800 border-blue-300"
      : status === "partial"
      ? "bg-amber-100 text-amber-900 border-amber-300"
      : "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border ${cls}`}>
      {invoiceStatusLabel(status)}
    </span>
  );
}
