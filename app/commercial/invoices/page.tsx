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
import { listCommercialAccounts, getCommercialAccount } from "@/lib/commercial/accounts/db";
import { listCommercialOpportunities } from "@/lib/commercial/opportunities/db";
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
    redirect(`/commercial/invoices?account_id=${account_id}&error=${encodeURIComponent("Enter a valid payment amount.")}`);
  }
  const paid_at_raw = String(formData.get("paid_at") ?? "").trim();
  const paid_at = paid_at_raw
    ? /^\d{4}-\d{2}-\d{2}$/.test(paid_at_raw)
      ? `${paid_at_raw}T16:00:00.000Z`
      : new Date(paid_at_raw).toISOString()
    : undefined;
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const result = await addPayment(invoice_id, {
    amount_cents: amount_cents!,
    paid_at,
    method,
    reference,
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
  const [invoicesRaw, accounts, accountFilter, allOpps] = await Promise.all([
    listCommercialInvoices({ status: statusFilter, accountId: accountIdFilter }),
    listCommercialAccounts(),
    accountIdFilter ? getCommercialAccount(accountIdFilter) : Promise.resolve(null),
    listCommercialOpportunities({}),
  ]);
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
  const wonOpps = allOpps
    .filter((o) => o.status === "won")
    .sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at));

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

  return (
    <div className="space-y-5">
      {deletedFlash && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Invoice deleted.</span>
        </div>
      )}
      {invoicesCreatedFlash > 0 && (
        <div className={`rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3 ${
          invoiceErrorsFlash > 0
            ? "bg-amber-50 border border-amber-200 text-amber-900"
            : "bg-blue-50 border border-blue-200 text-blue-800"
        }`}>
          <span>
            <strong>{invoicesCreatedFlash}</strong> invoice{invoicesCreatedFlash === 1 ? "" : "s"} created.
            {invoiceErrorsFlash > 0 && (
              <> {invoiceErrorsFlash} row{invoiceErrorsFlash === 1 ? "" : "s"} skipped due to input errors.</>
            )}
            {" Shown grouped by opportunity below."}
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
        <div className="bg-white border border-blue-200 rounded-xl px-4 py-3 text-sm text-ppp-charcoal-700 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
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
              className="text-[12px] font-medium text-ppp-charcoal-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 min-h-[36px] px-2 touch-manipulation"
              title="Open the account detail page in a new context"
            >
              Open account
            </Link>
            <Link
              href="/commercial/invoices"
              className="text-[12px] font-semibold text-blue-700 hover:text-blue-900 inline-flex items-center gap-1 min-h-[44px] px-3 touch-manipulation"
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
              Bill for Won opportunities. Track sent · viewed · paid · overdue.
            </p>
          </div>
          {/* New invoice CTA — right-aligned so it sits next to the title
              like Salesforce's "New" button. Progressive-disclosure: click
              to open a Won-opp picker directly on this page rather than
              making the user go opp-first + click Convert. */}
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
              <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-1 pb-2">
                Pick a Won opportunity to bill
              </div>
              {wonOpps.length === 0 ? (
                <div className="px-2 py-3 text-[12.5px] text-ppp-charcoal-500">
                  No Won opportunities yet.{" "}
                  <Link href="/commercial/opportunities" className="text-blue-700 font-semibold hover:underline">
                    Go to pipeline →
                  </Link>
                </div>
              ) : (
                <div className="max-h-[320px] overflow-y-auto space-y-0.5">
                  {wonOpps.map((o) => {
                    const acct = accountById.get(o.account_id);
                    // Karan 2026-07-07 bug fix: use `invoicesRaw` here
                    // (not `invoices`) so the "N invoices already" badge
                    // reflects true count, not the search-filtered subset.
                    // Otherwise searching "Widget" would zero out counts on
                    // every non-matching opp in the picker.
                    const existing = invoicesRaw.filter((i) => i.opportunity_id === o.id).length;
                    return (
                      <Link
                        key={o.id}
                        href={`/commercial/invoices/new?opp=${o.id}`}
                        className="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-blue-50 min-h-[44px] touch-manipulation"
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-ppp-charcoal truncate">
                            {o.title}
                          </div>
                          <div className="text-[11px] text-ppp-charcoal-500 truncate">
                            {acct?.company_name ?? "—"}
                            {existing > 0 && (
                              <span className="ml-1.5 text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded px-1 py-0.5">
                                {existing} invoice{existing === 1 ? "" : "s"} already
                              </span>
                            )}
                          </div>
                        </div>
                        <span aria-hidden className="text-cc-brand-600 shrink-0 mt-0.5">→</span>
                      </Link>
                    );
                  })}
                </div>
              )}
              <div className="mt-2 pt-2 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500 px-1">
                Multiple invoices per opportunity are allowed (progress billing).
              </div>
            </div>
          </details>
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
                  ? "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100"
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
                        active ? "bg-blue-50 hover:bg-blue-100" : "hover:bg-ppp-charcoal-50"
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
                      <span className={`text-[13px] font-semibold ${active ? "text-blue-800" : "text-ppp-charcoal-700"}`}>
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

      {/* List / empty */}
      {sorted.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-12 text-center">
          <div aria-hidden className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div className="text-sm font-semibold text-ppp-charcoal">
            {anyFilterActive ? "No invoices match these filters" : "No invoices yet"}
          </div>
          <p className="mt-1 text-sm text-ppp-charcoal-500">
            {anyFilterActive
              ? "Try clearing filters or searching by invoice number or opportunity title."
              : "Convert a Won opportunity into an invoice to get started."}
          </p>
          {anyFilterActive ? (
            <Link
              href="/commercial/invoices"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              Clear all filters
            </Link>
          ) : (
            <Link
              href="/commercial/opportunities"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
            >
              Go to opportunities
            </Link>
          )}
        </div>
      ) : accountIdFilter ? (
        // Karan 2026-07-07: when scoped to a specific account, render
        // FULL detail (per-invoice rows + inline Record payment + Add
        // invoice) so users can do everything from this one page
        // without jumping to opp detail. Compact list is only for the
        // unfiltered overview.
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
        />
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
  oppById: Map<string, { id: string; title: string; account_id: string; status: string }>;
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

  // Karan 2026-07-07 redesign: grouped view collapsed to a compact list
  // of opp ROWS instead of per-opp expanded cards. Each row = opp title +
  // account chip + summary tiles + Open button that jumps into the opp
  // Invoices tab (which owns the master progress bar + per-invoice detail
  // + Record payment collapsibles + Add invoice). Kept: total-invoiced,
  // outstanding, N invoices, overdue flag. Dropped: per-invoice inline
  // rows, master progress bar (moved to opp Invoices tab), Add invoice
  // button per row (moved to opp Invoices tab). Account name click goes
  // to a filtered invoice list, NOT the accounts page.
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden shadow-sm">
      <ul className="divide-y divide-ppp-charcoal-100">
        {oppOrder.map(([oppId, groupInvoices]) => {
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
              ? "bg-blue-500"
              : "bg-ppp-charcoal-300";
          // Karan 2026-07-07 fix: compact card click used to jump to
          // the opportunities detail page — Karan wants users to stay
          // in the invoicing surface. Now goes to the account-filtered
          // full-detail view (which has this opp visible + inline
          // Record payment + inline New invoice). Anchor to the opp
          // section so multi-opp accounts scroll to the right card.
          const rowHref = opp && account
            ? `/commercial/invoices?account_id=${account.id}#opp-${opp.id}`
            : "#";
          return (
            <li key={oppId}>
              <Link
                href={rowHref}
                className="group/oppInv block px-4 sm:px-5 py-3.5 hover:bg-blue-50/40 focus:outline-none focus:bg-blue-50/60 transition-colors touch-manipulation"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    {/* Row 1: title + account chip + N invoices + overdue badge */}
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-semibold text-[14px] text-ppp-charcoal group-hover/oppInv:text-blue-800 truncate">
                        {opp ? opp.title : <span className="text-ppp-charcoal-400 italic">Opportunity unavailable</span>}
                      </span>
                      {account && (
                        <span
                          className="text-[11px] text-ppp-charcoal-500 truncate max-w-[180px]"
                          title={account.company_name}
                        >
                          · {account.company_name}
                        </span>
                      )}
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
                </div>
              </Link>
              {/* Karan 2026-07-07: "View all invoices for X" chip removed
                  — the whole row now links to the same filtered detail
                  target (account_id=<X>#opp-<Y>) so the chip was
                  redundant. Fewer clickable areas per row + zero
                  jumping. */}
            </li>
          );
        })}
      </ul>
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
}: {
  invoices: CommercialInvoice[];
  oppById: Map<string, { id: string; title: string; account_id: string; status: string }>;
  accountById: Map<string, { id: string; company_name: string }>;
  sortKey: string;
  accountId: string;
  paidOk?: boolean;
  paidInvoiceId?: string | null;
  paidCapped?: boolean;
  createdInvoiceId?: string | null;
  errorMessage?: string | null;
  openAddOppId?: string | null;
}) {
  const groups = new Map<string, CommercialInvoice[]>();
  for (const inv of invoices) {
    const arr = groups.get(inv.opportunity_id) ?? [];
    arr.push(inv);
    groups.set(inv.opportunity_id, arr);
  }
  const oppOrder = Array.from(groups.entries()).sort((a, b) => {
    const aInvs = a[1];
    const bInvs = b[1];
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
    return (
      <div className="bg-ppp-charcoal-50/40 border border-ppp-charcoal-100 rounded-xl p-8 text-center">
        <p className="text-[13px] text-ppp-charcoal-600">No invoices for this account yet.</p>
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
              : "bg-blue-50 border border-blue-200 text-blue-800"
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
        <div className="rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3 bg-blue-50 border border-blue-200 text-blue-800">
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
            ? "bg-blue-500"
            : "bg-ppp-charcoal-300";
        const sortedGroup = [...groupInvoices].sort((a, b) => a.created_at.localeCompare(b.created_at));
        return (
          <section
            key={oppId}
            id={`opp-${oppId}`}
            className={`scroll-mt-4 bg-white border rounded-xl overflow-hidden shadow-sm ${
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
                        className="text-[15px] font-bold text-ppp-charcoal hover:text-blue-800 hover:underline underline-offset-2 truncate"
                      >
                        {opp.title}
                      </Link>
                    ) : (
                      <span className="text-[15px] font-bold text-ppp-charcoal-400 italic">Opportunity unavailable</span>
                    )}
                    <span className="text-[10px] font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-100 border border-ppp-charcoal-200 rounded px-1.5 py-0.5">
                      {groupInvoices.length} invoice{groupInvoices.length === 1 ? "" : "s"}
                    </span>
                    {overduePresent && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800 bg-rose-100 border border-rose-300 rounded px-1.5 py-0.5">
                        Overdue
                      </span>
                    )}
                  </div>
                  {account && (
                    <div className="text-[12px] text-ppp-charcoal-500 mt-0.5">{account.company_name}</div>
                  )}
                </div>
              </div>
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
                  totalBalance > 0 ? "border-blue-200 bg-blue-50/40" : "border-ppp-charcoal-200 bg-ppp-charcoal-50/40"
                }`}>
                  <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Balance</div>
                  <div className="text-[13px] font-bold text-ppp-charcoal tabular-nums">{formatCentsCompact(totalBalance)}</div>
                </div>
              </div>
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
                    className={`scroll-mt-4 ${isFlashRow ? "bg-blue-50/40" : ""}`}
                  >
                    <Link
                      href={`/commercial/invoices/${inv.id}`}
                      className="group/inv block px-4 sm:px-5 py-3 hover:bg-blue-50/30 transition-colors touch-manipulation"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold text-[12.5px] text-ppp-charcoal group-hover/inv:text-blue-800 group-hover/inv:underline">
                              {inv.invoice_number}
                            </span>
                            <StatusPill status={displayStatus} />
                            {inv.due_at && (
                              <span
                                className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                                  isOverdue ? "text-rose-700" : daysUntilDue !== null && daysUntilDue <= 7 ? "text-amber-700" : "text-blue-700"
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
                        <summary className="list-none cursor-pointer flex items-center justify-between gap-2 px-4 sm:px-5 py-2 text-[12px] font-semibold text-blue-700 hover:bg-blue-50/60 min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40">
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
                  <div>
                    <label className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5">
                      What this charge is for
                    </label>
                    <input
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
                    <summary className="list-none cursor-pointer text-[11.5px] font-medium text-blue-700 hover:text-blue-900 min-h-[28px] flex items-center gap-1.5 select-none">
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
                          type="number"
                          name="tax_pct"
                          step="0.001"
                          min="0"
                          max="100"
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
      ? "bg-blue-500"
      : displayStatus === "overdue"
      ? "bg-rose-500"
      : "bg-ppp-charcoal-300";
  return (
    <li className="relative group/row hover:bg-blue-50/30 transition-colors">
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
      ? "border-blue-200 bg-gradient-to-br from-white to-blue-50/50"
      : tone === "rose"
      ? "border-rose-200 bg-gradient-to-br from-white to-rose-50/50"
      : "border-ppp-charcoal-100 bg-white";
  const stripe =
    tone === "cc-brand" ? "bg-cc-brand-600" : tone === "blue" ? "bg-blue-500" : tone === "rose" ? "bg-rose-500" : "bg-ppp-charcoal-200";
  return (
    <div className={`relative border rounded-xl px-4 py-3 overflow-hidden shadow-sm ${ring}`}>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
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

function DueChip({ label, tone }: { label: string; tone: "ok" | "soon" | "overdue" }) {
  const cls =
    tone === "overdue"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : tone === "soon"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-blue-50 text-blue-700 border-blue-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}
