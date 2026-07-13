/**
 * `/commercial/invoices` — Phase 3 invoicing list page.
 *
 * Same design language as accounts + opportunities lists:
 *   - PageHeader hero with red accent bar
 *   - 4-tile KPI strip (Outstanding · Overdue · Paid this month · Draft)
 *   - Unified toolbar (search + status filter popover + sort)
 *   - Clean row hierarchy
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { listCommercialInvoices, addPayment, getInvoiceContext, createCommercialInvoice, type CommercialInvoice } from "@/lib/commercial/invoices/db";
import { listCommercialAccounts, getCommercialAccount, getCommercialAccountIncludingDeleted } from "@/lib/commercial/accounts/db";
import { listCommercialOpportunities, derivedOppName, type CommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  invoiceStatusLabel,
  deriveInvoiceStatus,
  PAYMENT_METHODS,
  INVOICE_STATUSES,
  type InvoiceStatus,
} from "@/lib/commercial/invoices/constants";
import { formatCentsCompact, formatCentsFull, fmtEtDate, daysBetween, parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { pickFirst } from "@/lib/commercial/form-utils";
import { AccountAvatar } from "@/components/commercial/account-avatar";
import { listProducts } from "@/lib/commercial/products/db";
import ProductPicker from "@/components/commercial/product-picker";

export const dynamic = "force-dynamic";

type SP = Promise<{
  q?: string;
  status?: string;
  sort?: string;
  account_id?: string;
  deleted?: string;
  view?: string;
  /** Set by /commercial/invoices/new when a multi-row batch lands here. */
  invoices_created?: string;
  invoice_errors?: string;
  status_error?: string;
  /** Set by recordInvoicePaymentFromListAction after a successful payment. */
  paid_ok?: string;
  paid_invoice?: string;
  paid_capped?: string;
  error?: string;
  /** Set by createInvoiceInlineAction with the new invoice id (for flash + scroll). */
  created?: string;
  /** Set by /commercial/invoices/new?opp=<id> redirect shim — auto-opens
   *  the inline "+ New invoice" collapsible for the matching opp so
   *  users landing here from the "New invoice ▾" picker see the form
   *  already expanded (details elements don't respond to URL hashes). */
  add?: string;
  /** Karan 2026-07-08: single-deal focus + bulk-delete flash. */
  opportunity_id?: string;
  bulk_deleted?: string;
}>;

/** Server action for the inline "+ Record payment" collapsible on the
 *  account-filtered detail view (Karan 2026-07-07: user wants to do
 *  everything from this page — no jumping to opp detail). Mirrors the
 *  opp-panel version but redirects back to the invoice list preserving
 *  the account_id filter. */
async function recordInvoicePaymentFromListAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(invoice_id) || !UUID_RE.test(account_id)) {
    redirect("/commercial/invoices");
  }
  const amount_cents = parseDollarsToCents(String(formData.get("amount") ?? ""));
  if (amount_cents === null || amount_cents <= 0) {
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent("Enter a positive dollar amount (e.g., 250.00).")}`);
  }
  const paid_at_raw = String(formData.get("paid_at") ?? "").trim();
  const paid_at = paid_at_raw
    ? /^\d{4}-\d{2}-\d{2}$/.test(paid_at_raw)
      ? `${paid_at_raw}T16:00:00.000Z`
      : new Date(paid_at_raw).toISOString()
    : undefined;
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const result = await addPayment(invoice_id, {
    amount_cents: amount_cents!,
    paid_at,
    method,
    reference,
    notes,
    recorded_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent(result.error ?? "Payment failed.")}`);
  }
  const ctx = await getInvoiceContext(invoice_id);
  if (ctx.opportunity_id) revalidatePath(`/commercial/opportunities/${ctx.opportunity_id}`);
  revalidatePath(`/commercial/invoices/${invoice_id}`);
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  if (ctx.account_id) revalidatePath(`/commercial/accounts/${ctx.account_id}`);

  const flash = new URLSearchParams({
    account_id,
    paid_ok: "1",
    paid_invoice: invoice_id,
  });
  if (result.capped) flash.set("paid_capped", "1");
  redirect(`/commercial/invoices?${flash.toString()}#inv-${invoice_id}`);
}

/** Server action for the inline "+ New invoice" collapsible on the
 *  account-filtered detail view (Karan 2026-07-07: retired the batch
 *  creator page — everything happens inline on this one page). Creates
 *  a single invoice with a single line item, then redirects back to
 *  the same page with an anchor to the new invoice. */
async function createInvoiceInlineAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(opp_id)) {
    redirect("/commercial/invoices");
  }
  const description = String(formData.get("description") ?? "").trim();
  if (!description) {
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent("Enter a description for what this charge is for.")}`);
  }
  const amount_cents = parseDollarsToCents(String(formData.get("amount") ?? ""));
  if (amount_cents === null || amount_cents <= 0) {
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent("Enter a valid amount.")}`);
  }
  const due_at_raw = String(formData.get("due_at") ?? "").trim();
  const due_at = due_at_raw && /^\d{4}-\d{2}-\d{2}$/.test(due_at_raw)
    ? `${due_at_raw}T16:00:00.000Z`
    : undefined;
  const po_number = String(formData.get("po_number") ?? "").trim() || undefined;
  const payment_terms = String(formData.get("payment_terms") ?? "").trim() || undefined;
  const customer_message = String(formData.get("customer_message") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const tax_pct_raw = String(formData.get("tax_pct") ?? "").trim();
  const tax_pct_parsed = tax_pct_raw !== "" ? parseFloat(tax_pct_raw) : NaN;
  const tax_pct = Number.isFinite(tax_pct_parsed) && tax_pct_parsed >= 0 && tax_pct_parsed <= 100
    ? tax_pct_parsed
    : undefined;

  const result = await createCommercialInvoice({
    opportunity_id: opp_id,
    account_id,
    created_by_user_id: user.id,
    po_number,
    payment_terms,
    customer_message,
    notes,
    tax_pct,
    due_at,
    line_items: [{
      description: description.slice(0, 500),
      quantity: 1,
      unit_price_cents: amount_cents!,
      // Phase D: optional catalog FK — set when the user picked from
      // ProductPicker. Enables SKU-grouped margin reports later without
      // rewriting historical unit_price_cents.
      product_id: UUID_RE.test(String(formData.get("product_id") ?? "")) ? String(formData.get("product_id")) : null,
    }],
  });
  if (!result.ok) {
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent(`Couldn't create invoice: ${result.error}`)}`);
  }

  revalidatePath(`/commercial/opportunities/${opp_id}`);
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");

  redirect(`/commercial/invoices?account_id=${account_id}&created=${result.invoice.id}#inv-${result.invoice.id}`);
}

/**
 * Karan 2026-07-08: bulk-delete every invoice attached to a specific
 * (deleted) deal. Two-step confirm: the button renders a form with a
 * hidden `confirm` field the user must click a second time. Safety
 * checks:
 *   - Refuse if any invoice has paid_cents > 0 (money already changed
 *     hands; the user has to void those individually first — matches
 *     the deal soft-delete cascade guard shipped earlier today)
 *   - Only allowed when the parent opportunity is soft-deleted (this
 *     is a reconcile-orphan flow, not a general purge)
 */
async function bulkDeleteInvoicesForOppAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/invoices");
  const confirmed = formData.get("confirm") === "yes";
  if (!confirmed) {
    redirect(`/commercial/invoices?opportunity_id=${opp_id}&error=${encodeURIComponent("Confirm required to bulk-delete.")}`);
  }
  const { commercialDb } = await import("@/lib/commercial/db");
  const sb = commercialDb();
  // Guard 1: parent must be deleted (this is an orphan-cleanup flow).
  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("id, deleted_at")
    .eq("id", opp_id)
    .maybeSingle();
  if (!oppRow) redirect("/commercial/invoices");
  // Karan 2026-07-09: relaxed the "deleted parent only" guard. Active
  // Won deals need bulk-clear too (test data cleanup, duplicate imports,
  // etc). Auto-void logic below preserves payment history for any paid
  // rows so the audit trail stays intact even on an active deal.
  // Guard 2: block if any invoice has recorded payments.
  const { data: invRows } = await sb
    .from("commercial_invoices")
    .select("id, status, paid_cents")
    .eq("opportunity_id", opp_id)
    .is("deleted_at", null);
  const rows = (invRows ?? []) as { id: string; status: string; paid_cents: number }[];
  // Karan 2026-07-08 revised policy: on a DELETED parent the operator is
  // clearly cleaning up orphaned rows — refusing to wipe because one
  // invoice had a payment leaves the user stuck. Auto-void any non-void
  // paid invoices first so the audit trail records the payments
  // (paid_cents + payments log stay intact) then soft-delete everything.
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
  }
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  // Karan 2026-07-09: preserve the caller's scope so the flash lands on
  // the same filtered view instead of dumping the user on the unfiltered
  // list.
  const returnAccountId = String(formData.get("return_account_id") ?? "");
  if (UUID_RE.test(returnAccountId)) {
    redirect(`/commercial/invoices?account_id=${returnAccountId}&bulk_deleted=${rows.length}`);
  }
  redirect(`/commercial/invoices?bulk_deleted=${rows.length}`);
}

/**
 * Karan 2026-07-08: bulk-delete every invoice attached to a specific
 * (deleted) account. Mirrors the per-opp variant but scopes on account_id.
 * Same safety envelope: parent account must be soft-deleted; auto-voids
 * any paid non-void invoices before wiping so the operator isn't stuck
 * on orphan cleanup.
 */
async function bulkDeleteInvoicesForAccountAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/invoices");
  const confirmed = formData.get("confirm") === "yes";
  if (!confirmed) {
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent("Confirm required to bulk-delete.")}`);
  }
  const { commercialDb } = await import("@/lib/commercial/db");
  const sb = commercialDb();
  const { data: acctRow } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", account_id)
    .maybeSingle();
  if (!acctRow) redirect("/commercial/invoices");
  if (!(acctRow as { deleted_at: string | null }).deleted_at) {
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent("Bulk delete only allowed on deleted accounts — void or delete individual invoices instead.")}`);
  }
  const { data: invRows } = await sb
    .from("commercial_invoices")
    .select("id, status, paid_cents")
    .eq("account_id", account_id)
    .is("deleted_at", null);
  const rows = (invRows ?? []) as { id: string; status: string; paid_cents: number }[];
  // Auto-void paid non-void invoices then wipe. Same rationale as the
  // per-opp variant: on a deleted parent, refusing to wipe because one
  // invoice took a payment leaves the operator stuck. Voiding first
  // preserves the audit trail (paid_cents + payments log stay intact).
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
  }
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  redirect(`/commercial/invoices?bulk_deleted=${rows.length}`);
}

export default async function CommercialInvoicesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const search = pickFirst(sp.q);
  const statusRaw = pickFirst(sp.status);
  const statusFilter = statusRaw && (INVOICE_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as InvoiceStatus)
    : statusRaw === "overdue"
    ? ("overdue" as InvoiceStatus)
    : undefined;
  const sortKey = pickFirst(sp.sort) ?? "recent";
  // Karan 2026-07-07: grouped-by-opp is the ONLY view now. The old flat
  // list toggle is retired — it made the "which invoices belong to what
  // deal" question much harder to answer at a glance and clashed with
  // the new master progress bar per opp. Any legacy ?view=list URL
  // params silently fall through to grouped (no redirect needed since
  // there was no meaningful behavior loss).
  const accountIdRaw = pickFirst(sp.account_id);
  const accountIdFilter = accountIdRaw && UUID_RE.test(accountIdRaw) ? accountIdRaw : undefined;
  // Karan 2026-07-08: single-deal focus. Clicking the deleted-deal
  // header on the compact list drops you here with ?opportunity_id=<id>
  // so all N invoices for that (possibly deleted) deal render on the
  // invoicing surface — not the pipeline detail page.
  const opportunityIdRaw = pickFirst(sp.opportunity_id);
  const opportunityIdFilter = opportunityIdRaw && UUID_RE.test(opportunityIdRaw) ? opportunityIdRaw : undefined;
  const deletedFlash = pickFirst(sp.deleted) === "1";
  const invoicesCreatedFlash = Number(pickFirst(sp.invoices_created) ?? 0);
  const invoiceErrorsFlash = Number(pickFirst(sp.invoice_errors) ?? 0);
  const statusErrorFlash = pickFirst(sp.status_error);

  // Karan 2026-07-07: search now matches invoice_number OR opp title.
  // The DB layer only does invoice_number ilike, so we fetch without a
  // search filter and post-filter here using the loaded oppById map.
  // At current volumes (< 5K invoices per workspace) this is fast enough
  // to be worth the simplicity. If we hit scale we swap in an RPC that
  // joins commercial_invoices to commercial_opportunities server-side.
  const [invoicesRaw, accounts, accountFilter, allOpps, products] = await Promise.all([
    listCommercialInvoices({ status: statusFilter, accountId: accountIdFilter, opportunityId: opportunityIdFilter }),
    listCommercialAccounts(),
    // Include-deleted so a deleted-account invoice cluster can render
    // its name + drive the bulk-delete flow (getCommercialAccount
    // filters deleted rows and would return null here).
    accountIdFilter ? getCommercialAccountIncludingDeleted(accountIdFilter) : Promise.resolve(null),
    listCommercialOpportunities({}),
    listProducts(),
  ]);
  // Phase D: hand the picker a lean shape so we're not shipping the
  // full CommercialProduct rows (audit cols, notes, cost) to the client.
  const pickableProducts = products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    unit: p.unit,
    default_unit_price_cents: p.default_unit_price_cents,
  }));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const oppById = new Map(allOpps.map((o) => [o.id, o]));
  const invoices = search
    ? (() => {
        const q = search.toLowerCase();
        return invoicesRaw.filter((inv) => {
          if (inv.invoice_number.toLowerCase().includes(q)) return true;
          const opp = oppById.get(inv.opportunity_id);
          if (opp && opp.title.toLowerCase().includes(q)) return true;
          return false;
        });
      })()
    : invoicesRaw;
  // Only Won opps can be invoiced; sort newest first so the picker shows
  // the most recent wins on top (Karan's typical flow after a Win/Loss
  // Debrief lands).
  // Karan 2026-07-09: when filtered by account, the picker scopes to that
  // account's Won deals — otherwise Bob's filtered view showed every
  // Won deal from every customer, and clicking one would jump away from
  // Bob's filter context entirely.
  const wonOppsAll = allOpps
    .filter((o) => o.status === "won")
    .sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at));
  const wonOpps = accountIdFilter
    ? wonOppsAll.filter((o) => o.account_id === accountIdFilter)
    : wonOppsAll;

  // Apply sort.
  const sorted = [...invoices].sort((a, b) => {
    if (sortKey === "oldest") return a.created_at.localeCompare(b.created_at);
    if (sortKey === "due_soon") {
      const av = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bv = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return av - bv;
    }
    if (sortKey === "amount_high") return b.total_cents - a.total_cents;
    if (sortKey === "balance_high") return b.balance_cents - a.balance_cents;
    return b.created_at.localeCompare(a.created_at);
  });

  // KPI strip. Scoped by account when the list is filtered so the KPIs
  // match the visible rows; otherwise reflects the whole book. Refetches
  // when no other filters are active so the numbers aren't skewed by
  // search/status pills.
  const kpiSource = accountIdFilter
    ? await listCommercialInvoices({ accountId: accountIdFilter })
    : await listCommercialInvoices();
  // "Paid this month" uses an America/New_York month boundary so a
  // payment recorded at 11pm ET on the 1st doesn't count as previous
  // month for viewers in earlier UTC. All commercial ops live in ET.
  // We resolve the offset (EST -05:00 vs EDT -04:00) dynamically via
  // Intl so DST transitions can't skew the boundary by an hour.
  const now = new Date();
  const nowEtParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const etYear = nowEtParts.find((p) => p.type === "year")?.value ?? "1970";
  const etMonth = nowEtParts.find((p) => p.type === "month")?.value ?? "01";
  const offsetToken = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const monthStartEtIso = `${etYear}-${etMonth}-01T00:00:00${offsetToken.replace("GMT", "")}`;
  // Karan 2026-07-07: include drafts in Outstanding so it stays
  // consistent with the opp panel + Account 360 tiles ("all the money
  // that could be owed once these invoices are sent"). Void is still
  // excluded (a voided invoice will never be paid).
  const outstandingCents = kpiSource
    .filter((i) => i.status !== "void")
    .reduce((acc, i) => acc + i.balance_cents, 0);
  const overdueCount = kpiSource.filter((i) => deriveInvoiceStatus(i) === "overdue").length;
  // AR aging buckets (Karan 2026-07-07 Alex-love feature). GCs prioritize
  // collection effort by which invoices are furthest past due. Only compute
  // when there's overdue balance; otherwise we skip rendering the strip.
  const nowMs = Date.now();
  const overdueRows = kpiSource.filter((i) => deriveInvoiceStatus(i) === "overdue" && i.due_at);
  const agingBuckets = overdueRows.reduce(
    (acc, i) => {
      const days = Math.floor((nowMs - new Date(i.due_at as string).getTime()) / 86_400_000);
      if (days <= 30) {
        acc.b0_30_cents += i.balance_cents;
        acc.b0_30_count += 1;
      } else if (days <= 60) {
        acc.b30_60_cents += i.balance_cents;
        acc.b30_60_count += 1;
      } else {
        acc.b60_plus_cents += i.balance_cents;
        acc.b60_plus_count += 1;
      }
      return acc;
    },
    { b0_30_cents: 0, b0_30_count: 0, b30_60_cents: 0, b30_60_count: 0, b60_plus_cents: 0, b60_plus_count: 0 }
  );
  const hasAging = agingBuckets.b0_30_cents + agingBuckets.b30_60_cents + agingBuckets.b60_plus_cents > 0;
  const paidThisMonthCents = kpiSource
    .filter((i) => i.paid_at && i.paid_at >= monthStartEtIso)
    .reduce((acc, i) => acc + i.paid_cents, 0);
  const draftCount = kpiSource.filter((i) => i.status === "draft").length;

  const anyFilterActive = !!search || !!statusFilter || sortKey !== "recent" || !!accountIdFilter;

  const SORT_OPTIONS = [
    { key: "recent", label: "Most recently created" },
    { key: "oldest", label: "Oldest first" },
    { key: "due_soon", label: "Due soonest" },
    { key: "amount_high", label: "Highest amount" },
    { key: "balance_high", label: "Highest balance" },
  ] as const;
  const currentSortLabel = SORT_OPTIONS.find((s) => s.key === sortKey)?.label ?? "Most recently created";

  const setSortHref = (newSort: string): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (statusFilter) p.set("status", statusFilter);
    if (newSort !== "recent") p.set("sort", newSort);
    if (accountIdFilter) p.set("account_id", accountIdFilter);
    return p.toString() ? `/commercial/invoices?${p.toString()}` : "/commercial/invoices";
  };
  const setStatusHref = (newStatus: InvoiceStatus | null): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (newStatus) p.set("status", newStatus);
    if (sortKey !== "recent") p.set("sort", sortKey);
    if (accountIdFilter) p.set("account_id", accountIdFilter);
    return p.toString() ? `/commercial/invoices?${p.toString()}` : "/commercial/invoices";
  };

  // Karan 2026-07-08: focus banner. When ?opportunity_id OR ?account_id
  // narrows the list, show a strip with back-to-all-invoices (LEFT) +
  // title + a "Delete all N" button on the right when the parent is
  // deleted (orphan cleanup flow). The two variants share layout.
  const scopedInvoices = opportunityIdFilter
    ? invoicesRaw.filter((i) => i.opportunity_id === opportunityIdFilter)
    : accountIdFilter
    ? invoicesRaw.filter((i) => i.account_id === accountIdFilter)
    : [];
  const scopedInvoiceCount = scopedInvoices.length;
  const scopedPaidCount = scopedInvoices.filter((i) => (i.paid_cents ?? 0) > 0 && i.status !== "void").length;
  const scopedIsOrphan = opportunityIdFilter && !oppById.has(opportunityIdFilter);
  const scopedAccountIsDeleted = !!(accountIdFilter && accountFilter?.deleted_at);
  // Show the focus banner when either filter narrows the list.
  const showFocusBanner = !!opportunityIdFilter || !!accountIdFilter;
  // Karan 2026-07-08: relaxed the payment-block. On a DELETED parent
  // the operator is cleaning up orphan rows — refusing to wipe because
  // one had a payment leaves them stuck. Server action auto-voids paid
  // non-void invoices first so the audit trail is preserved.
  const showDeleteAll = !!(scopedIsOrphan || scopedAccountIsDeleted) && scopedInvoiceCount > 0;
  // Copy varies by scope + deletion state.
  const focusTitle = scopedIsOrphan
    ? "Deleted deal — invoices still on file"
    : scopedAccountIsDeleted
    ? "Deleted account — invoices still on file"
    : opportunityIdFilter
    ? "Focused on a single deal"
    : accountFilter
    ? `Focused on ${accountFilter.company_name}`
    : "Focused view";
  // The delete-all form talks to a different server action + hidden
  // field per scope. Compute it once so the JSX stays flat.
  const deleteAllForm = scopedIsOrphan && opportunityIdFilter
    ? { action: bulkDeleteInvoicesForOppAction, key: "opp_id", value: opportunityIdFilter }
    : scopedAccountIsDeleted && accountIdFilter
    ? { action: bulkDeleteInvoicesForAccountAction, key: "account_id", value: accountIdFilter }
    : null;
  // NaN-safe: malformed ?bulk_deleted=abc would render "NaN invoices deleted."
  const bulkDeletedParsed = Number(pickFirst(sp.bulk_deleted) ?? 0);
  const bulkDeletedFlash = Number.isFinite(bulkDeletedParsed) && bulkDeletedParsed > 0 ? bulkDeletedParsed : 0;
  const errorFlash = pickFirst(sp.error);

  return (
    <div className="space-y-5">
      {deletedFlash && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-3 text-sm text-cc-brand-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Invoice deleted.</span>
        </div>
      )}
      {bulkDeletedFlash > 0 && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-3 text-sm text-cc-brand-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span><strong>{bulkDeletedFlash}</strong> invoice{bulkDeletedFlash === 1 ? "" : "s"} deleted.</span>
        </div>
      )}
      {showFocusBanner && errorFlash && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800 flex items-start gap-2">
          <span aria-hidden>!</span>
          <span>{errorFlash}</span>
        </div>
      )}
      {showFocusBanner && (
        <div className="bg-white border-l-4 border-amber-400 border-y border-r border-y-ppp-charcoal-100 border-r-ppp-charcoal-100 rounded-xl px-3 sm:px-4 py-3 flex items-center gap-3 flex-wrap">
          {/* Back arrow — LEFT side per Karan's ask */}
          <Link
            href="/commercial/invoices"
            aria-label="Back to all invoices"
            className="inline-flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-md text-ppp-charcoal-600 hover:text-ppp-charcoal hover:bg-ppp-charcoal-100 touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40 shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>
          {(scopedIsOrphan || scopedAccountIsDeleted) && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-amber-600 shrink-0">
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-[13.5px] font-bold text-ppp-charcoal truncate">
                {focusTitle}
              </div>
              <span className="text-[10px] font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-100 rounded px-1.5 py-0.5 shrink-0">
                {scopedInvoiceCount} invoice{scopedInvoiceCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-0.5 text-[11.5px] text-ppp-charcoal-500 leading-snug">
              Showing only invoices for this {opportunityIdFilter ? "opportunity" : "account"}. Click a row to open — Void or Delete lives inside.
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {showDeleteAll && deleteAllForm && (
              <details className="relative">
                <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-600 text-white text-[12px] font-semibold hover:bg-rose-700 min-h-[36px] touch-manipulation shadow-sm shadow-rose-600/25">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                  Delete all {scopedInvoiceCount}
                </summary>
                <div className="absolute right-0 top-full mt-1.5 w-[calc(100vw-2rem)] max-w-xs sm:w-72 bg-white border border-rose-200 rounded-lg shadow-lg p-3 z-10">
                  <div className="text-[12px] text-ppp-charcoal-700 mb-2 leading-snug">
                    Permanently hide all <strong>{scopedInvoiceCount}</strong> invoice{scopedInvoiceCount === 1 ? "" : "s"} from lists.
                    {scopedPaidCount > 0 && (
                      <> {scopedPaidCount} paid invoice{scopedPaidCount === 1 ? "" : "s"} will auto-void first — payment history stays in the audit log.</>
                    )}
                    {" "}Data stays in the DB for audit history.
                  </div>
                  <form action={deleteAllForm.action}>
                    <input type="hidden" name={deleteAllForm.key} value={deleteAllForm.value} />
                    <input type="hidden" name="confirm" value="yes" />
                    <button
                      type="submit"
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-rose-600 text-white text-[12px] font-semibold hover:bg-rose-700 min-h-[36px] touch-manipulation"
                    >
                      Yes, delete all {scopedInvoiceCount}
                    </button>
                  </form>
                </div>
              </details>
            )}
          </div>
        </div>
      )}
      {invoicesCreatedFlash > 0 && (
        <div className={`rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3 ${
          invoiceErrorsFlash > 0
            ? "bg-amber-50 border border-amber-200 text-amber-900"
            : "bg-cc-brand-50 border border-cc-brand-200 text-cc-brand-800"
        }`}>
          <span>
            <strong>{invoicesCreatedFlash}</strong> invoice{invoicesCreatedFlash === 1 ? "" : "s"} created.
            {invoiceErrorsFlash > 0 && (
              <> {invoiceErrorsFlash} row{invoiceErrorsFlash === 1 ? "" : "s"} skipped due to input errors.</>
            )}
            {" Shown grouped by deal below."}
          </span>
          <Link
            href="/commercial/invoices"
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {statusErrorFlash && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800">
          {statusErrorFlash}
        </div>
      )}
      {accountFilter && (
        // Karan 2026-07-07 bug fix: the account company_name used to be
        // a <Link> pointing at /commercial/accounts/<id>. Users scanning
        // the banner clicked it and got teleported OUT of the invoicing
        // context (Karan's "why did I land on the accounts page?"
        // report). The banner's job is to explain the filter — nothing
        // more. Company name is now plain bold text. The "Show all
        // invoices" chip stays as the only escape. A separate low-key
        // "Open account" chip on the right gives users the option to
        // navigate but requires an explicit click (labeled, not
        // ambient) so nobody misclicks into the wrong context.
        <div className="bg-white border border-cc-brand-200 rounded-xl px-4 py-3 text-sm text-ppp-charcoal-700 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 rounded px-1.5 py-0.5">
              Filtered
            </span>
            <span>
              Showing invoices for{" "}
              <strong className="font-semibold text-ppp-charcoal">
                {accountFilter.company_name}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/commercial/accounts/${accountFilter.id}`}
              className="text-[12px] font-medium text-ppp-charcoal-600 hover:text-cc-brand-700 hover:underline inline-flex items-center gap-1 min-h-[36px] px-2 touch-manipulation"
              title="Open the account detail page in a new context"
            >
              Open account
            </Link>
            <Link
              href="/commercial/invoices"
              className="text-[12px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 inline-flex items-center gap-1 min-h-[44px] px-3 touch-manipulation"
            >
              Show all invoices
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      )}
      {/* Hero */}
      <header className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
              Invoices
            </h1>
            <p className="mt-1 text-sm text-ppp-charcoal-500">
              Bill for Won deals. Track sent · viewed · paid · overdue.
            </p>
          </div>
          {/* New invoice CTA. Karan 2026-07-09: when the target opp is
              unambiguous (a deal-scoped view OR an account view with
              exactly one Won deal), the button skips the picker and
              scrolls straight to the inline "+ New invoice for this
              deal" form — no more "pick Deal 1 from a picker of one". */}
          {(() => {
            const singleOppTarget =
              opportunityIdFilter && wonOpps.some((o) => o.id === opportunityIdFilter)
                ? opportunityIdFilter
                : accountIdFilter && wonOpps.length === 1
                ? wonOpps[0].id
                : null;
            if (singleOppTarget) {
              const targetOpp = wonOpps.find((o) => o.id === singleOppTarget);
              const targetAccount = targetOpp ? targetOpp.account_id : accountIdFilter;
              return (
                <Link
                  href={`/commercial/invoices?account_id=${targetAccount}&add=${singleOppTarget}#opp-${singleOppTarget}`}
                  className="sm:self-end inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 5v14 M5 12h14" />
                  </svg>
                  New invoice
                </Link>
              );
            }
            return null;
          })()}
          {/* Picker path — only when there's actually a choice to make. */}
          {!(
            (opportunityIdFilter && wonOpps.some((o) => o.id === opportunityIdFilter)) ||
            (accountIdFilter && wonOpps.length === 1)
          ) && (
          <details className="relative sm:self-end group">
            <summary
              className="list-none cursor-pointer inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New invoice
              <span aria-hidden className="text-white/80 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="absolute right-0 mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-3 min-w-[300px] max-w-[calc(100vw-1rem)]">
              <div className="text-[12px] font-semibold text-ppp-charcoal-700 px-1 pb-2">
                {accountIdFilter
                  ? `Pick a Won deal for ${accountFilter?.company_name ?? "this customer"} to bill`
                  : "Pick a Won deal to bill"}
              </div>
              {wonOpps.length === 0 ? (
                <div className="px-2 py-3 text-[12.5px] text-ppp-charcoal-600 space-y-2">
                  {accountIdFilter ? (
                    <>
                      <div>
                        {accountFilter?.company_name ?? "This customer"} has no Won deals yet. Invoices attach to a deal that's been marked <strong>Won</strong>.
                      </div>
                      <Link
                        href={`/commercial/accounts/${accountIdFilter}?tab=deals`}
                        className="inline-flex items-center gap-1 text-cc-brand-700 font-semibold hover:underline"
                      >
                        Open {accountFilter?.company_name ?? "this customer"}'s deals →
                      </Link>
                    </>
                  ) : (
                    <>
                      <div>No Won deals yet — an invoice needs a Won deal to attach to.</div>
                      <Link href="/commercial/opportunities" className="inline-flex items-center gap-1 text-cc-brand-700 font-semibold hover:underline">
                        Go to pipeline →
                      </Link>
                    </>
                  )}
                </div>
              ) : (
                <div className="max-h-[360px] overflow-y-auto">
                  {/* Karan 2026-07-09: group by customer so multiple deals
                      under the same account read as one bucket. Renders
                      "Bob" as a section header with Deal 1 / Deal 2
                      indented underneath instead of two flat rows both
                      subtitled with the customer's name. */}
                  {(() => {
                    const byAcct = new Map<string, typeof wonOpps>();
                    for (const o of wonOpps) {
                      const arr = byAcct.get(o.account_id) ?? [];
                      arr.push(o);
                      byAcct.set(o.account_id, arr);
                    }
                    // Preserve the newest-first sort by keying group
                    // order to the first opp's index in wonOpps.
                    const groupOrder = Array.from(byAcct.entries()).sort((a, b) => {
                      const ai = wonOpps.findIndex((o) => o.account_id === a[0]);
                      const bi = wonOpps.findIndex((o) => o.account_id === b[0]);
                      return ai - bi;
                    });
                    return groupOrder.map(([accountId, deals]) => {
                      const acct = accountById.get(accountId);
                      return (
                        <div key={accountId} className="pb-1.5">
                          <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                            {acct?.company_name ?? "—"}
                          </div>
                          <div className="space-y-0.5">
                            {deals.map((o) => {
                              const existing = invoicesRaw.filter((i) => i.opportunity_id === o.id).length;
                              return (
                                <Link
                                  key={o.id}
                                  href={`/commercial/invoices/new?opp=${o.id}`}
                                  className="flex items-start justify-between gap-3 pl-5 pr-3 py-2 rounded-lg hover:bg-cc-brand-50 min-h-[40px] touch-manipulation"
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[13px] font-semibold text-ppp-charcoal truncate">
                                      {o.title}
                                    </div>
                                    {existing > 0 && (
                                      <div className="text-[10.5px] text-ppp-charcoal-500 mt-0.5">
                                        {existing} invoice{existing === 1 ? "" : "s"} already
                                      </div>
                                    )}
                                  </div>
                                  <span aria-hidden className="text-cc-brand-600 shrink-0 mt-1">→</span>
                                </Link>
                              );
                            })}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
              <div className="mt-2 pt-2 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500 px-1">
                Multiple invoices per deal are allowed (progress billing).
              </div>
            </div>
          </details>
          )}
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            tone="cc-brand"
            label="Outstanding"
            value={formatCentsCompact(outstandingCents)}
            sub={outstandingCents === 0 ? "no unpaid invoices" : "unpaid balance across the book"}
          />
          <KpiCard
            tone={overdueCount > 0 ? "rose" : "neutral"}
            label="Overdue"
            value={overdueCount.toLocaleString()}
            sub={overdueCount === 0 ? "nothing past due" : overdueCount === 1 ? "invoice past due" : "invoices past due"}
          />
          <KpiCard
            tone="blue"
            label="Paid this month"
            value={formatCentsCompact(paidThisMonthCents)}
            sub={paidThisMonthCents === 0 ? "no payments yet" : "collected in the current month"}
          />
          <KpiCard
            tone="neutral"
            label="Drafts"
            value={draftCount.toLocaleString()}
            sub={draftCount === 0 ? "no unsent drafts" : "waiting to be sent"}
          />
        </div>

        {/* AR aging breakdown — only renders when there IS overdue balance
            so the invoice list stays quiet in the happy case. Each bucket
            is a link into the filtered overdue list (status=overdue drills
            all three; Alex still gets aging visibility on that page via
            due date column). Colors escalate: amber → rose → deep-rose. */}
        {hasAging && (
          <div className="grid grid-cols-3 gap-2 mt-3">
            <AgingTile
              label="0–30 days overdue"
              count={agingBuckets.b0_30_count}
              cents={agingBuckets.b0_30_cents}
              tone="amber"
            />
            <AgingTile
              label="30–60 days overdue"
              count={agingBuckets.b30_60_count}
              cents={agingBuckets.b30_60_cents}
              tone="rose"
            />
            <AgingTile
              label="60+ days overdue"
              count={agingBuckets.b60_plus_count}
              cents={agingBuckets.b60_plus_cents}
              tone="rose-deep"
            />
          </div>
        )}
      </header>

      {/* Toolbar */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 space-y-3">
        <form className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 pointer-events-none"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={search ?? ""}
              placeholder="Search by invoice # or opportunity title…"
              className="w-full pl-10 pr-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]"
            />
          </div>
          {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
          {sortKey !== "recent" && <input type="hidden" name="sort" value={sortKey} />}
          {accountIdFilter && <input type="hidden" name="account_id" value={accountIdFilter} />}

          {/* Status pills */}
          <div className="hidden sm:inline-flex rounded-lg border border-ppp-charcoal-200 bg-white overflow-hidden shrink-0">
            {[null, "sent" as InvoiceStatus, "overdue" as InvoiceStatus, "paid" as InvoiceStatus].map((s) => {
              const active = statusFilter === s || (!statusFilter && s === null);
              const label = s === null ? "All" : invoiceStatusLabel(s);
              return (
                <Link
                  key={label}
                  href={setStatusHref(s)}
                  className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center touch-manipulation border-l first:border-l-0 border-ppp-charcoal-200 ${
                    active
                      ? "bg-cc-brand-50 text-cc-brand-700"
                      : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>

          {/* Sort popover */}
          <details className="relative inline-block group">
            <summary
              className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[13px] font-semibold min-h-[44px] touch-manipulation transition-colors focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 ${
                sortKey !== "recent"
                  ? "bg-cc-brand-50 border-cc-brand-200 text-cc-brand-700 hover:bg-cc-brand-100"
                  : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18 M7 12h10 M11 18h2" />
              </svg>
              <span className="hidden sm:inline">Sort:&nbsp;</span>
              <span className="max-w-[140px] truncate">{currentSortLabel}</span>
              <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="absolute right-0 mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-2 min-w-[240px] max-w-[calc(100vw-1rem)]">
              <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 pt-2 pb-1">Sort by</div>
              <div className="space-y-0.5">
                {SORT_OPTIONS.map((o) => {
                  const active = sortKey === o.key;
                  return (
                    <Link
                      key={o.key}
                      href={setSortHref(o.key)}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg min-h-[44px] touch-manipulation transition-colors ${
                        active ? "bg-cc-brand-50 hover:bg-cc-brand-100" : "hover:bg-ppp-charcoal-50"
                      }`}
                    >
                      <span
                        className={`inline-flex items-center justify-center h-4 w-4 rounded-full border shrink-0 ${
                          active ? "border-cc-brand-600" : "border-ppp-charcoal-300"
                        }`}
                        aria-hidden
                      >
                        {active && <span className="block h-2 w-2 rounded-full bg-cc-brand-600" />}
                      </span>
                      <span className={`text-[13px] font-semibold ${active ? "text-cc-brand-800" : "text-ppp-charcoal-700"}`}>
                        {o.label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </details>

          {anyFilterActive && (
            <Link
              href="/commercial/invoices"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-600 text-[12px] font-medium hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6L6 18 M6 6l12 12" />
              </svg>
              Clear
            </Link>
          )}
        </form>
      </div>

      {/* List / empty
          Karan 2026-07-09 restructure: when scoped to an account,
          FullDetailByOpp ALWAYS renders — even with zero invoices — so
          the picker → ?add=<oppId> redirect can prime the inline form
          for a first-time customer bill. Empty state only shows on the
          unfiltered overview. */}
      {accountIdFilter ? (
        <FullDetailByOpp
          invoices={sorted}
          oppById={oppById}
          accountById={accountById}
          sortKey={sortKey}
          accountId={accountIdFilter}
          paidOk={pickFirst(sp.paid_ok) === "1"}
          paidInvoiceId={pickFirst(sp.paid_invoice) ?? null}
          paidCapped={pickFirst(sp.paid_capped) === "1"}
          createdInvoiceId={pickFirst(sp.created) ?? null}
          errorMessage={pickFirst(sp.error) ?? null}
          openAddOppId={pickFirst(sp.add) ?? null}
          wonOppsForAccount={wonOpps}
          pickableProducts={pickableProducts}
        />
      ) : sorted.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 sm:p-12 text-center">
          <div aria-hidden className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div className="text-sm font-semibold text-ppp-charcoal">
            {anyFilterActive ? "No invoices match these filters" : "No invoices yet"}
          </div>
          {anyFilterActive ? (
            <>
              <p className="mt-1 text-sm text-ppp-charcoal-500">
                Try clearing filters or searching by invoice number or deal title.
              </p>
              <Link
                href="/commercial/invoices"
                className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
              >
                Clear all filters
              </Link>
            </>
          ) : wonOpps.length > 0 ? (
            <p className="mt-1 text-sm text-ppp-charcoal-500 max-w-md mx-auto">
              You have {wonOpps.length} Won deal{wonOpps.length === 1 ? "" : "s"} ready to bill. Use <strong className="text-ppp-charcoal-700">New invoice ▾</strong> at the top of this page to pick one.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-ppp-charcoal-500">
                An invoice attaches to a deal marked <strong>Won</strong>. Win a deal first, then come back.
              </p>
              <Link
                href="/commercial/opportunities"
                className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
              >
                Go to pipeline
              </Link>
            </>
          )}
        </div>
      ) : (
        // Grouped-by-opportunity compact list. Each row = one opp; click
        // → jumps into opp detail. This is the overview surface.
        <GroupedByOpp
          invoices={sorted}
          oppById={oppById}
          accountById={accountById}
          sortKey={sortKey}
        />
      )}
    </div>
  );
}

function GroupedByOpp({
  invoices,
  oppById,
  accountById,
  sortKey,
}: {
  invoices: CommercialInvoice[];
  oppById: Map<string, { id: string; title: string; account_id: string; status: string; client_name: string | null; location_short: string | null }>;
  accountById: Map<string, { id: string; company_name: string }>;
  sortKey: string;
}) {
  // Group invoices by opportunity_id. Preserve chronological order per
  // group so the story reads top-down (oldest → newest inside each opp).
  const groups = new Map<string, CommercialInvoice[]>();
  for (const inv of invoices) {
    const arr = groups.get(inv.opportunity_id) ?? [];
    arr.push(inv);
    groups.set(inv.opportunity_id, arr);
  }
  // Karan 2026-07-07 bug fix: previous version always sorted groups by
  // "most-recent invoice created" and ignored the user's sortKey. On
  // the grouped view the sort control was effectively dead. Now the
  // sortKey drives GROUP order, and each group's invoices still render
  // chronologically inside (so the progress-billing story reads
  // top-down per deal).
  const oppOrder = Array.from(groups.entries()).sort((a, b) => {
    const aInvs = a[1];
    const bInvs = b[1];
    switch (sortKey) {
      case "oldest": {
        // Groups whose OLDEST invoice is earliest come first.
        const aOldest = Math.min(...aInvs.map((i) => new Date(i.created_at).getTime()));
        const bOldest = Math.min(...bInvs.map((i) => new Date(i.created_at).getTime()));
        return aOldest - bOldest;
      }
      case "due_soon": {
        // Groups whose EARLIEST unpaid due date is closest come first.
        // Paid/void invoices don't count. Groups with no upcoming due
        // dates sink to the bottom.
        const nextDue = (rows: typeof aInvs) => {
          const dues = rows
            .filter((i) => i.status !== "paid" && i.status !== "void" && i.due_at)
            .map((i) => new Date(i.due_at as string).getTime());
          return dues.length > 0 ? Math.min(...dues) : Infinity;
        };
        return nextDue(aInvs) - nextDue(bInvs);
      }
      case "amount_high": {
        // Groups by total invoiced (non-void), largest first.
        const sum = (rows: typeof aInvs) =>
          rows.filter((i) => i.status !== "void").reduce((s, i) => s + i.total_cents, 0);
        return sum(bInvs) - sum(aInvs);
      }
      case "balance_high": {
        // Groups by total outstanding balance, largest first.
        const bal = (rows: typeof aInvs) =>
          rows.filter((i) => i.status !== "void").reduce((s, i) => s + i.balance_cents, 0);
        return bal(bInvs) - bal(aInvs);
      }
      case "recent":
      default: {
        // Groups whose NEWEST invoice is most recent come first.
        const aLatest = Math.max(...aInvs.map((i) => new Date(i.created_at).getTime()));
        const bLatest = Math.max(...bInvs.map((i) => new Date(i.created_at).getTime()));
        return bLatest - aLatest;
      }
    }
  });

  if (oppOrder.length === 0) {
    return (
      <div className="bg-ppp-charcoal-50/40 border border-ppp-charcoal-100 rounded-xl p-8 text-center">
        <p className="text-[13px] text-ppp-charcoal-600">No invoices to group.</p>
      </div>
    );
  }

  // Karan 2026-07-09: second level of grouping — deals under the same
  // customer bucket together with the customer name as a section
  // header. Encounter-order preserved so the top account is still the
  // one whose highest-ranked deal ranks first by the current sortKey.
  // Orphans (deleted parent deal → no account) get their own section
  // at the bottom.
  type OppRow = [string, CommercialInvoice[]];
  const byAccount = new Map<string, OppRow[]>();
  const orphanRows: OppRow[] = [];
  for (const row of oppOrder) {
    const opp = oppById.get(row[0]);
    if (!opp) {
      orphanRows.push(row);
      continue;
    }
    const arr = byAccount.get(opp.account_id) ?? [];
    arr.push(row);
    byAccount.set(opp.account_id, arr);
  }
  const accountOrder = Array.from(byAccount.entries());

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden shadow-sm">
      {accountOrder.map(([accountId, dealRows], acctIdx) => {
        const acct = accountById.get(accountId);
        return (
          <div key={accountId} className={acctIdx > 0 ? "border-t border-ppp-charcoal-200" : ""}>
            <Link
              href={`/commercial/invoices?account_id=${accountId}`}
              className="group/acct block px-4 sm:px-5 py-2.5 bg-gradient-to-b from-ppp-charcoal-50 to-white border-b border-ppp-charcoal-100 hover:bg-cc-brand-50/40 focus:outline-none focus:bg-cc-brand-50/40 transition-colors touch-manipulation"
              title={`View ${acct?.company_name ?? "this customer"}'s invoices`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[13px] font-bold text-ppp-charcoal group-hover/acct:text-cc-brand-700 truncate">
                  {acct?.company_name ?? "—"}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-ppp-charcoal-500 shrink-0">
                  <span>{dealRows.length} deal{dealRows.length === 1 ? "" : "s"}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 group-hover/acct:text-cc-brand-600">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </div>
            </Link>
            <ul className="divide-y divide-ppp-charcoal-100">
              {dealRows.map(([oppId, groupInvoices]) => {
          const opp = oppById.get(oppId);
          const account = opp ? accountById.get(opp.account_id) : null;
          const nonVoid = groupInvoices.filter((i) => i.status !== "void");
          const totalInvoiced = nonVoid.reduce((s, i) => s + i.total_cents, 0);
          const totalPaid = nonVoid.reduce((s, i) => s + i.paid_cents, 0);
          const totalBalance = totalInvoiced - totalPaid;
          const overduePresent = groupInvoices.some((i) => deriveInvoiceStatus(i) === "overdue");
          const draftCount = groupInvoices.filter((i) => i.status === "draft").length;
          const groupPct =
            totalInvoiced > 0
              ? Math.min(100, Math.round((totalPaid / totalInvoiced) * 100))
              : 0;
          const groupBarTone =
            totalInvoiced === 0
              ? "bg-ppp-charcoal-200"
              : totalPaid >= totalInvoiced
              ? "bg-emerald-500"
              : overduePresent
              ? "bg-rose-500"
              : totalPaid > 0
              ? "bg-cc-brand-500"
              : "bg-ppp-charcoal-300";
          // Karan 2026-07-07 fix: compact card click used to jump to
          // the opportunities detail page — Karan wants users to stay
          // in the invoicing surface. Now goes to the account-filtered
          // full-detail view (which has this opp visible + inline
          // Record payment + inline New invoice). Anchor to the opp
          // section so multi-opp accounts scroll to the right card.
          //
          // Karan 2026-07-08 orphan-invoice UX: when the parent deal is
          // soft-deleted we can't route to an opp/account view — but
          // collapsing the whole group into a single first-invoice link
          // hides the other N-1 invoices. Instead render the header as
          // a static block (not a Link) and list each invoice as its
          // own sub-row so users can drill into any one of them.
          //
          // Live opps still get the whole-row Link — that path hasn't
          // changed.
          const rowHref = opp && account
            ? `/commercial/invoices?account_id=${account.id}#opp-${opp.id}`
            : account
            ? `/commercial/invoices?account_id=${account.id}`
            : "/commercial/invoices";
          const isOrphan = !opp;
          // Sort orphan sub-rows deterministically: newest created first.
          const orphanSorted = isOrphan
            ? [...groupInvoices].sort((a, b) => b.created_at.localeCompare(a.created_at))
            : groupInvoices;
          const headerBody = (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                {/* Row 1: title + account chip + N invoices + overdue badge */}
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className={`font-semibold text-[14px] truncate ${isOrphan ? "text-ppp-charcoal-500" : "text-ppp-charcoal group-hover/oppInv:text-cc-brand-800"}`}>
                    {opp ? derivedOppName(opp, account?.company_name ?? null) : (
                      <span className="inline-flex items-center gap-1.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-amber-600">
                          <path d="M12 9v4M12 17h.01" />
                          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        </svg>
                        <span className="italic">Deleted opportunity — invoices still on file</span>
                      </span>
                    )}
                  </span>
                  {/* Karan 2026-07-09: dropped the "· Bob" inline chip since
                      account name is now the section header above. Kept the
                      invoice count + overdue flag which are per-deal signals. */}
                  <span className="text-[10px] font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-100 rounded px-1.5 py-0.5 shrink-0">
                    {groupInvoices.length} invoice{groupInvoices.length === 1 ? "" : "s"}
                  </span>
                  {overduePresent && (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800 bg-rose-100 border border-rose-200 rounded px-1.5 py-0.5 shrink-0">
                      Overdue
                    </span>
                  )}
                </div>
                {/* Row 2: money summary */}
                <div className="mt-1 text-[12px] text-ppp-charcoal-600 tabular-nums">
                  <strong className="text-ppp-charcoal">{formatCentsFull(totalInvoiced)}</strong> invoiced
                  {totalBalance > 0 && (
                    <>
                      <span className="text-ppp-charcoal-300"> · </span>
                      <span className="text-cc-brand-700 font-medium">{formatCentsFull(totalBalance)} outstanding</span>
                    </>
                  )}
                  {totalPaid > 0 && (
                    <>
                      <span className="text-ppp-charcoal-300"> · </span>
                      <span className="text-emerald-700 font-medium">{formatCentsFull(totalPaid)} paid</span>
                    </>
                  )}
                  {draftCount > 0 && (
                    <>
                      <span className="text-ppp-charcoal-300"> · </span>
                      <span className="text-ppp-charcoal-500">{draftCount} draft{draftCount === 1 ? "" : "s"}</span>
                    </>
                  )}
                </div>
                {/* Row 3: compact progress bar */}
                {totalInvoiced > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 bg-ppp-charcoal-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${groupBarTone}`}
                        style={{ width: `${groupPct}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-semibold text-ppp-charcoal-500 tabular-nums shrink-0 w-9 text-right">
                      {groupPct}%
                    </span>
                  </div>
                )}
              </div>
              {!isOrphan && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 mt-1 text-ppp-charcoal-300 group-hover/oppInv:text-cc-brand-600 transition-colors"
                  aria-hidden
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </div>
          );
          return (
            <li key={oppId}>
              {isOrphan ? (
                <div className="border-l-2 border-amber-300 bg-amber-50/30">
                  <Link
                    href={`/commercial/invoices?opportunity_id=${oppId}`}
                    className="group/orphanHead block px-4 sm:px-5 py-3.5 hover:bg-amber-50 focus:outline-none focus:bg-amber-50 transition-colors touch-manipulation"
                    title="Focus just this deleted deal's invoices"
                  >
                    {headerBody}
                  </Link>
                  <ul className="border-t border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100 bg-white">
                    {orphanSorted.map((inv) => {
                      const invStatus = deriveInvoiceStatus(inv);
                      const statusTone =
                        invStatus === "paid"
                          ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                          : invStatus === "overdue"
                          ? "bg-rose-100 text-rose-800 border-rose-200"
                          : invStatus === "partial"
                          ? "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-200"
                          : invStatus === "draft"
                          ? "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200"
                          : invStatus === "void"
                          ? "bg-ppp-charcoal-100 text-ppp-charcoal-500 border-ppp-charcoal-200"
                          : "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-200";
                      return (
                        <li key={inv.id}>
                          <Link
                            href={`/commercial/invoices/${inv.id}?from=${encodeURIComponent(`/commercial/invoices?opportunity_id=${oppId}`)}`}
                            className="group/invRow flex items-center gap-3 px-4 sm:px-5 py-2.5 hover:bg-cc-brand-50/40 focus:outline-none focus:bg-cc-brand-50/60 transition-colors touch-manipulation"
                          >
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border ${statusTone} shrink-0`}>
                              {invoiceStatusLabel(invStatus)}
                            </span>
                            <span className="font-mono text-[12px] text-ppp-charcoal-700 truncate flex-1" title={inv.invoice_number}>
                              {inv.invoice_number}
                            </span>
                            <span className="text-[11px] text-ppp-charcoal-500 hidden sm:inline tabular-nums shrink-0">
                              {fmtEtDate(inv.due_at) ? `Due ${fmtEtDate(inv.due_at)}` : `Created ${fmtEtDate(inv.created_at)}`}
                            </span>
                            <span className="font-semibold text-[13px] text-ppp-charcoal tabular-nums shrink-0 min-w-[80px] text-right">
                              {formatCentsFull(inv.total_cents)}
                            </span>
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="shrink-0 text-ppp-charcoal-300 group-hover/invRow:text-cc-brand-600 transition-colors"
                              aria-hidden
                            >
                              <path d="M9 18l6-6-6-6" />
                            </svg>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <Link
                  href={rowHref}
                  className="group/oppInv block px-4 sm:px-5 py-3.5 hover:bg-cc-brand-50/40 focus:outline-none focus:bg-cc-brand-50/60 transition-colors touch-manipulation"
                >
                  {headerBody}
                </Link>
              )}
            </li>
          );
              })}
            </ul>
          </div>
        );
      })}
      {orphanRows.length > 0 && (
        <div className="border-t border-ppp-charcoal-200">
          <div className="px-4 sm:px-5 py-2.5 bg-amber-50/40 border-b border-amber-200 text-[13px] font-bold text-amber-900">
            Deleted deals — invoices still on file
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {orphanRows.map(([oppId, groupInvoices]) => {
              const nonVoid = groupInvoices.filter((i) => i.status !== "void");
              const totalInvoiced = nonVoid.reduce((s, i) => s + i.total_cents, 0);
              const totalPaid = nonVoid.reduce((s, i) => s + i.paid_cents, 0);
              const totalBalance = totalInvoiced - totalPaid;
              return (
                <li key={oppId} className="px-4 sm:px-5 py-3">
                  <Link
                    href={`/commercial/invoices?opportunity_id=${oppId}`}
                    className="block hover:bg-amber-50/30 -mx-4 -my-3 px-4 py-3 touch-manipulation"
                  >
                    <div className="text-[13px] font-semibold text-ppp-charcoal-500 italic flex items-center gap-1.5">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-amber-600">
                        <path d="M12 9v4M12 17h.01" />
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      </svg>
                      Deleted deal
                      <span className="text-[10px] font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-100 rounded px-1.5 py-0.5 not-italic">
                        {groupInvoices.length} invoice{groupInvoices.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-ppp-charcoal-600 tabular-nums">
                      <strong className="text-ppp-charcoal">{formatCentsFull(totalInvoiced)}</strong> invoiced
                      {totalBalance > 0 && (
                        <>
                          <span className="text-ppp-charcoal-300"> · </span>
                          <span className="text-cc-brand-700 font-medium">{formatCentsFull(totalBalance)} outstanding</span>
                        </>
                      )}
                      {totalPaid > 0 && (
                        <>
                          <span className="text-ppp-charcoal-300"> · </span>
                          <span className="text-emerald-700 font-medium">{formatCentsFull(totalPaid)} paid</span>
                        </>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Full-detail grouped view — renders per-opp cards with roll-up + master
 *  progress bar + per-invoice rows that carry an inline Record payment
 *  collapsible. Used when the invoice list is scoped to a single account
 *  so users can do everything from this one page without jumping to opp
 *  detail. Karan 2026-07-07 no-jumping mandate. */
function FullDetailByOpp({
  invoices,
  oppById,
  accountById,
  sortKey,
  accountId,
  paidOk,
  paidInvoiceId,
  paidCapped,
  createdInvoiceId,
  errorMessage,
  openAddOppId,
  wonOppsForAccount,
  pickableProducts,
}: {
  invoices: CommercialInvoice[];
  oppById: Map<string, { id: string; title: string; account_id: string; status: string; client_name: string | null; location_short: string | null }>;
  accountById: Map<string, { id: string; company_name: string }>;
  sortKey: string;
  accountId: string;
  paidOk?: boolean;
  paidInvoiceId?: string | null;
  paidCapped?: boolean;
  createdInvoiceId?: string | null;
  errorMessage?: string | null;
  openAddOppId?: string | null;
  /** Karan 2026-07-09: passed in so the empty state can show a mini
   *  Won-deal picker inline instead of dead-ending. Undefined = don't
   *  render the picker (used for the unfiltered overview which uses a
   *  different empty state entirely). */
  wonOppsForAccount?: CommercialOpportunity[];
  /** Phase D: active-catalog snapshot for the inline "New invoice for
   *  this deal" ProductPicker. Empty means the picker section is
   *  skipped and the form falls back to free-text entry. */
  pickableProducts: Array<{
    id: string;
    sku: string;
    name: string;
    category: string;
    unit: string;
    default_unit_price_cents: number;
  }>;
}) {
  const groups = new Map<string, CommercialInvoice[]>();
  for (const inv of invoices) {
    const arr = groups.get(inv.opportunity_id) ?? [];
    arr.push(inv);
    groups.set(inv.opportunity_id, arr);
  }
  // Karan 2026-07-09 bug fix: when a user clicks "New invoice ▾" on a
  // filtered view for a customer with zero existing invoices, the
  // redirect lands here with ?add=<opp_id> but `groups` is empty — so
  // the per-opp loop that renders the inline "+ New invoice" form
  // never runs, and the page shows "No invoices for this account yet."
  // with no create affordance. Prime an empty group for the requested
  // opp so its inline form renders even on first use. Defensive check
  // that the opp actually belongs to this account and is Won.
  if (openAddOppId && !groups.has(openAddOppId)) {
    const opp = oppById.get(openAddOppId);
    if (opp && opp.account_id === accountId && opp.status === "won") {
      groups.set(openAddOppId, []);
    }
  }
  const oppOrder = Array.from(groups.entries()).sort((a, b) => {
    const aInvs = a[1];
    const bInvs = b[1];
    // Empty groups (opp we primed for first-time create) always float to
    // the top so the "+ New invoice" form is right where the user landed.
    if (aInvs.length === 0 && bInvs.length > 0) return -1;
    if (bInvs.length === 0 && aInvs.length > 0) return 1;
    if (aInvs.length === 0 && bInvs.length === 0) return 0;
    switch (sortKey) {
      case "oldest": {
        const aOldest = Math.min(...aInvs.map((i) => new Date(i.created_at).getTime()));
        const bOldest = Math.min(...bInvs.map((i) => new Date(i.created_at).getTime()));
        return aOldest - bOldest;
      }
      case "due_soon": {
        const nextDue = (rows: typeof aInvs) => {
          const dues = rows
            .filter((i) => i.status !== "paid" && i.status !== "void" && i.due_at)
            .map((i) => new Date(i.due_at as string).getTime());
          return dues.length > 0 ? Math.min(...dues) : Infinity;
        };
        return nextDue(aInvs) - nextDue(bInvs);
      }
      case "amount_high": {
        const sum = (rows: typeof aInvs) =>
          rows.filter((i) => i.status !== "void").reduce((s, i) => s + i.total_cents, 0);
        return sum(bInvs) - sum(aInvs);
      }
      case "balance_high": {
        const bal = (rows: typeof aInvs) =>
          rows.filter((i) => i.status !== "void").reduce((s, i) => s + i.balance_cents, 0);
        return bal(bInvs) - bal(aInvs);
      }
      case "recent":
      default: {
        const aLatest = Math.max(...aInvs.map((i) => new Date(i.created_at).getTime()));
        const bLatest = Math.max(...bInvs.map((i) => new Date(i.created_at).getTime()));
        return bLatest - aLatest;
      }
    }
  });

  if (oppOrder.length === 0) {
    const wonList = wonOppsForAccount ?? [];
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
        <div className="text-sm font-semibold text-ppp-charcoal">No invoices for this customer yet</div>
        {wonList.length > 0 ? (
          <p className="mt-1 text-sm text-ppp-charcoal-500 max-w-md mx-auto">
            {wonList.length === 1
              ? "1 Won deal ready to bill."
              : `${wonList.length} Won deals ready to bill.`}{" "}
            Use <strong className="text-ppp-charcoal-700">New invoice</strong> at the top of this page.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ppp-charcoal-500">
              An invoice attaches to a deal marked <strong>Won</strong>. Win one of this customer's deals first.
            </p>
            <Link
              href={`/commercial/accounts/${accountId}?tab=deals`}
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
            >
              Open this customer's deals
            </Link>
          </>
        )}
      </div>
    );
  }

  const todayEtIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  return (
    <div className="space-y-4">
      {paidOk && (
        <div
          className={`rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3 ${
            paidCapped
              ? "bg-amber-50 border border-amber-200 text-amber-900"
              : "bg-cc-brand-50 border border-cc-brand-200 text-cc-brand-800"
          }`}
        >
          <span>
            Payment recorded.
            {paidCapped && <> Amount was capped to the remaining balance — invoice is fully paid.</>}
          </span>
          <Link
            href={`/commercial/invoices?account_id=${accountId}`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {createdInvoiceId && (
        <div className="rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3 bg-cc-brand-50 border border-cc-brand-200 text-cc-brand-800">
          <span>Invoice created.</span>
          <Link
            href={`/commercial/invoices?account_id=${accountId}`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {errorMessage && (
        <div className="rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3 bg-rose-50 border border-rose-200 text-rose-800">
          <span>{errorMessage}</span>
          <Link
            href={`/commercial/invoices?account_id=${accountId}`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {oppOrder.map(([oppId, groupInvoices]) => {
        const opp = oppById.get(oppId);
        const account = opp ? accountById.get(opp.account_id) : null;
        const nonVoid = groupInvoices.filter((i) => i.status !== "void");
        const totalInvoiced = nonVoid.reduce((s, i) => s + i.total_cents, 0);
        const totalPaid = nonVoid.reduce((s, i) => s + i.paid_cents, 0);
        const totalBalance = totalInvoiced - totalPaid;
        const draftInGroup = groupInvoices.filter((i) => i.status === "draft");
        const draftGroupCount = draftInGroup.length;
        const draftGroupCents = draftInGroup.reduce((s, i) => s + i.total_cents, 0);
        const overduePresent = groupInvoices.some((i) => deriveInvoiceStatus(i) === "overdue");
        const groupPct = totalInvoiced > 0 ? Math.min(100, Math.round((totalPaid / totalInvoiced) * 100)) : 0;
        const groupBarTone =
          totalInvoiced === 0
            ? "bg-ppp-charcoal-200"
            : totalPaid >= totalInvoiced
            ? "bg-emerald-500"
            : overduePresent
            ? "bg-rose-500"
            : totalPaid > 0
            ? "bg-cc-brand-500"
            : "bg-ppp-charcoal-300";
        const sortedGroup = [...groupInvoices].sort((a, b) => a.created_at.localeCompare(b.created_at));
        return (
          <section
            key={oppId}
            id={`opp-${oppId}`}
            className={`scroll-mt-20 bg-white border rounded-xl overflow-hidden shadow-sm ${
              overduePresent ? "border-rose-200" : "border-ppp-charcoal-100"
            }`}
          >
            <div className="px-4 sm:px-5 py-4 border-b border-ppp-charcoal-100 bg-gradient-to-br from-white to-blue-50/30">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    {opp ? (
                      <Link
                        href={`/commercial/opportunities/${opp.id}?tab=invoices`}
                        className="text-[15px] font-bold text-ppp-charcoal hover:text-cc-brand-700 hover:underline underline-offset-2 truncate"
                      >
                        {derivedOppName(opp, account?.company_name ?? null)}
                      </Link>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-[15px] font-bold">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-amber-600 shrink-0">
                          <path d="M12 9v4M12 17h.01" />
                          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        </svg>
                        <span className="text-ppp-charcoal-500 italic">Deleted opportunity — invoices still on file</span>
                      </span>
                    )}
                    {groupInvoices.length === 0 ? (
                      <span className="text-[10px] font-semibold text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 rounded px-1.5 py-0.5">
                        First invoice
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-100 border border-ppp-charcoal-200 rounded px-1.5 py-0.5">
                        {groupInvoices.length} invoice{groupInvoices.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {overduePresent && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800 bg-rose-100 border border-rose-300 rounded px-1.5 py-0.5">
                        Overdue
                      </span>
                    )}
                  </div>
                  {account && (
                    <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 inline-flex items-center gap-1.5">
                      <AccountAvatar accountId={account.id} name={account.company_name} size="xs" />
                      <span className="truncate">{account.company_name}</span>
                    </div>
                  )}
                </div>
                {/* Karan 2026-07-09: Delete-all-invoices affordance per
                    deal so cleanup doesn't require clicking each row.
                    Two-step popover: click summary → panel with a Delete
                    button. Popover-only, no URL flip, so we can't
                    accidentally wipe by opening a stale link. */}
                {groupInvoices.length > 1 && (
                  <details className="relative group/wipe shrink-0">
                    <summary className="list-none cursor-pointer inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-rose-200 text-[11.5px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[36px] touch-manipulation">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
                      </svg>
                      Delete all
                    </summary>
                    <div className="absolute right-0 mt-2 z-20 bg-white border border-rose-200 rounded-lg shadow-xl p-3 w-[280px]">
                      <div className="text-[12.5px] text-ppp-charcoal-800 font-semibold">
                        Delete all {groupInvoices.length} invoices for this deal?
                      </div>
                      {groupInvoices.some((i) => (i.paid_cents ?? 0) > 0 && i.status !== "void") && (
                        <p className="mt-1 text-[11px] text-ppp-charcoal-600">
                          Paid ones auto-void first — payment history stays in the audit log.
                        </p>
                      )}
                      <form action={bulkDeleteInvoicesForOppAction} className="mt-2 flex items-center gap-2">
                        <input type="hidden" name="opp_id" value={oppId} />
                        <input type="hidden" name="confirm" value="yes" />
                        <input type="hidden" name="return_account_id" value={accountId} />
                        <button
                          type="submit"
                          className="flex-1 inline-flex items-center justify-center px-3 py-1.5 rounded-md bg-rose-600 text-white text-[12.5px] font-semibold hover:bg-rose-700 min-h-[36px] touch-manipulation"
                        >
                          Delete all
                        </button>
                      </form>
                    </div>
                  </details>
                )}
              </div>
              {groupInvoices.length > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="border border-cc-brand-200 bg-cc-brand-50/40 rounded-lg px-2.5 py-1.5">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Invoiced</div>
                    <div className="text-[13px] font-bold text-ppp-charcoal tabular-nums">{formatCentsCompact(totalInvoiced)}</div>
                  </div>
                  <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg px-2.5 py-1.5">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Paid</div>
                    <div className="text-[13px] font-bold text-ppp-charcoal tabular-nums">{formatCentsCompact(totalPaid)}</div>
                  </div>
                  <div className={`border rounded-lg px-2.5 py-1.5 ${
                    totalBalance > 0 ? "border-cc-brand-200 bg-cc-brand-50/40" : "border-ppp-charcoal-200 bg-ppp-charcoal-50/40"
                  }`}>
                    <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Balance</div>
                    <div className="text-[13px] font-bold text-ppp-charcoal tabular-nums">{formatCentsCompact(totalBalance)}</div>
                  </div>
                </div>
              )}
              {totalInvoiced > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Deal progress</div>
                    <div className="text-[10.5px] text-ppp-charcoal-600 tabular-nums">
                      <strong className="text-ppp-charcoal">{formatCentsFull(totalPaid)}</strong>
                      <span className="text-ppp-charcoal-500"> of {formatCentsFull(totalInvoiced)}</span>
                      <span className="text-ppp-charcoal-400"> · {groupPct}%</span>
                    </div>
                  </div>
                  <div className="h-2 bg-ppp-charcoal-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${groupBarTone}`} style={{ width: `${groupPct}%` }} />
                  </div>
                  {draftGroupCount > 0 && (
                    <div className="mt-1 text-[10.5px] text-ppp-charcoal-500">
                      Includes {draftGroupCount} draft{draftGroupCount === 1 ? "" : "s"} ({formatCentsFull(draftGroupCents)}) not yet sent.
                    </div>
                  )}
                </div>
              )}
            </div>
            <ul className="divide-y divide-ppp-charcoal-100">
              {sortedGroup.map((inv) => {
                const displayStatus = deriveInvoiceStatus(inv);
                const isVoid = inv.status === "void";
                const isPaidInFull = inv.paid_cents >= inv.total_cents && inv.total_cents > 0;
                const canRecordPayment = !isVoid && !isPaidInFull;
                const daysUntilDue = daysBetween(new Date().toISOString(), inv.due_at);
                const isOverdue = displayStatus === "overdue";
                const isFlashRow = paidInvoiceId === inv.id;
                return (
                  <li
                    key={inv.id}
                    id={`inv-${inv.id}`}
                    className={`scroll-mt-4 ${isFlashRow ? "bg-cc-brand-50/40" : ""}`}
                  >
                    <Link
                      href={`/commercial/invoices/${inv.id}`}
                      className="group/inv block px-4 sm:px-5 py-3 hover:bg-cc-brand-50/30 transition-colors touch-manipulation"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold text-[12.5px] text-ppp-charcoal group-hover/inv:text-cc-brand-800 group-hover/inv:underline">
                              {inv.invoice_number}
                            </span>
                            <StatusPill status={displayStatus} />
                            {inv.due_at && (
                              <span
                                className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                                  isOverdue ? "text-rose-700" : daysUntilDue !== null && daysUntilDue <= 7 ? "text-amber-700" : "text-cc-brand-700"
                                }`}
                              >
                                Due {fmtEtDate(inv.due_at)}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-[11.5px] text-ppp-charcoal-500">
                            <strong className="text-ppp-charcoal">{formatCentsFull(inv.total_cents)}</strong>
                            {inv.balance_cents > 0 && !isVoid && (
                              <>
                                {" · "}
                                <span className="text-cc-brand-700 font-medium">{formatCentsFull(inv.balance_cents)} outstanding</span>
                              </>
                            )}
                            {inv.paid_at && isPaidInFull && (
                              <>
                                {" · "}
                                <span className="text-emerald-700 font-medium">Paid {fmtEtDate(inv.paid_at)}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 group-hover/inv:text-cc-brand-600 shrink-0 mt-1 transition-colors" aria-hidden>
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                      </div>
                    </Link>
                    {/* Karan 2026-07-07: consistency fix. Void + paid
                        invoices used to show NOTHING below the header
                        (canRecordPayment false), which made the list
                        read as "some rows have a strip, some don't."
                        Now every non-void-non-paid row has the record-
                        payment collapsible; void + paid rows show a
                        subtle muted status strip in the same slot so
                        the vertical rhythm reads consistently. */}
                    {isVoid ? (
                      <div className="border-t border-ppp-charcoal-100 px-4 sm:px-5 py-2 flex items-center gap-1.5 text-[12px] font-medium text-ppp-charcoal-500 bg-ppp-charcoal-50/40 min-h-[40px]">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <circle cx="12" cy="12" r="10" />
                          <path d="M4.93 4.93l14.14 14.14" />
                        </svg>
                        Voided — no payments possible.
                      </div>
                    ) : isPaidInFull ? (
                      <div className="border-t border-ppp-charcoal-100 px-4 sm:px-5 py-2 flex items-center gap-1.5 text-[12px] font-medium text-emerald-700 bg-emerald-50/40 min-h-[40px]">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Paid in full{inv.paid_at ? ` on ${fmtEtDate(inv.paid_at)}` : ""}.
                      </div>
                    ) : (
                      <details className="group/pay border-t border-ppp-charcoal-100">
                        <summary className="list-none cursor-pointer flex items-center justify-between gap-2 px-4 sm:px-5 py-2 text-[12px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50/60 min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40">
                          <span className="inline-flex items-center gap-1.5">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 5v14 M5 12h14" />
                            </svg>
                            Record payment
                            <span className="text-[11px] font-normal text-ppp-charcoal-500">· {formatCentsFull(inv.balance_cents)} outstanding</span>
                          </span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-400 transition-transform group-open/pay:rotate-180" aria-hidden>
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </summary>
                        <form
                          action={recordInvoicePaymentFromListAction}
                          className="px-4 sm:px-5 pb-3 pt-1 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
                        >
                          <input type="hidden" name="invoice_id" value={inv.id} />
                          <input type="hidden" name="account_id" value={accountId} />
                          <label className="block">
                            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Amount</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              name="amount"
                              required
                              defaultValue={(inv.balance_cents / 100).toFixed(2)}
                              placeholder="0.00"
                              className="w-full px-2 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] tabular-nums min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                            />
                          </label>
                          <label className="block">
                            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Paid on</span>
                            <input
                              type="date"
                              name="paid_at"
                              defaultValue={todayEtIso}
                              className="w-full px-2 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                            />
                          </label>
                          <label className="block">
                            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Method</span>
                            <select
                              name="method"
                              defaultValue=""
                              className="w-full px-2 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] bg-white min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                            >
                              <option value="">— select —</option>
                              {PAYMENT_METHODS.map((m) => (
                                <option key={m.key} value={m.key}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="flex items-end">
                            <button
                              type="submit"
                              className="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 rounded-md bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40"
                            >
                              Record
                            </button>
                          </div>
                          <label className="block sm:col-span-4">
                            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">
                              Reference <span className="font-normal text-ppp-charcoal-400">(check #, txn ID — optional)</span>
                            </span>
                            <input
                              type="text"
                              name="reference"
                              maxLength={128}
                              className="w-full px-2 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                            />
                          </label>
                          {/* Karan 2026-07-07: Notes field parity with the
                              invoice detail page's payment form. Previously
                              missing on the list — users had to jump to
                              /commercial/invoices/<id> to attach a note,
                              which violated the "no jumping" mandate. */}
                          <label className="block sm:col-span-4">
                            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">
                              Notes <span className="font-normal text-ppp-charcoal-400">(internal — never on the customer copy — optional)</span>
                            </span>
                            <textarea
                              name="notes"
                              rows={2}
                              maxLength={500}
                              className="w-full px-2 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                            />
                          </label>
                        </form>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* Inline "+ New invoice" collapsible per opp — Karan
                2026-07-07: retired the batch creator page, everything
                inline. Description + amount + due date is the minimum;
                progressive disclosure ("More details") for tax %, PO,
                terms, message, internal notes. Submits to
                createInvoiceInlineAction which redirects back here
                with an anchor to the newly-created row. */}
            {opp && opp.status === "won" && (
              <details
                id={`add-${oppId}`}
                open={openAddOppId === oppId}
                className="group/add border-t border-ppp-charcoal-100"
              >
                <summary className="list-none cursor-pointer flex items-center gap-2 px-4 sm:px-5 py-3 text-[12px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50/40 min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 5v14 M5 12h14" />
                  </svg>
                  New invoice for this deal
                  <span aria-hidden className="ml-auto text-ppp-charcoal-400 transition-transform group-open/add:rotate-180">▾</span>
                </summary>
                <form
                  action={createInvoiceInlineAction}
                  className="px-4 sm:px-5 pb-4 pt-1 space-y-3"
                >
                  <input type="hidden" name="account_id" value={accountId} />
                  <input type="hidden" name="opp_id" value={oppId} />
                  <input type="hidden" name="product_id" id={`inv-add-${oppId}-product-id`} value="" />
                  {pickableProducts.length > 0 && (
                    <ProductPicker
                      products={pickableProducts}
                      accountId={accountId}
                      descriptionInputId={`inv-add-${oppId}-description`}
                      unitInputId={`inv-add-${oppId}-unit-noop`}
                      unitPriceInputId={`inv-add-${oppId}-amount`}
                      productIdInputId={`inv-add-${oppId}-product-id`}
                    />
                  )}
                  <div>
                    <label className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">
                      What this charge is for
                    </label>
                    <input
                      id={`inv-add-${oppId}-description`}
                      type="text"
                      name="description"
                      required
                      maxLength={500}
                      placeholder="e.g. Progress payment 1 of 3 — Lobby repaint"
                      className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Amount</span>
                      <input
                        id={`inv-add-${oppId}-amount`}
                        type="text"
                        inputMode="decimal"
                        name="amount"
                        required
                        placeholder="0.00"
                        className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] tabular-nums min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                      />
                    </label>
                    <label className="block">
                      <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Due date</span>
                      <input
                        type="date"
                        name="due_at"
                        defaultValue={(() => {
                          const d = new Date();
                          d.setDate(d.getDate() + 30);
                          return d.toLocaleDateString("en-CA");
                        })()}
                        className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                      />
                    </label>
                  </div>
                  {/* Progressive disclosure — advanced fields sit
                      behind another <details> so the common case stays
                      three fields. */}
                  <details className="group/more">
                    <summary className="list-none cursor-pointer text-[11.5px] font-medium text-cc-brand-700 hover:text-cc-brand-800 min-h-[28px] flex items-center gap-1.5 select-none">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open/more:rotate-90" aria-hidden>
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                      More details (terms, tax, PO, notes)
                    </summary>
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block">
                        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Payment terms</span>
                        <input
                          type="text"
                          name="payment_terms"
                          maxLength={60}
                          placeholder="Net 30"
                          className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                        />
                      </label>
                      <label className="block">
                        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Tax % (flat)</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          pattern="[0-9.]*"
                          name="tax_pct"
                          placeholder="0"
                          className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                        />
                      </label>
                      <label className="block sm:col-span-2">
                        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">PO number</span>
                        <input
                          type="text"
                          name="po_number"
                          maxLength={80}
                          className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                        />
                      </label>
                      <label className="block sm:col-span-2">
                        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Message to customer</span>
                        <textarea
                          name="customer_message"
                          rows={2}
                          maxLength={1000}
                          placeholder="Optional — appears above line items on the customer's copy."
                          className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                        />
                      </label>
                      <label className="block sm:col-span-2">
                        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">Internal notes</span>
                        <textarea
                          name="notes"
                          rows={2}
                          maxLength={2000}
                          placeholder="Never on the customer copy."
                          className="w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                        />
                      </label>
                    </div>
                  </details>
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40"
                    >
                      Create invoice
                    </button>
                  </div>
                </form>
              </details>
            )}
          </section>
        );
      })}
    </div>
  );
}

function InvoiceRow({ invoice, accountName }: { invoice: CommercialInvoice; accountName: string }) {
  const displayStatus = deriveInvoiceStatus(invoice);
  const daysUntilDue = daysBetween(new Date().toISOString(), invoice.due_at);
  const dueLabel =
    invoice.status === "paid" || invoice.status === "void"
      ? null
      : daysUntilDue === null
      ? null
      : daysUntilDue < 0
      ? { label: `${Math.abs(daysUntilDue)}d overdue`, tone: "overdue" as const }
      : daysUntilDue === 0
      ? { label: "Due today", tone: "soon" as const }
      : daysUntilDue <= 7
      ? { label: `Due in ${daysUntilDue}d`, tone: "soon" as const }
      : { label: `Due in ${daysUntilDue}d`, tone: "ok" as const };
  const progressPct =
    invoice.total_cents > 0
      ? Math.min(100, Math.round((invoice.paid_cents / invoice.total_cents) * 100))
      : 0;
  const barTone =
    invoice.status === "void"
      ? "bg-ppp-charcoal-300"
      : invoice.paid_cents >= invoice.total_cents && invoice.total_cents > 0
      ? "bg-emerald-500"
      : invoice.paid_cents > 0
      ? "bg-cc-brand-500"
      : displayStatus === "overdue"
      ? "bg-rose-500"
      : "bg-ppp-charcoal-300";
  // Karan 2026-07-11 signature-moments stage 5: days-idle heat on
  // overdue invoices — mirror the deal-side treatment. 15d+ overdue
  // gets a subtle rose tint, hover deepens instead of washing out.
  // Only applies to open-balance invoices; paid/void are exempt.
  const isOpenBalance =
    invoice.status !== "paid" &&
    invoice.status !== "void" &&
    invoice.paid_cents < invoice.total_cents;
  const overdueDays =
    isOpenBalance && daysUntilDue !== null && daysUntilDue < 0 ? Math.abs(daysUntilDue) : 0;
  const overdueTint =
    overdueDays >= 30
      ? "bg-rose-50/50 hover:bg-rose-100/60"
      : overdueDays >= 15
      ? "bg-amber-50/40 hover:bg-amber-100/60"
      : "hover:bg-cc-brand-50/30";
  return (
    <li className={`relative group/row transition-colors ${overdueTint}`}>
      <Link href={`/commercial/invoices/${invoice.id}`} className="block px-4 py-4 touch-manipulation">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-ppp-charcoal text-[15px] leading-tight font-mono">
                {invoice.invoice_number}
              </span>
              <StatusPill status={displayStatus} />
              {dueLabel && <DueChip {...dueLabel} />}
            </div>
            <div className="text-[12px] text-ppp-charcoal-500 mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              <span className="text-ppp-charcoal-700 font-medium">{accountName}</span>
              <span aria-hidden>·</span>
              <span>
                <strong className="text-ppp-charcoal">{formatCentsFull(invoice.total_cents)}</strong> invoiced
              </span>
              {invoice.balance_cents > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-cc-brand-700 font-medium">
                    {formatCentsFull(invoice.balance_cents)} outstanding
                  </span>
                </>
              )}
            </div>
            {/* Prominent due date + payment progress bar. Due date reads
                as the primary "when does this need to be paid" signal.
                Karan 2026-07-07: due dates should be prominent, and each
                invoice should have a progress bar showing how paid it is. */}
            {(invoice.due_at || invoice.total_cents > 0) && invoice.status !== "void" && (
              <div className="mt-2.5 space-y-1.5">
                {invoice.due_at && (
                  <div className="flex items-center gap-1.5 text-[12.5px]">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400">
                      <rect x="3" y="4" width="18" height="18" rx="2" />
                      <path d="M16 2v4 M8 2v4 M3 10h18" />
                    </svg>
                    <span className="font-semibold text-ppp-charcoal">
                      Due {fmtEtDate(invoice.due_at)}
                    </span>
                    {invoice.paid_at && invoice.paid_cents >= invoice.total_cents && (
                      <span className="text-emerald-700 font-medium">
                        · Paid {fmtEtDate(invoice.paid_at)}
                      </span>
                    )}
                  </div>
                )}
                {invoice.total_cents > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 bg-ppp-charcoal-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${barTone}`}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-semibold text-ppp-charcoal-500 tabular-nums shrink-0 w-9 text-right">
                      {progressPct}%
                    </span>
                  </div>
                )}
              </div>
            )}
            {(invoice.issued_at || invoice.po_number) && (
              <div className="text-[11px] mt-1.5 flex items-center gap-x-3 gap-y-0.5 flex-wrap text-ppp-charcoal-500">
                {invoice.issued_at && (
                  <span>Issued {fmtEtDate(invoice.issued_at)}</span>
                )}
                {invoice.po_number && (
                  <span>PO {invoice.po_number}</span>
                )}
              </div>
            )}
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 group-hover/row:text-cc-brand-600 shrink-0 mt-1 transition-colors" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </Link>
    </li>
  );
}

function KpiCard({
  tone,
  label,
  value,
  sub,
}: {
  tone: "cc-brand" | "blue" | "rose" | "neutral";
  label: string;
  value: string;
  sub: string;
}) {
  const ring =
    tone === "cc-brand"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-cc-brand-50/50"
      : tone === "blue"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-blue-50/50"
      : tone === "rose"
      ? "border-rose-200 bg-gradient-to-br from-white to-rose-50/50"
      : "border-ppp-charcoal-100 bg-white";
  const stripe =
    tone === "cc-brand" ? "bg-cc-brand-600" : tone === "blue" ? "bg-cc-brand-500" : tone === "rose" ? "bg-rose-500" : "bg-ppp-charcoal-200";
  return (
    <div className={`relative border rounded-xl px-4 py-3 overflow-hidden shadow-sm ${ring}`}>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[12px] font-semibold text-ppp-charcoal-700">
        {label}
      </div>
      <div className="text-xl sm:text-2xl font-bold text-ppp-charcoal mt-1">
        {value}
      </div>
      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>
    </div>
  );
}

/** Compact AR-aging tile — only renders when overdue balance is present.
 *  Clicking the tile drills into the overdue-status filtered list so Alex
 *  can chase collections from the exact bucket. */
function AgingTile({
  label,
  count,
  cents,
  tone,
}: {
  label: string;
  count: number;
  cents: number;
  tone: "amber" | "rose" | "rose-deep";
}) {
  const cls =
    tone === "amber"
      ? "border-amber-200 bg-amber-50/60 text-amber-900"
      : tone === "rose"
      ? "border-rose-200 bg-rose-50/60 text-rose-900"
      : "border-rose-300 bg-rose-100/70 text-rose-900";
  const stripe =
    tone === "amber" ? "bg-amber-500" : tone === "rose" ? "bg-rose-500" : "bg-rose-700";
  return (
    <Link
      href="/commercial/invoices?status=overdue"
      className={`group/aging relative border rounded-lg px-3 py-2 overflow-hidden hover:shadow-sm transition-shadow ${cls}`}
    >
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[9.5px] font-bold uppercase tracking-wider opacity-90">
        {label}
      </div>
      <div className="text-base sm:text-lg font-bold tabular-nums mt-0.5">
        {formatCentsCompact(cents)}
        <span className="text-[10.5px] font-medium opacity-70 ml-1.5 group-hover/aging:underline">
          · {count} {count === 1 ? "invoice" : "invoices"}
        </span>
      </div>
    </Link>
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
      ? "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-300"
      : status === "partial"
      ? "bg-amber-100 text-amber-900 border-amber-300"
      : "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border ${cls}`}>
      {invoiceStatusLabel(status)}
    </span>
  );
}

function DueChip({ label, tone }: { label: string; tone: "ok" | "soon" | "overdue" }) {
  const cls =
    tone === "overdue"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : tone === "soon"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}
