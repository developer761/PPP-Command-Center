/**
 * `/commercial/accounts` — Phase 1 Account Management list page.
 *
 * UI rebuild 2026-07-05 (Karan: "confusing and unorganized, needs to be
 * 100x better"). No features removed — every URL param, server action,
 * bulk operation, filter, sort, chip, row signal, and result banner
 * preserved 1:1. Only the visual organization changed. Backend data
 * flow + all lib calls untouched.
 *
 * Design principles applied:
 *   1. **One toolbar to rule them all.** Search + Filter (popover) +
 *      Sort (popover) + Clear + Export + New account all live in a
 *      single sticky row below the header. No scattered surfaces.
 *   2. **Progressive disclosure.** Bulk-action bar collapses behind a
 *      "Bulk actions ▾" toggle. Filter popover holds every filter
 *      (rating, compliance, industry, tag, quick chips). Recently
 *      Active section collapses into a details element.
 *   3. **Clean row hierarchy.** Primary line (name + rating + compliance
 *      + lapsed badge + key-relationship star). Muted meta line
 *      (industry · city · phone). Signal line (contacts · team · docs ·
 *      open bids · repeat · activity). Tag pill row at the bottom.
 *      Right chevron aligned to first line.
 *   4. **KPI strip = context.** Slim horizontal strip below the title
 *      showing total accounts + recently-active count + open-bid roll-up.
 *   5. **Mobile = 44px tap targets throughout + card layout.**
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  listCommercialAccounts,
  listCommercialAccountIndustries,
  type CommercialAccount,
} from "@/lib/commercial/accounts/db";
import {
  listAccountOverviews,
  relativeActivity,
  activityTone,
  formatBidCents,
  type AccountOverview,
} from "@/lib/commercial/accounts/overview";
import { SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS } from "@/lib/commercial/form-classnames";
import CommercialAccountsSearchAutocomplete from "@/components/commercial-accounts-search-autocomplete";
import {
  listTagsForAccounts,
  listAllDistinctTags,
  type AccountTag,
} from "@/lib/commercial/accounts/tags";
import {
  listAssignableStaff,
  ASSIGNMENT_ROLES,
  assignmentRoleLabel,
  type AssignmentRole,
} from "@/lib/commercial/accounts/assignments";
import { bulkTagAccounts, bulkAssignAccounts, BULK_MAX_ACCOUNTS } from "@/lib/commercial/accounts/bulk";
import {
  MS_PER_DAY,
  ACTIVITY_STALE_DAYS,
  RECENT_WINDOW_DAYS,
} from "@/lib/commercial/accounts/constants";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Returns only the entries from formData.getAll("account_id") that look
 *  like valid UUIDs. Caps the list at BULK_MAX_ACCOUNTS. */
function pickSelectedAccountIds(formData: FormData): string[] {
  const raw = formData.getAll("account_id");
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    if (!UUID_RE.test(v)) continue;
    out.push(v);
    if (out.length >= BULK_MAX_ACCOUNTS) break;
  }
  return out;
}

async function bulkTagAccountsAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const tag = String(formData.get("bulk_tag") ?? "");
  const selected = pickSelectedAccountIds(formData);
  if (selected.length === 0) {
    redirect("/commercial/accounts?bulk_error=" + encodeURIComponent("Select at least one account first."));
  }
  if (!tag.trim()) {
    redirect("/commercial/accounts?bulk_error=" + encodeURIComponent("Type a tag to apply."));
  }
  const res = await bulkTagAccounts(selected, tag, user.id);
  const msg = `Tagged ${res.succeeded} of ${res.total} accounts${res.failed ? ` (${res.failed} failed)` : ""}.`;
  redirect("/commercial/accounts?bulk_result=" + encodeURIComponent(msg));
}

async function bulkAssignAccountsAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const user_id = String(formData.get("bulk_user_id") ?? "");
  const role = String(formData.get("bulk_role") ?? "") as AssignmentRole;
  const selected = pickSelectedAccountIds(formData);
  if (selected.length === 0) {
    redirect("/commercial/accounts?bulk_error=" + encodeURIComponent("Select at least one account first."));
  }
  if (!UUID_RE.test(user_id)) {
    redirect("/commercial/accounts?bulk_error=" + encodeURIComponent("Pick a PPP staff member."));
  }
  if (!ASSIGNMENT_ROLES.includes(role)) {
    redirect("/commercial/accounts?bulk_error=" + encodeURIComponent("Pick a role."));
  }
  const res = await bulkAssignAccounts(selected, { user_id, role }, user.id);
  const msg = `Assigned ${res.succeeded} of ${res.total} accounts${res.failed ? ` (${res.failed} failed)` : ""}.`;
  redirect("/commercial/accounts?bulk_result=" + encodeURIComponent(msg));
}

type SP = Promise<Record<string, string | string[] | undefined>>;

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

export default async function CommercialAccountsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const search = pickFirst(sp.q);
  const justDeleted = pickFirst(sp.deleted) === "1";
  const rating = pickFirst(sp.rating) as "A" | "B" | "C" | undefined;
  const compliance = pickFirst(sp.compliance) as
    | "green"
    | "yellow"
    | "red"
    | "not_started"
    | undefined;
  const industry = pickFirst(sp.industry);
  const tagFilter = pickFirst(sp.tag);
  const sortRaw = pickFirst(sp.sort) ?? "created_desc";
  const SORT_OPTIONS = [
    { value: "created_desc", label: "Newest first" },
    { value: "created_asc", label: "Oldest first" },
    { value: "name_asc", label: "Name A→Z" },
    { value: "name_desc", label: "Name Z→A" },
    { value: "activity_desc", label: "Most recently active" },
    { value: "activity_asc", label: "Most stale" },
    { value: "rating_asc", label: "Rating (A first)" },
  ] as const;
  const sort = (SORT_OPTIONS.some((o) => o.value === sortRaw) ? sortRaw : "created_desc") as
    (typeof SORT_OPTIONS)[number]["value"];
  const filterStale = pickFirst(sp.stale) === "1";
  const filterExpiring = pickFirst(sp.expiring) === "1";
  const filterIssue = pickFirst(sp.issue) === "1";

  const [accountsRaw, industries, assignableStaff] = await Promise.all([
    listCommercialAccounts({ search, rating, compliance, industry }),
    listCommercialAccountIndustries(),
    listAssignableStaff(),
  ]);
  const bulkResult = pickFirst(sp.bulk_result);
  const bulkError = pickFirst(sp.bulk_error);
  const [overviewsById, tagsByAccount, allTags] = await Promise.all([
    listAccountOverviews(accountsRaw.map((a) => a.id)),
    listTagsForAccounts(accountsRaw.map((a) => a.id)),
    listAllDistinctTags(),
  ]);

  // Apply quick-filter chips post-fetch using the overview data.
  let accounts = accountsRaw.slice();
  if (filterStale) {
    accounts = accounts.filter((a) => {
      const ov = overviewsById.get(a.id);
      if (!ov) return false;
      const days = Math.floor((Date.now() - new Date(ov.last_activity_at).getTime()) / MS_PER_DAY);
      return Number.isFinite(days) && days > ACTIVITY_STALE_DAYS;
    });
  }
  if (filterExpiring) {
    accounts = accounts.filter((a) => {
      const ov = overviewsById.get(a.id);
      return ov ? ov.expired_document_count + ov.expiring_soon_document_count > 0 : false;
    });
  }
  if (filterIssue) {
    accounts = accounts.filter((a) => {
      if (a.vendor_compliance_status === "red") return true;
      const ov = overviewsById.get(a.id);
      return ov ? ov.expired_document_count > 0 : false;
    });
  }
  if (tagFilter) {
    const lower = tagFilter.toLowerCase();
    accounts = accounts.filter((a) => {
      const tags = tagsByAccount.get(a.id) ?? [];
      return tags.some((t) => t.tag.toLowerCase() === lower);
    });
  }

  accounts.sort((a, b) => {
    switch (sort) {
      case "created_desc":
        return b.created_at.localeCompare(a.created_at);
      case "created_asc":
        return a.created_at.localeCompare(b.created_at);
      case "name_asc":
        return a.company_name.localeCompare(b.company_name);
      case "name_desc":
        return b.company_name.localeCompare(a.company_name);
      case "activity_desc": {
        const ax = overviewsById.get(a.id)?.last_activity_at ?? a.created_at;
        const bx = overviewsById.get(b.id)?.last_activity_at ?? b.created_at;
        return bx.localeCompare(ax);
      }
      case "activity_asc": {
        const ax = overviewsById.get(a.id)?.last_activity_at ?? a.created_at;
        const bx = overviewsById.get(b.id)?.last_activity_at ?? b.created_at;
        return ax.localeCompare(bx);
      }
      case "rating_asc": {
        const order: Record<string, number> = { A: 0, B: 1, C: 2 };
        const ar = a.rating ? order[a.rating] ?? 9 : 9;
        const br = b.rating ? order[b.rating] ?? 9 : 9;
        return ar - br || a.company_name.localeCompare(b.company_name);
      }
      default:
        return 0;
    }
  });

  // Recently active pre-fetch (unchanged from prior behavior).
  const recentlyActive = accountsRaw
    .map((a) => ({ account: a, ov: overviewsById.get(a.id) }))
    .filter(({ ov }) => {
      if (!ov) return false;
      const days = Math.floor((Date.now() - new Date(ov.last_activity_at).getTime()) / MS_PER_DAY);
      return Number.isFinite(days) && days <= RECENT_WINDOW_DAYS;
    })
    .sort((x, y) => {
      const xt = x.ov?.last_activity_at ?? "";
      const yt = y.ov?.last_activity_at ?? "";
      return yt.localeCompare(xt);
    })
    .slice(0, 3);

  // KPI strip — computed once from the pre-filter overview data so the
  // top-of-page numbers reflect the full account universe, not the
  // filtered slice. Alex sees "we have N accounts overall" no matter
  // what filter he's applied below.
  const universeCount = accountsRaw.length;
  const recentlyActiveCount = recentlyActive.length;
  const overviewList = Array.from(overviewsById.values());
  const openBidsAcrossBook = overviewList.reduce((acc, o) => acc + (o.open_opps_count ?? 0), 0);
  const totalActiveBidLowCents = overviewList.reduce((acc, o) => acc + (o.total_active_bid_low_cents ?? 0), 0);
  const totalActiveBidHighCents = overviewList.reduce((acc, o) => acc + (o.total_active_bid_high_cents ?? 0), 0);
  const bookBidRange = formatBidCents(totalActiveBidLowCents, totalActiveBidHighCents);

  // URL builders (unchanged behavior — link helpers for chip toggles + sort).
  const baseParams = new URLSearchParams();
  if (search) baseParams.set("q", search);
  if (rating) baseParams.set("rating", rating);
  if (compliance) baseParams.set("compliance", compliance);
  if (industry) baseParams.set("industry", industry);
  if (tagFilter) baseParams.set("tag", tagFilter);
  if (sort !== "created_desc") baseParams.set("sort", sort);
  const toggleChipHref = (param: "stale" | "expiring" | "issue", currentlyOn: boolean): string => {
    const p = new URLSearchParams(baseParams);
    if (filterStale && param !== "stale") p.set("stale", "1");
    if (filterExpiring && param !== "expiring") p.set("expiring", "1");
    if (filterIssue && param !== "issue") p.set("issue", "1");
    if (!currentlyOn) p.set(param, "1");
    const qs = p.toString();
    return qs ? `/commercial/accounts?${qs}` : "/commercial/accounts";
  };
  const setSortHref = (newSort: string): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (rating) p.set("rating", rating);
    if (compliance) p.set("compliance", compliance);
    if (industry) p.set("industry", industry);
    if (tagFilter) p.set("tag", tagFilter);
    if (filterStale) p.set("stale", "1");
    if (filterExpiring) p.set("expiring", "1");
    if (filterIssue) p.set("issue", "1");
    if (newSort !== "created_desc") p.set("sort", newSort);
    const qs = p.toString();
    return qs ? `/commercial/accounts?${qs}` : "/commercial/accounts";
  };
  // Chip-clear links — link to /commercial/accounts?X= (empty) which
  // drops that single filter while preserving the rest. Used inside the
  // "Active filters" chip row.
  const clearFilterHref = (drop: "q" | "rating" | "compliance" | "industry" | "tag" | "stale" | "expiring" | "issue"): string => {
    const p = new URLSearchParams();
    if (search && drop !== "q") p.set("q", search);
    if (rating && drop !== "rating") p.set("rating", rating);
    if (compliance && drop !== "compliance") p.set("compliance", compliance);
    if (industry && drop !== "industry") p.set("industry", industry);
    if (tagFilter && drop !== "tag") p.set("tag", tagFilter);
    if (filterStale && drop !== "stale") p.set("stale", "1");
    if (filterExpiring && drop !== "expiring") p.set("expiring", "1");
    if (filterIssue && drop !== "issue") p.set("issue", "1");
    if (sort !== "created_desc") p.set("sort", sort);
    const qs = p.toString();
    return qs ? `/commercial/accounts?${qs}` : "/commercial/accounts";
  };
  const anyFilterActive = !!search || !!rating || !!compliance || !!industry || !!tagFilter || filterStale || filterExpiring || filterIssue;
  const activeFilterCount =
    (search ? 1 : 0) + (rating ? 1 : 0) + (compliance ? 1 : 0) +
    (industry ? 1 : 0) + (tagFilter ? 1 : 0) +
    (filterStale ? 1 : 0) + (filterExpiring ? 1 : 0) + (filterIssue ? 1 : 0);
  const sortChanged = sort !== "created_desc";
  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Newest first";

  const exportParams = new URLSearchParams();
  if (search) exportParams.set("q", search);
  if (rating) exportParams.set("rating", rating);
  if (compliance) exportParams.set("compliance", compliance);
  if (industry) exportParams.set("industry", industry);
  const exportQs = exportParams.toString();

  return (
    <div className="space-y-5">
      {/* ─── Hero: PageHeader-shape title with the 3px×40px red accent
          bar, then a slim KPI strip below with the book-level metrics.
          Right side: Export CSV (only if we have rows) + New account
          primary CTA. ─── */}
      <header className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
              Accounts
            </h1>
            <p className="mt-1 text-sm text-ppp-charcoal-500">
              The companies PPP works with. Every commercial project starts on an account.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {accounts.length > 0 && (
              <a
                href={`/api/commercial/accounts/export${exportQs ? `?${exportQs}` : ""}`}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal text-sm font-semibold hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors touch-manipulation min-h-[44px] shadow-sm"
                title="Download the visible list as CSV"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
                </svg>
                Export CSV
              </a>
            )}
            <Link
              href="/commercial/accounts/new"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors touch-manipulation shadow-sm shadow-cc-brand-600/30 min-h-[44px]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New account
            </Link>
          </div>
        </div>

        {/* KPI strip — book-level numbers. Slim horizontal strip, not
            full tiles. Context, not the hero. Red accent stripe on the
            primary metric; blue on supporting. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            tone="cc-brand"
            label="Total accounts"
            value={universeCount.toLocaleString()}
            sub={universeCount === 1 ? "in your book" : "in your book"}
          />
          <KpiCard
            tone="blue"
            label="Recently active"
            value={recentlyActiveCount.toLocaleString()}
            sub={`in the last ${RECENT_WINDOW_DAYS} days`}
          />
          <KpiCard
            tone="blue"
            label="Open bids"
            value={openBidsAcrossBook.toLocaleString()}
            sub={openBidsAcrossBook === 0 ? "no live bids" : "across the book"}
          />
          <KpiCard
            tone="neutral"
            label="Bid range"
            value={bookBidRange !== "—" ? bookBidRange : "—"}
            sub={bookBidRange !== "—" ? "low–high across open bids" : "log a bid to see totals"}
          />
        </div>
      </header>

      {/* ─── Banner strip — deleted / bulk result / bulk error all in
          one spot so the layout doesn't jump around. ─── */}
      {(justDeleted || bulkResult || bulkError) && (
        <div className="space-y-2">
          {justDeleted && (
            <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-3 text-sm text-cc-brand-800 flex items-start gap-2">
              <span aria-hidden>✓</span>
              <span className="flex-1">
                Account deleted.
              </span>
            </div>
          )}
          {bulkResult && (
            <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-3 text-sm text-cc-brand-800 flex items-start justify-between gap-3">
              <span className="flex-1">{bulkResult}</span>
              <Link
                href="/commercial/accounts"
                className="text-[12px] text-cc-brand-700 hover:text-cc-brand-800 underline shrink-0 min-h-[24px] inline-flex items-center"
                aria-label="Dismiss banner"
              >
                Dismiss
              </Link>
            </div>
          )}
          {bulkError && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800 flex items-start justify-between gap-3">
              <span className="flex-1">{bulkError}</span>
              <Link
                href="/commercial/accounts"
                className="text-[12px] text-rose-700 hover:text-rose-900 underline shrink-0 min-h-[24px] inline-flex items-center"
                aria-label="Dismiss banner"
              >
                Dismiss
              </Link>
            </div>
          )}
        </div>
      )}

      {/* ─── Toolbar: single row. Search + Filter popover + Sort popover
          + Clear. Everything the user does BEFORE looking at rows lives
          here. Sticky-safe (regular flow; not position:sticky to keep
          the header interactive on mobile). ─── */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 space-y-3">
        <form className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[200px]">
            <CommercialAccountsSearchAutocomplete defaultValue={search ?? ""} />
          </div>

          {/* Filter popover — every filter (rating, compliance, industry,
              tag, 3 chips) lives here. Native <details> for zero-JS state. */}
          <details className="relative inline-block group">
            <summary
              className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[13px] font-semibold min-h-[44px] touch-manipulation transition-colors ${
                activeFilterCount > 0
                  ? "bg-cc-brand-50 border-cc-brand-200 text-cc-brand-700 hover:bg-cc-brand-100"
                  : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
              </svg>
              <span>Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</span>
              <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="absolute right-0 sm:right-auto mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-4 min-w-[300px] sm:min-w-[420px] max-w-[calc(100vw-1rem)] max-h-[75vh] overflow-y-auto space-y-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-2">
                  Attributes
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="rating" className={LABEL_CLS}>Rating</label>
                    <select
                      id="rating"
                      name="rating"
                      defaultValue={rating ?? ""}
                      form="accounts-filter-form"
                      className={SELECT_CLS}
                      style={SELECT_BG_STYLE}
                    >
                      <option value="">All ratings</option>
                      <option value="A">A</option>
                      <option value="B">B</option>
                      <option value="C">C</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="compliance" className={LABEL_CLS}>Compliance</label>
                    <select
                      id="compliance"
                      name="compliance"
                      defaultValue={compliance ?? ""}
                      form="accounts-filter-form"
                      className={SELECT_CLS}
                      style={SELECT_BG_STYLE}
                    >
                      <option value="">All statuses</option>
                      <option value="green">Green</option>
                      <option value="yellow">Yellow</option>
                      <option value="red">Red</option>
                      <option value="not_started">Not started</option>
                    </select>
                  </div>
                  {industries.length > 0 && (
                    <div>
                      <label htmlFor="industry" className={LABEL_CLS}>Industry</label>
                      <select
                        id="industry"
                        name="industry"
                        defaultValue={industry ?? ""}
                        form="accounts-filter-form"
                        className={SELECT_CLS}
                        style={SELECT_BG_STYLE}
                      >
                        <option value="">All industries</option>
                        {industries.map((ind) => (
                          <option key={ind} value={ind}>{ind}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {allTags.length > 0 && (
                    <div>
                      <label htmlFor="tag" className={LABEL_CLS}>Tag</label>
                      <select
                        id="tag"
                        name="tag"
                        defaultValue={tagFilter ?? ""}
                        form="accounts-filter-form"
                        className={SELECT_CLS}
                        style={SELECT_BG_STYLE}
                      >
                        <option value="">All tags</option>
                        {allTags.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  form="accounts-filter-form"
                  className="mt-3 w-full inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors touch-manipulation shadow-sm shadow-cc-brand-600/30 min-h-[44px]"
                >
                  Apply filters
                </button>
              </div>

              <div className="border-t border-ppp-charcoal-100 pt-3">
                <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-2">
                  Quick filters
                </div>
                <div className="space-y-1">
                  <FilterOption
                    href={toggleChipHref("stale", filterStale)}
                    active={filterStale}
                    label={`Stale > ${ACTIVITY_STALE_DAYS} days`}
                    description={`No update (contact / doc / team / opp) in over ${ACTIVITY_STALE_DAYS} days. Worth a follow-up call.`}
                  />
                  <FilterOption
                    href={toggleChipHref("expiring", filterExpiring)}
                    active={filterExpiring}
                    label="Has expiring docs"
                    description="At least one active doc set to expire in the next 30 days."
                  />
                  <FilterOption
                    href={toggleChipHref("issue", filterIssue)}
                    active={filterIssue}
                    label="Compliance issue"
                    description="Flagged red on vendor compliance — paperwork missing or rejected."
                  />
                </div>
              </div>
            </div>
          </details>

          {/* Sort popover — 7 radio-style options. */}
          <details className="relative inline-block group">
            <summary
              className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[13px] font-semibold min-h-[44px] touch-manipulation transition-colors ${
                sortChanged
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
              <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 pt-2 pb-1">
                Sort by
              </div>
              <div className="space-y-0.5">
                {SORT_OPTIONS.map((o) => (
                  <SortOption
                    key={o.value}
                    href={setSortHref(o.value)}
                    active={sort === o.value}
                    label={o.label}
                  />
                ))}
              </div>
            </div>
          </details>

          {anyFilterActive && (
            <Link
              href="/commercial/accounts"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-600 text-[12px] font-medium hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6L6 18 M6 6l12 12" />
              </svg>
              Clear
            </Link>
          )}
        </form>

        {/* Hidden form target for the Filter popover's Apply — outside
            the popover so the browser can submit even when the popover
            closes on click. Preserves current filter state on submit. */}
        <form id="accounts-filter-form" className="hidden">
          {search && <input type="hidden" name="q" value={search} />}
          {sort !== "created_desc" && <input type="hidden" name="sort" value={sort} />}
          {filterStale && <input type="hidden" name="stale" value="1" />}
          {filterExpiring && <input type="hidden" name="expiring" value="1" />}
          {filterIssue && <input type="hidden" name="issue" value="1" />}
        </form>

        {/* Active filter chip row — shows what's applied so it's easy to
            drop one. Each chip is a link to the URL WITHOUT that filter.
            Hidden when nothing's active. */}
        {anyFilterActive && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">
              Applied:
            </span>
            {search && <ActiveFilterChip href={clearFilterHref("q")} label={`Search: "${search}"`} />}
            {rating && <ActiveFilterChip href={clearFilterHref("rating")} label={`Rating ${rating}`} />}
            {compliance && <ActiveFilterChip href={clearFilterHref("compliance")} label={`Compliance: ${compliance.replace("_", " ")}`} />}
            {industry && <ActiveFilterChip href={clearFilterHref("industry")} label={`Industry: ${industry}`} />}
            {tagFilter && <ActiveFilterChip href={clearFilterHref("tag")} label={`Tag: ${tagFilter}`} />}
            {filterStale && <ActiveFilterChip href={clearFilterHref("stale")} label={`Stale > ${ACTIVITY_STALE_DAYS}d`} />}
            {filterExpiring && <ActiveFilterChip href={clearFilterHref("expiring")} label="Expiring docs" />}
            {filterIssue && <ActiveFilterChip href={clearFilterHref("issue")} label="Compliance issue" />}
          </div>
        )}
      </div>

      {/* ─── Recently active — compact collapsible details. Only renders
          when there are no filters + at least one recent match, same as
          before. Cleaner header, same 3-card body. ─── */}
      {!anyFilterActive && recentlyActive.length > 0 && (
        <details className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden group">
          <summary className="list-none cursor-pointer px-4 py-3 flex items-center justify-between gap-3 hover:bg-ppp-charcoal-50 transition-colors touch-manipulation">
            <div className="flex items-center gap-2 min-w-0">
              <span aria-hidden className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-cc-brand-50 text-cc-brand-700 shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-ppp-charcoal">
                  Recently active
                </div>
                <div className="text-[11px] text-ppp-charcoal-500">
                  {recentlyActive.length} account{recentlyActive.length === 1 ? "" : "s"} touched in the last {RECENT_WINDOW_DAYS} days
                </div>
              </div>
            </div>
            <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform text-lg">▾</span>
          </summary>
          <div className="px-4 pb-4 pt-1 border-t border-ppp-charcoal-100">
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {recentlyActive.map(({ account, ov }) => {
                const days = ov
                  ? Math.floor((Date.now() - new Date(ov.last_activity_at).getTime()) / MS_PER_DAY)
                  : null;
                const label =
                  days === null ? "—" : days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
                return (
                  <li key={account.id}>
                    <Link
                      href={`/commercial/accounts/${account.id}`}
                      className="block border border-ppp-charcoal-100 rounded-lg px-3 py-2.5 hover:border-cc-brand-300 hover:bg-cc-brand-50/40 transition-colors touch-manipulation min-h-[44px]"
                    >
                      <div className="text-sm font-semibold text-ppp-charcoal truncate">
                        {account.company_name}
                      </div>
                      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">
                        {account.industry ?? "—"} · Active {label}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </details>
      )}

      {/* ─── List / empty state ─── */}
      {accounts.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-12 text-center">
          <div aria-hidden className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="1" />
              <path d="M9 22v-4h6v4 M8 6h2 M14 6h2 M8 10h2 M14 10h2 M8 14h2 M14 14h2" />
            </svg>
          </div>
          <div className="text-sm font-semibold text-ppp-charcoal">
            {anyFilterActive ? "No accounts match these filters" : "No accounts yet"}
          </div>
          <p className="mt-1 text-sm text-ppp-charcoal-500">
            {anyFilterActive
              ? "Try clearing a filter or two, or use search to find a specific company."
              : "Add your first commercial account to get started."}
          </p>
          {!anyFilterActive ? (
            <Link
              href="/commercial/accounts/new"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New account
            </Link>
          ) : (
            <Link
              href="/commercial/accounts"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              Clear all filters
            </Link>
          )}
        </div>
      ) : (
        <form className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          {/* List header + progressive-disclosure Bulk Actions. Was
              always-visible bar (busy); now behind a <details> so the
              default view is quiet. Server actions + form fields are
              byte-identical to the prior implementation. */}
          <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-bold text-ppp-charcoal">
                {accounts.length} account{accounts.length === 1 ? "" : "s"}
                {universeCount !== accounts.length && (
                  <span className="ml-1.5 text-[12px] font-medium text-ppp-charcoal-500">
                    of {universeCount}
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                Sorted by {currentSortLabel.toLowerCase()}
              </p>
            </div>
            <details className="group">
              <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[36px] touch-manipulation">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
                </svg>
                Bulk actions
                <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="absolute right-4 sm:right-6 mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-4 min-w-[280px] max-w-[420px] space-y-4">
                <p className="text-[11px] text-ppp-charcoal-500 leading-snug">
                  Check the box next to each row, then use one of the actions below to tag or assign in one submit. Limit: {BULK_MAX_ACCOUNTS} accounts per action.
                </p>
                <div className="space-y-2">
                  <label htmlFor="bulk_tag" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500">
                    Tag selected
                  </label>
                  <input
                    id="bulk_tag"
                    name="bulk_tag"
                    type="text"
                    placeholder="e.g. Q3-outreach"
                    maxLength={50}
                    className={SELECT_CLS}
                    style={SELECT_BG_STYLE}
                  />
                  <button
                    type="submit"
                    formAction={bulkTagAccountsAction}
                    className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px]"
                  >
                    Apply tag
                  </button>
                </div>
                {assignableStaff.length > 0 && (
                  <div className="border-t border-ppp-charcoal-100 pt-3 space-y-2">
                    <label htmlFor="bulk_user_id" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500">
                      Assign staff to selected
                    </label>
                    <select
                      id="bulk_user_id"
                      name="bulk_user_id"
                      defaultValue=""
                      required
                      className={SELECT_CLS}
                      style={SELECT_BG_STYLE}
                    >
                      <option value="">Pick staff</option>
                      {assignableStaff.map((p) => (
                        <option key={p.user_id} value={p.user_id}>
                          {p.full_name ?? p.email}
                        </option>
                      ))}
                    </select>
                    <select
                      id="bulk_role"
                      name="bulk_role"
                      defaultValue=""
                      required
                      className={SELECT_CLS}
                      style={SELECT_BG_STYLE}
                    >
                      <option value="">Pick role</option>
                      {ASSIGNMENT_ROLES.map((r) => (
                        <option key={r} value={r}>{assignmentRoleLabel(r)}</option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      formAction={bulkAssignAccountsAction}
                      className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px]"
                    >
                      Assign
                    </button>
                  </div>
                )}
              </div>
            </details>
          </div>

          <ul className="divide-y divide-ppp-charcoal-100">
            {accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                overview={overviewsById.get(a.id) ?? null}
                tags={tagsByAccount.get(a.id) ?? []}
              />
            ))}
          </ul>
        </form>
      )}
    </div>
  );
}

/**
 * Slim KPI card — book-level metric. Left accent stripe (3px) matches
 * the PageHeader shape used everywhere. Not a full tile; not a bare
 * number. Sits between the two in visual weight.
 */
function KpiCard({
  tone,
  label,
  value,
  sub,
}: {
  tone: "cc-brand" | "blue" | "neutral";
  label: string;
  value: string;
  sub: string;
}) {
  const ring =
    tone === "cc-brand"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-cc-brand-50/50"
      : tone === "blue"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-blue-50/50"
      : "border-ppp-charcoal-100 bg-white";
  const stripe =
    tone === "cc-brand" ? "bg-cc-brand-600" : tone === "blue" ? "bg-cc-brand-500" : "bg-ppp-charcoal-200";
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

/**
 * One-click "remove this specific filter" chip. Shows in the toolbar's
 * Applied strip so users can drop a single filter without opening the
 * popover or clicking Clear (which drops ALL filters).
 */
function ActiveFilterChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-cc-brand-50 border border-cc-brand-200 text-cc-brand-700 text-[11px] font-semibold hover:bg-cc-brand-100 transition-colors min-h-[28px] touch-manipulation"
      title={`Remove filter: ${label}`}
    >
      <span className="truncate max-w-[180px]">{label}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18 6L6 18 M6 6l12 12" />
      </svg>
    </Link>
  );
}

function SortOption({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg min-h-[40px] touch-manipulation transition-colors ${
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
        {label}
      </span>
    </Link>
  );
}

function FilterOption({
  href,
  active,
  label,
  description,
}: {
  href: string;
  active: boolean;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg min-h-[44px] touch-manipulation transition-colors ${
        active ? "bg-cc-brand-50 hover:bg-cc-brand-100" : "hover:bg-ppp-charcoal-50"
      }`}
    >
      <span
        className={`mt-0.5 inline-flex items-center justify-center h-4 w-4 rounded border shrink-0 ${
          active ? "bg-cc-brand-600 border-cc-brand-700 text-white" : "bg-white border-ppp-charcoal-300 text-transparent"
        }`}
        aria-hidden
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-semibold ${active ? "text-cc-brand-800" : "text-ppp-charcoal"}`}>
          {label}
        </div>
        <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 leading-snug">
          {description}
        </p>
      </div>
    </Link>
  );
}

/**
 * Account row. Same data as before, reorganized into a clean 3-line
 * hierarchy: primary (name + badges + ★), meta (industry · city · phone),
 * signals (contacts · team · docs · bids · activity), tag pill row.
 * Right chevron aligns to the first line. Checkbox on left is native
 * form submission — no JS state.
 */
function AccountRow({
  account,
  overview,
  tags,
}: {
  account: CommercialAccount;
  overview: AccountOverview | null;
  tags: AccountTag[];
}) {
  const cityState = [account.billing_city, account.billing_state].filter(Boolean).join(", ");
  const activity = overview ? relativeActivity(overview.last_activity_at) : null;
  const tone = overview ? activityTone(overview.last_activity_at) : null;
  // Karan 2026-07-08 GHL-style: activity chip now has bg + border to
  // match the other SignalPill chips. Old text-only rendering read as
  // "extra grey noise" at the end of the row; this makes it a proper
  // freshness signal that scans as important at a glance.
  const activityCls =
    tone === "ok"
      ? "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200"
      : tone === "stale"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : tone === "cold"
      ? "bg-rose-50 text-rose-800 border-rose-200"
      : "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200";
  const visibleTags = tags.slice(0, 4);
  const extraTagCount = Math.max(0, tags.length - visibleTags.length);
  return (
    <li className="flex items-start gap-1 hover:bg-cc-brand-50/30 transition-colors group/row">
      {/* Checkbox — big tap area, sits OUTSIDE the Link so clicking it
          doesn't navigate. Label wraps for wider tap. */}
      <label className="pl-3 sm:pl-4 pt-5 cursor-pointer touch-manipulation shrink-0">
        <input
          type="checkbox"
          name="account_id"
          value={account.id}
          aria-label={`Select ${account.company_name} for bulk actions`}
          className="w-4 h-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-600/40 cursor-pointer"
        />
      </label>

      <Link
        href={`/commercial/accounts/${account.id}`}
        className="flex-1 block pr-3 sm:pr-4 py-4 touch-manipulation min-w-0"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Line 1 — company name + status badges. Bigger typography
                than the meta lines so scanning finds the name fast. */}
            <div className="flex items-center gap-2 flex-wrap">
              {account.is_key_relationship && (
                <span
                  className="inline-flex items-center text-amber-500 text-base leading-none"
                  title="★ Key Relationship — strategic partnership"
                  aria-label="Key Relationship"
                >
                  ★
                </span>
              )}
              <span className="font-bold text-ppp-charcoal text-[15px] leading-tight">
                {account.company_name}
              </span>
              {account.dba && (
                <span className="text-[11px] text-ppp-charcoal-500">d/b/a {account.dba}</span>
              )}
              {account.rating && <RatingPill rating={account.rating} />}
              {account.vendor_compliance_status && (
                <CompliancePill status={account.vendor_compliance_status} />
              )}
              {overview && overview.expired_document_count > 0 ? (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-rose-100 text-rose-800 border border-rose-200"
                  title={`${overview.expired_document_count} expired compliance doc${overview.expired_document_count === 1 ? "" : "s"}`}
                >
                  Lapsed
                </span>
              ) : overview && overview.expiring_soon_document_count > 0 ? (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200"
                  title={`${overview.expiring_soon_document_count} doc${overview.expiring_soon_document_count === 1 ? "" : "s"} expiring within 30 days`}
                >
                  Expiring
                </span>
              ) : null}
            </div>

            {/* Line 2 — muted meta: industry · city · phone. */}
            {(account.industry || cityState || account.phone) && (
              <div className="text-[12px] text-ppp-charcoal-500 mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                {account.industry && <span>{account.industry}</span>}
                {account.industry && cityState && <span aria-hidden>·</span>}
                {cityState && <span>{cityState}</span>}
                {account.phone && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{account.phone}</span>
                  </>
                )}
              </div>
            )}

            {/* Line 3 — Account 360 signals: contacts, team, docs, open
                bids, ★ repeat, activity. Same data as the prior row's
                stats row but with cleaner visual grouping. */}
            {overview && (
              <div className="text-[12px] mt-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-ppp-charcoal-600">
                <SignalPill icon="contacts" label={`${overview.contact_count} contact${overview.contact_count === 1 ? "" : "s"}`} />
                <SignalPill icon="team" label={`${overview.ppp_team_count} on team`} />
                <SignalPill
                  icon="docs"
                  label={`${overview.active_document_count} doc${overview.active_document_count === 1 ? "" : "s"}`}
                  tone={
                    overview.expired_document_count > 0
                      ? "rose"
                      : overview.expiring_soon_document_count > 0
                      ? "amber"
                      : "neutral"
                  }
                  suffix={
                    overview.expired_document_count > 0
                      ? ` · ${overview.expired_document_count} expired`
                      : overview.expiring_soon_document_count > 0
                      ? ` · ${overview.expiring_soon_document_count} expiring`
                      : undefined
                  }
                />
                {(overview.open_opps_count ?? 0) > 0 && (
                  <SignalPill
                    icon="bids"
                    tone="blue"
                    label={(() => {
                      const bidRange = formatBidCents(
                        overview.total_active_bid_low_cents,
                        overview.total_active_bid_high_cents
                      );
                      const base = `${overview.open_opps_count} open bid${overview.open_opps_count === 1 ? "" : "s"}`;
                      return bidRange !== "—" ? `${base} · ${bidRange}` : base;
                    })()}
                  />
                )}
                {(overview.won_opps_count ?? 0) > 0 && (
                  <SignalPill
                    icon="star"
                    tone="amber"
                    label="Repeat customer"
                    title={`PPP has won ${overview.won_opps_count} bid${overview.won_opps_count === 1 ? "" : "s"} with this account.`}
                  />
                )}
                {activity && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${activityCls}`}
                    title={`Last touched: ${overview.last_activity_at ?? "unknown"}`}
                  >
                    {(() => {
                      // Karan 2026-07-08 GHL-style: subtle pulse dot when
                      // the account was touched within the last 7 days
                      // ("hot"), solid dot for older activity. Makes the
                      // freshness signal readable at a glance.
                      const isHot = overview.last_activity_at
                        ? Date.now() - new Date(overview.last_activity_at).getTime() < 7 * 24 * 60 * 60 * 1000
                        : false;
                      return (
                        <span aria-hidden className="relative inline-flex w-1.5 h-1.5">
                          {isHot && (
                            <span className="absolute inline-flex w-full h-full rounded-full bg-current opacity-60 animate-ping" />
                          )}
                          <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-current" />
                        </span>
                      );
                    })()}
                    Active {activity}
                  </span>
                )}
              </div>
            )}

            {/* Line 4 — tag pills. Only renders when there are tags. */}
            {tags.length > 0 && (
              <div className="mt-2 flex items-center gap-1 flex-wrap">
                {visibleTags.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center px-2 py-0.5 rounded-full bg-cc-brand-50 text-cc-brand-700 border border-cc-brand-200 text-[10px] font-medium"
                  >
                    {t.tag}
                  </span>
                ))}
                {extraTagCount > 0 && (
                  <span className="text-[10px] text-ppp-charcoal-500 px-1">+{extraTagCount} more</span>
                )}
              </div>
            )}
          </div>

          {/* Right chevron — navigation hint. Aligns to the first line. */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 group-hover/row:text-cc-brand-600 shrink-0 mt-1 transition-colors" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </Link>
    </li>
  );
}

/**
 * Reusable signal pill for the Account row's stats line. Colored tint
 * for meaningful signals (open bids = blue, repeat = amber, docs with
 * expired = rose). Neutral for the plain counts.
 */
/**
 * Karan 2026-07-08: GHL-style upgrade. Old pills were flat text with an
 * emoji prefix; the row read as "grey noise." New pill is a proper
 * chip with a background tint + stroke icon + monospace count so the
 * row scans like a status band, not a paragraph.
 */
function SignalIcon({ kind }: { kind: "contacts" | "team" | "docs" | "bids" | "star" }) {
  const strokeProps = {
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "contacts")
    return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
  if (kind === "team")
    return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}><path d="M12 2 4 6v6c0 4.4 3.6 8 8 10 4.4-2 8-5.6 8-10V6l-8-4z" /></svg>;
  if (kind === "docs")
    return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" /></svg>;
  if (kind === "bids")
    return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>;
  return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...strokeProps}><path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>;
}

function SignalPill({
  icon,
  label,
  suffix,
  tone,
  title,
}: {
  icon: "contacts" | "team" | "docs" | "bids" | "star";
  label: string;
  suffix?: string;
  tone?: "neutral" | "blue" | "amber" | "rose";
  title?: string;
}) {
  const chip =
    tone === "blue"
      ? "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200"
      : tone === "amber"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : tone === "rose"
      ? "bg-rose-50 text-rose-800 border-rose-200"
      : "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${chip}`}
      title={title}
    >
      <SignalIcon kind={icon} />
      <span className="tabular-nums">{label}</span>
      {suffix && <span className="opacity-80">{suffix}</span>}
    </span>
  );
}

function RatingPill({ rating }: { rating: "A" | "B" | "C" }) {
  // A + B share a positive-quality blue tint; C is amber (attention).
  const cls =
    rating === "A"
      ? "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200"
      : rating === "B"
      ? "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200"
      : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <span
      className={`inline-flex items-center justify-center px-1.5 py-0 rounded text-[10px] font-bold border ${cls}`}
      title={`Rating: ${rating}`}
    >
      {rating}
    </span>
  );
}

function CompliancePill({ status }: { status: "green" | "yellow" | "red" | "not_started" }) {
  const map = {
    green: { label: "Green", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    yellow: { label: "Yellow", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    red: { label: "Red", cls: "bg-rose-50 text-rose-700 border-rose-200" },
    not_started: { label: "Not started", cls: "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100" },
  }[status];
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${map.cls}`}>
      {map.label}
    </span>
  );
}
