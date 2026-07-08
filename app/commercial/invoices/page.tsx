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
import { listCommercialInvoices, type CommercialInvoice } from "@/lib/commercial/invoices/db";
import { listCommercialAccounts, getCommercialAccount } from "@/lib/commercial/accounts/db";
import { listCommercialOpportunities } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  invoiceStatusLabel,
  deriveInvoiceStatus,
  BILLABLE_INVOICE_STATUSES,
  INVOICE_STATUSES,
  type InvoiceStatus,
} from "@/lib/commercial/invoices/constants";
import { formatCentsCompact, formatCentsFull, fmtEtDate, daysBetween } from "@/lib/commercial/invoices/format";
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
}>;

type ViewMode = "list" | "grouped";

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
  const viewRaw = pickFirst(sp.view);
  const viewMode: ViewMode = viewRaw === "grouped" ? "grouped" : "list";
  const accountIdRaw = pickFirst(sp.account_id);
  const accountIdFilter = accountIdRaw && UUID_RE.test(accountIdRaw) ? accountIdRaw : undefined;
  const deletedFlash = pickFirst(sp.deleted) === "1";
  const invoicesCreatedFlash = Number(pickFirst(sp.invoices_created) ?? 0);
  const invoiceErrorsFlash = Number(pickFirst(sp.invoice_errors) ?? 0);
  const statusErrorFlash = pickFirst(sp.status_error);

  const [invoices, accounts, accountFilter, allOpps] = await Promise.all([
    listCommercialInvoices({ search, status: statusFilter, accountId: accountIdFilter }),
    listCommercialAccounts(),
    accountIdFilter ? getCommercialAccount(accountIdFilter) : Promise.resolve(null),
    listCommercialOpportunities({}),
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const oppById = new Map(allOpps.map((o) => [o.id, o]));
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
  const outstandingCents = kpiSource
    .filter((i) => BILLABLE_INVOICE_STATUSES.has(deriveInvoiceStatus(i)))
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
    if (viewMode !== "list") p.set("view", viewMode);
    return p.toString() ? `/commercial/invoices?${p.toString()}` : "/commercial/invoices";
  };
  const setStatusHref = (newStatus: InvoiceStatus | null): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (newStatus) p.set("status", newStatus);
    if (sortKey !== "recent") p.set("sort", sortKey);
    if (accountIdFilter) p.set("account_id", accountIdFilter);
    if (viewMode !== "list") p.set("view", viewMode);
    return p.toString() ? `/commercial/invoices?${p.toString()}` : "/commercial/invoices";
  };
  const setViewHref = (newView: ViewMode): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (statusFilter) p.set("status", statusFilter);
    if (sortKey !== "recent") p.set("sort", sortKey);
    if (accountIdFilter) p.set("account_id", accountIdFilter);
    if (newView !== "list") p.set("view", newView);
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
        <div className="bg-white border border-blue-200 rounded-xl px-4 py-3 text-sm text-ppp-charcoal-700 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
              Filtered
            </span>
            <span>
              Showing invoices for{" "}
              <Link
                href={`/commercial/accounts/${accountFilter.id}`}
                className="font-semibold text-blue-800 hover:underline"
              >
                {accountFilter.company_name}
              </Link>
            </span>
          </div>
          <Link
            href="/commercial/invoices"
            className="text-[12px] font-semibold text-blue-700 hover:text-blue-900 inline-flex items-center gap-1 min-h-[44px] px-3 touch-manipulation"
          >
            Show all invoices
            <span aria-hidden>→</span>
          </Link>
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
                    const existing = invoices.filter((i) => i.opportunity_id === o.id).length;
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
              placeholder="Search by invoice number…"
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

          {/* View toggle — List (default flat) vs Grouped (per opp).
              Karan 2026-07-07: "have the invoices for those in the
              invoice tab itself and don't automatically direct them to
              the opportunities tab, leave them in the invoices tab
              with the new layout for that specific opportunity." */}
          <div className="hidden md:inline-flex rounded-lg border border-ppp-charcoal-200 bg-white overflow-hidden shrink-0">
            <Link
              href={setViewHref("list")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1 touch-manipulation ${
                viewMode === "list"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="Show every invoice in one flat list"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18 M3 12h18 M3 18h18" />
              </svg>
              List
            </Link>
            <Link
              href={setViewHref("grouped")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1 touch-manipulation border-l border-ppp-charcoal-200 ${
                viewMode === "grouped"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="Group invoices under their parent opportunity — see roll-up + progress across the whole deal"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="6" rx="1" />
                <rect x="3" y="11" width="12" height="4" rx="1" />
                <rect x="3" y="17" width="12" height="4" rx="1" />
              </svg>
              By opp
            </Link>
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
              ? "Try clearing filters or searching by invoice number."
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
      ) : viewMode === "grouped" ? (
        // Grouped-by-opportunity view. Each opp becomes a card with its
        // own roll-up + child invoices, so users can see the full
        // progress-billing story per deal without leaving the invoices
        // page. Karan 2026-07-07: "don't automatically direct them to
        // the opportunities tab, leave them in the invoices tab with the
        // new layout for that specific opportunity."
        <GroupedByOpp
          invoices={sorted}
          oppById={oppById}
          accountById={accountById}
        />
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-bold text-ppp-charcoal">
              {sorted.length} invoice{sorted.length === 1 ? "" : "s"}
            </h2>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
              Sorted by {currentSortLabel.toLowerCase()}
            </p>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {sorted.map((inv) => (
              <InvoiceRow
                key={inv.id}
                invoice={inv}
                accountName={accountById.get(inv.account_id)?.company_name ?? "—"}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function GroupedByOpp({
  invoices,
  oppById,
  accountById,
}: {
  invoices: CommercialInvoice[];
  oppById: Map<string, { id: string; title: string; account_id: string; status: string }>;
  accountById: Map<string, { id: string; company_name: string }>;
}) {
  // Group invoices by opportunity_id. Preserve chronological order per
  // group so the story reads top-down (oldest → newest inside each opp).
  const groups = new Map<string, CommercialInvoice[]>();
  for (const inv of invoices) {
    const arr = groups.get(inv.opportunity_id) ?? [];
    arr.push(inv);
    groups.set(inv.opportunity_id, arr);
  }
  // Sort opps by most-recent invoice activity so the deals you're
  // actively billing bubble to the top.
  const oppOrder = Array.from(groups.entries()).sort((a, b) => {
    const aLatest = Math.max(...a[1].map((i) => new Date(i.created_at).getTime()));
    const bLatest = Math.max(...b[1].map((i) => new Date(i.created_at).getTime()));
    return bLatest - aLatest;
  });

  if (oppOrder.length === 0) {
    return (
      <div className="bg-ppp-charcoal-50/40 border border-ppp-charcoal-100 rounded-xl p-8 text-center">
        <p className="text-[13px] text-ppp-charcoal-600">No invoices to group.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {oppOrder.map(([oppId, groupInvoices]) => {
        const opp = oppById.get(oppId);
        const account = opp ? accountById.get(opp.account_id) : null;
        // Roll-up per opp — same rules as OpportunityInvoicesPanel:
        // exclude drafts + voids from billable totals so numbers reflect
        // real customer-facing billing.
        const billable = groupInvoices.filter((i) => i.status !== "draft" && i.status !== "void");
        const totalInvoiced = billable.reduce((s, i) => s + i.total_cents, 0);
        const totalPaid = billable.reduce((s, i) => s + i.paid_cents, 0);
        const totalBalance = totalInvoiced - totalPaid;
        const overduePresent = groupInvoices.some((i) => deriveInvoiceStatus(i) === "overdue");
        // Sort inside a group chronologically so progress-billing reads
        // in the order the invoices were issued.
        const sortedGroup = [...groupInvoices].sort((a, b) => a.created_at.localeCompare(b.created_at));
        return (
          <section
            key={oppId}
            className={`bg-white border rounded-xl overflow-hidden shadow-sm ${
              overduePresent ? "border-rose-200" : "border-ppp-charcoal-100"
            }`}
          >
            {/* Opp header — title + account + roll-up strip */}
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
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-100 border border-ppp-charcoal-200 rounded px-1.5 py-0.5">
                      {groupInvoices.length} invoice{groupInvoices.length === 1 ? "" : "s"}
                    </span>
                    {overduePresent && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800 bg-rose-100 border border-rose-300 rounded px-1.5 py-0.5">
                        Overdue
                      </span>
                    )}
                  </div>
                  {account && (
                    <div className="text-[12px] text-ppp-charcoal-600 mt-0.5">
                      <Link href={`/commercial/accounts/${account.id}`} className="text-blue-700 hover:text-blue-800 underline underline-offset-2">
                        {account.company_name}
                      </Link>
                    </div>
                  )}
                </div>
                {opp && opp.status === "won" && (
                  <Link
                    href={`/commercial/invoices/new?opp=${opp.id}`}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-cc-brand-200 bg-white text-cc-brand-700 text-[11.5px] font-semibold hover:bg-cc-brand-50 min-h-[36px] touch-manipulation"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 5v14 M5 12h14" />
                    </svg>
                    Add invoice
                  </Link>
                )}
              </div>
              {/* Mini roll-up strip */}
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
            </div>
            {/* Child invoices */}
            <ul className="divide-y divide-ppp-charcoal-100">
              {sortedGroup.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  accountName={account?.company_name ?? "—"}
                />
              ))}
            </ul>
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
