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
  // ─── Batch 5a — new sort + quick-filter chips ───
  // sort: `created_desc` (default) | `created_asc` | `name_asc` | `name_desc`
  //       | `activity_desc` | `activity_asc` | `rating_asc`
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
  // Quick-filter chips. URL truthy="1" so a click toggles on/off cleanly.
  const filterStale = pickFirst(sp.stale) === "1";       // last activity > ACTIVITY_STALE_DAYS
  const filterExpiring = pickFirst(sp.expiring) === "1"; // any expired or expiring-soon doc
  const filterIssue = pickFirst(sp.issue) === "1";       // compliance status = red OR any expired doc

  const [accountsRaw, industries, assignableStaff] = await Promise.all([
    listCommercialAccounts({ search, rating, compliance, industry }),
    listCommercialAccountIndustries(),
    listAssignableStaff(),
  ]);
  const bulkResult = pickFirst(sp.bulk_result);
  const bulkError = pickFirst(sp.bulk_error);
  // Bulk-fetch the Account 360 overview rows so each list row can show
  // its 1-line snippet (contacts / team / docs / last activity) without
  // an N+1 round-trip. Missing rows fall back to placeholders in the UI.
  // Same pattern for tags — one bulk query, then O(1) lookup per row.
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

  // Sort. Default `created_desc` matches what listCommercialAccounts
  // returns by default — we re-sort here for consistency since the DB
  // helper currently sorts by company_name asc.
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

  // "Recently active" section — top 3 accounts touched in the last 7
  // days. Sorted by most recent activity. Hidden when there are no
  // recent accounts so the section never shows up empty.
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

  // Build query-string-preserving link helpers for the chip toggles +
  // sort dropdown. URL-driven state means a refresh / bookmark survives.
  const baseParams = new URLSearchParams();
  if (search) baseParams.set("q", search);
  if (rating) baseParams.set("rating", rating);
  if (compliance) baseParams.set("compliance", compliance);
  if (industry) baseParams.set("industry", industry);
  if (tagFilter) baseParams.set("tag", tagFilter);
  if (sort !== "created_desc") baseParams.set("sort", sort);
  const toggleChipHref = (param: "stale" | "expiring" | "issue", currentlyOn: boolean): string => {
    const p = new URLSearchParams(baseParams);
    // Preserve the other chips' current state
    if (filterStale && param !== "stale") p.set("stale", "1");
    if (filterExpiring && param !== "expiring") p.set("expiring", "1");
    if (filterIssue && param !== "issue") p.set("issue", "1");
    if (!currentlyOn) p.set(param, "1");
    const qs = p.toString();
    return qs ? `/commercial/accounts?${qs}` : "/commercial/accounts";
  };
  const anyFilterActive = !!search || !!rating || !!compliance || !!industry || !!tagFilter || filterStale || filterExpiring || filterIssue;

  // Export link query string — mirrors the visible list's filters
  // (DB-side q + rating + compliance + industry). Tag + chip filters
  // run client-side post-fetch, so they're omitted from the export QS
  // so the user gets the broader DB list; if Alex wants the tag-filtered
  // slice he can re-export after un-toggling. Sort doesn't matter for
  // CSV — Excel re-sorts trivially.
  const exportParams = new URLSearchParams();
  if (search) exportParams.set("q", search);
  if (rating) exportParams.set("rating", rating);
  if (compliance) exportParams.set("compliance", compliance);
  if (industry) exportParams.set("industry", industry);
  const exportQs = exportParams.toString();

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold tracking-widest uppercase text-emerald-700">
            Phase 1 · Accounts
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal mt-1">
            Accounts
          </h1>
          <p className="text-sm text-ppp-charcoal-500 mt-1">
            The companies PPP works with. Every commercial project starts on an account.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Export button — preserves the same q/rating/compliance/
              industry filters as the visible list, so what you see is
              what you get in the CSV. Only renders when there's at
              least one row to export. */}
          {accounts.length > 0 && (
            <a
              href={`/api/commercial/accounts/export${exportQs ? `?${exportQs}` : ""}`}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 bg-white text-ppp-charcoal text-sm font-semibold hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors touch-manipulation min-h-[44px]"
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
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors touch-manipulation shadow-sm shadow-emerald-600/30 min-h-[44px]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14 M5 12h14" />
            </svg>
            New account
          </Link>
        </div>
      </header>

      {/* Filter bar */}
      <form className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[180px]">
          <label htmlFor="q" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
            Search
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={search ?? ""}
            placeholder="Company name or DBA"
            className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
          />
        </div>
        <div>
          <label htmlFor="rating" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
            Rating
          </label>
          <select
            id="rating"
            name="rating"
            defaultValue={rating ?? ""}
            className="px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
          >
            <option value="">Any</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
        </div>
        <div>
          <label htmlFor="compliance" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
            Compliance
          </label>
          <select
            id="compliance"
            name="compliance"
            defaultValue={compliance ?? ""}
            className="px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
          >
            <option value="">Any</option>
            <option value="green">Green</option>
            <option value="yellow">Yellow</option>
            <option value="red">Red</option>
            <option value="not_started">Not started</option>
          </select>
        </div>
        {industries.length > 0 && (
          <div>
            <label htmlFor="industry" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
              Industry
            </label>
            <select
              id="industry"
              name="industry"
              defaultValue={industry ?? ""}
              className="px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
            >
              <option value="">Any</option>
              {industries.map((ind) => (
                <option key={ind} value={ind}>
                  {ind}
                </option>
              ))}
            </select>
          </div>
        )}
        {allTags.length > 0 && (
          <div>
            <label htmlFor="tag" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
              Tag
            </label>
            <select
              id="tag"
              name="tag"
              defaultValue={tagFilter ?? ""}
              className="px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
            >
              <option value="">Any</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="sort" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
            Sort by
          </label>
          <select
            id="sort"
            name="sort"
            defaultValue={sort}
            className="px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 transition-colors touch-manipulation min-h-[44px]"
        >
          Filter
        </button>
      </form>

      {justDeleted && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700">
          Account deleted. The record + every contact, document, and team assignment stays in the database — an admin can restore it.
        </div>
      )}
      {bulkResult && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700 flex items-start justify-between gap-3">
          <span>{bulkResult}</span>
          <Link
            href="/commercial/accounts"
            className="text-[12px] text-emerald-700 hover:text-emerald-900 underline shrink-0 min-h-[24px] inline-flex items-center"
            aria-label="Dismiss banner"
          >
            Dismiss
          </Link>
        </div>
      )}
      {bulkError && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700 flex items-start justify-between gap-3">
          <span>{bulkError}</span>
          <Link
            href="/commercial/accounts"
            className="text-[12px] text-rose-700 hover:text-rose-900 underline shrink-0 min-h-[24px] inline-flex items-center"
            aria-label="Dismiss banner"
          >
            Dismiss
          </Link>
        </div>
      )}

      {/* Quick-filter chips — Karan 2026-06-14 Batch 5a. One-click toggles
          driven by the URL so reload + bookmark survive. Each chip
          preserves the others' state when toggled. */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip href={toggleChipHref("stale", filterStale)} active={filterStale} tone="cold">
          Stale &gt; 60 days
        </FilterChip>
        <FilterChip href={toggleChipHref("expiring", filterExpiring)} active={filterExpiring} tone="amber">
          Has expiring docs
        </FilterChip>
        <FilterChip href={toggleChipHref("issue", filterIssue)} active={filterIssue} tone="rose">
          Compliance issue
        </FilterChip>
        {anyFilterActive && (
          <Link
            href="/commercial/accounts"
            className="text-[11px] text-emerald-700 hover:text-emerald-800 underline ml-1"
          >
            Clear all filters
          </Link>
        )}
      </div>

      {/* Recently active — only show when no filters narrowing the list
          AND there's at least one match in the last 7 days. Gives Alex a
          quick-glance "what changed this week" without scanning the full
          list. */}
      {!anyFilterActive && recentlyActive.length > 0 && (
        <section className="bg-emerald-50/50 border border-emerald-200 rounded-xl p-4 sm:p-5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 mb-3">
            Recently active · last 7 days
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
                    className="block bg-white border border-emerald-100 rounded-lg px-3 py-2.5 hover:border-emerald-300 hover:bg-emerald-50/40 transition-colors touch-manipulation min-h-[44px]"
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
        </section>
      )}

      {/* Accounts table / empty state */}
      {accounts.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <div className="text-sm text-ppp-charcoal-500">
            {anyFilterActive
              ? "No accounts match these filters."
              : "No accounts yet — add the first one to get started."}
          </div>
          {!anyFilterActive && (
            <Link
              href="/commercial/accounts/new"
              className="inline-flex items-center justify-center gap-1.5 mt-4 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700"
            >
              New account
            </Link>
          )}
        </div>
      ) : (
        <form className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              {accounts.length} account{accounts.length === 1 ? "" : "s"}
            </h2>
            <span className="text-[11px] text-ppp-charcoal-500">
              Check rows + use the bulk-action bar to tag or assign in one click.
            </span>
          </div>
          {/* Bulk-action bar — two compact inline forms inside the
              wrapping list form. Each submit button targets a different
              server action via formAction. The checked rows from the
              list propagate as `account_id` form values automatically. */}
          <div className="bg-ppp-charcoal-50 border-b border-ppp-charcoal-100 px-3 sm:px-4 py-3 flex flex-col lg:flex-row gap-3">
            <div className="flex flex-col sm:flex-row sm:items-end gap-2 flex-1 min-w-0">
              <div className="flex-1">
                <label htmlFor="bulk_tag" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
                  Bulk tag selected
                </label>
                <input
                  id="bulk_tag"
                  name="bulk_tag"
                  type="text"
                  placeholder="e.g. Q3-outreach"
                  maxLength={50}
                  className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
                />
              </div>
              <button
                type="submit"
                formAction={bulkTagAccountsAction}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 active:bg-ppp-charcoal-700 transition-colors min-h-[44px] touch-manipulation"
              >
                Apply tag
              </button>
            </div>
            {assignableStaff.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-end gap-2 flex-1 min-w-0">
                <div className="flex-1">
                  <label htmlFor="bulk_user_id" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
                    Bulk assign staff
                  </label>
                  <select
                    id="bulk_user_id"
                    name="bulk_user_id"
                    defaultValue=""
                    required
                    className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
                  >
                    <option value="">Pick staff</option>
                    {assignableStaff.map((p) => (
                      <option key={p.user_id} value={p.user_id}>
                        {p.full_name ?? p.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="bulk_role" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
                    Role
                  </label>
                  <select
                    id="bulk_role"
                    name="bulk_role"
                    defaultValue=""
                    required
                    className="px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
                  >
                    <option value="">Pick role</option>
                    {ASSIGNMENT_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {assignmentRoleLabel(r)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  formAction={bulkAssignAccountsAction}
                  className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 active:bg-ppp-charcoal-700 transition-colors min-h-[44px] touch-manipulation"
                >
                  Assign
                </button>
              </div>
            )}
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

function FilterChip({
  href,
  active,
  tone,
  children,
}: {
  href: string;
  active: boolean;
  tone: "amber" | "rose" | "cold";
  children: React.ReactNode;
}) {
  const inactiveCls =
    "bg-white border-ppp-charcoal-100 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50";
  const activeCls = (() => {
    switch (tone) {
      case "amber":
        return "bg-amber-100 border-amber-300 text-amber-800";
      case "rose":
        return "bg-rose-100 border-rose-300 text-rose-700";
      case "cold":
        return "bg-ppp-charcoal-100 border-ppp-charcoal-300 text-ppp-charcoal-700";
    }
  })();
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-medium transition-colors touch-manipulation min-h-[36px] ${
        active ? activeCls : inactiveCls
      }`}
    >
      {active && <span aria-hidden>✓</span>}
      {children}
    </Link>
  );
}

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
  const activityCls =
    tone === "ok"
      ? "text-emerald-700"
      : tone === "stale"
      ? "text-amber-700"
      : tone === "cold"
      ? "text-rose-700"
      : "text-ppp-charcoal-500";
  // Show up to 3 tag pills inline; collapse the rest into "+N" so the
  // row height stays predictable. Tag detail page is the Info tab on the
  // account itself — pills are read-only here.
  const visibleTags = tags.slice(0, 3);
  const extraTagCount = Math.max(0, tags.length - visibleTags.length);
  return (
    <li className="flex items-start gap-2 hover:bg-emerald-50/40 transition-colors">
      {/* Checkbox sits OUTSIDE the Link so clicking it doesn't navigate.
          Touch-manipulation keeps the iOS tap responsive. The label
          wraps both checkbox + the row content for big-tap-target
          friendliness — clicking anywhere along the left margin
          toggles selection. */}
      <label className="pl-3 sm:pl-4 pt-5 cursor-pointer touch-manipulation">
        <input
          type="checkbox"
          name="account_id"
          value={account.id}
          aria-label={`Select ${account.company_name} for bulk actions`}
          className="w-4 h-4 rounded border-ppp-charcoal-300 text-emerald-600 focus:ring-emerald-600/40 cursor-pointer"
        />
      </label>
      <Link
        href={`/commercial/accounts/${account.id}`}
        className="flex-1 block pr-4 sm:pr-4 py-4 touch-manipulation"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {account.is_key_relationship && (
                <span
                  className="inline-flex items-center text-amber-500 text-sm leading-none"
                  title="★ Key Relationship — strategic partnership"
                  aria-label="Key Relationship"
                >
                  ★
                </span>
              )}
              <span className="font-semibold text-ppp-charcoal text-sm">
                {account.company_name}
              </span>
              {account.dba && (
                <span className="text-[11px] text-ppp-charcoal-500">d/b/a {account.dba}</span>
              )}
              {account.rating && <RatingPill rating={account.rating} />}
              {account.vendor_compliance_status && (
                <CompliancePill status={account.vendor_compliance_status} />
              )}
            </div>
            <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
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
            {overview && (
              <div className="text-[11px] mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap text-ppp-charcoal-500">
                <span>
                  <strong className="text-ppp-charcoal">{overview.contact_count}</strong> contact{overview.contact_count === 1 ? "" : "s"}
                </span>
                <span aria-hidden>·</span>
                <span>
                  <strong className="text-ppp-charcoal">{overview.ppp_team_count}</strong> on team
                </span>
                <span aria-hidden>·</span>
                <span>
                  <strong className="text-ppp-charcoal">{overview.active_document_count}</strong> doc{overview.active_document_count === 1 ? "" : "s"}
                  {overview.expired_document_count > 0 && (
                    <span className="text-rose-700"> ({overview.expired_document_count} expired)</span>
                  )}
                  {overview.expired_document_count === 0 && overview.expiring_soon_document_count > 0 && (
                    <span className="text-amber-700"> ({overview.expiring_soon_document_count} expiring)</span>
                  )}
                </span>
                {(overview.open_opps_count ?? 0) > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-emerald-700">
                      <strong>{overview.open_opps_count}</strong> open bid{overview.open_opps_count === 1 ? "" : "s"}
                      {(() => {
                        const bidRange = formatBidCents(
                          overview.total_active_bid_low_cents,
                          overview.total_active_bid_high_cents
                        );
                        return bidRange !== "—" ? ` · ${bidRange}` : "";
                      })()}
                    </span>
                  </>
                )}
                {(overview.won_opps_count ?? 0) > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span
                      className="text-amber-800"
                      title={`PPP has won ${overview.won_opps_count} bid${overview.won_opps_count === 1 ? "" : "s"} with this account.`}
                    >
                      <span aria-hidden>★</span> repeat
                    </span>
                  </>
                )}
                {activity && (
                  <>
                    <span aria-hidden>·</span>
                    <span className={activityCls}>Active {activity}</span>
                  </>
                )}
              </div>
            )}
            {tags.length > 0 && (
              <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                {visibleTags.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-medium"
                  >
                    {t.tag}
                  </span>
                ))}
                {extraTagCount > 0 && (
                  <span className="text-[10px] text-ppp-charcoal-500">+{extraTagCount}</span>
                )}
              </div>
            )}
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 shrink-0 mt-0.5" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </Link>
    </li>
  );
}

function RatingPill({ rating }: { rating: "A" | "B" | "C" }) {
  const cls =
    rating === "A"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : rating === "B"
      ? "bg-blue-50 text-blue-700 border-blue-200"
      : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-bold border ${cls}`}>
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
