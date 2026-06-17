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
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
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
  // Sort link builder — preserves every other URL param (search, rating,
  // compliance, chip toggles) and just flips the sort key. Drops the
  // param entirely when picking the default to keep URLs short.
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

      {/* Filter bar — clean white card with the same form-control language
          as the rest of the platform. Search input has a magnifier icon;
          every select uses the SELECT_CLS pattern (custom chevron, no OS
          gray). Apply button is emerald to match the primary-action
          language. */}
      <form className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="q" className={LABEL_CLS}>
            Search
          </label>
          <CommercialAccountsSearchAutocomplete defaultValue={search ?? ""} />
        </div>
        <div>
          <label htmlFor="rating" className={LABEL_CLS}>
            Rating
          </label>
          <select
            id="rating"
            name="rating"
            defaultValue={rating ?? ""}
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
          <label htmlFor="compliance" className={LABEL_CLS}>
            Compliance
          </label>
          <select
            id="compliance"
            name="compliance"
            defaultValue={compliance ?? ""}
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
            <label htmlFor="industry" className={LABEL_CLS}>
              Industry
            </label>
            <select
              id="industry"
              name="industry"
              defaultValue={industry ?? ""}
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              <option value="">All industries</option>
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
            <label htmlFor="tag" className={LABEL_CLS}>
              Tag
            </label>
            <select
              id="tag"
              name="tag"
              defaultValue={tagFilter ?? ""}
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              <option value="">All tags</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* Sort + the quick-filter toggles moved OUT of this form into a
            unified Sort & Filter dropdown below (Karan 2026-06-16 round
            4). Form now only handles the typed/picked fields that need
            an explicit Apply step. Sort is a URL link (no form needed).
            Hidden input preserves sort across Apply so toggling Rating
            with sort=oldest_first still keeps sort=oldest_first. */}
        {sort !== "created_desc" && <input type="hidden" name="sort" value={sort} />}
        <button
          type="submit"
          className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors touch-manipulation shadow-sm shadow-emerald-600/30 min-h-[44px]"
        >
          Apply filters
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

      {/* Unified Sort & Filter dropdown — Karan 2026-06-16 round 4:
          the separate sort SELECT (in the form above) + standalone
          Filter button got merged into ONE button. Inside: sort
          options as radio-style links + filter toggles as checkbox-
          style links. URL-driven, no client JS needed. */}
      {(() => {
        const activeChipCount = (filterStale ? 1 : 0) + (filterExpiring ? 1 : 0) + (filterIssue ? 1 : 0);
        const sortChanged = sort !== "created_desc";
        const activeCount = activeChipCount + (sortChanged ? 1 : 0);
        const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Most recently updated";
        return (
          <div className="flex items-center gap-2 flex-wrap -mt-1">
            <details className="relative inline-block group">
              <summary
                className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[12px] font-semibold min-h-[44px] touch-manipulation transition-colors ${
                  activeCount > 0
                    ? "bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                    : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18 M7 12h10 M11 18h2" />
                </svg>
                <span>Sort &amp; Filter{activeCount > 0 ? ` · ${activeCount}` : ""}</span>
                <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="absolute mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-lg p-3 min-w-[320px] max-h-[70vh] overflow-y-auto">
                <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 mb-1">
                  Sort by — currently: {currentSortLabel}
                </div>
                <div className="space-y-1">
                  {SORT_OPTIONS.map((o) => (
                    <SortOption
                      key={o.value}
                      href={setSortHref(o.value)}
                      active={sort === o.value}
                      label={o.label}
                    />
                  ))}
                </div>
                <div className="border-t border-ppp-charcoal-100 my-2 pt-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 mb-1">
                    More filters
                  </div>
                  <div className="space-y-1">
                    <FilterOption
                      href={toggleChipHref("stale", filterStale)}
                      active={filterStale}
                      label="Stale > 60 days"
                      description="No update (contact / doc / team / opp) in over 60 days. Worth a follow-up call."
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
            {anyFilterActive && (
              <Link
                href="/commercial/accounts"
                className="text-[12px] font-semibold text-emerald-700 hover:text-emerald-800 underline ml-auto"
              >
                Clear all filters
              </Link>
            )}
          </div>
        );
      })()}

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
                  className={SELECT_CLS}
                  style={SELECT_BG_STYLE}
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
                    className={SELECT_CLS}
                    style={SELECT_BG_STYLE}
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

/** Sort dropdown row — radio-style. Lives next to FilterOption inside
 *  the unified Sort & Filter popover. Click sets `?sort=value` and
 *  navigates; the page re-renders with that sort applied. Active row
 *  highlights with a filled emerald dot. */
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
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg min-h-[44px] touch-manipulation transition-colors ${
        active
          ? "bg-emerald-50 hover:bg-emerald-100"
          : "hover:bg-ppp-charcoal-50"
      }`}
    >
      <span
        className={`inline-flex items-center justify-center h-4 w-4 rounded-full border shrink-0 ${
          active
            ? "border-emerald-600"
            : "border-ppp-charcoal-300"
        }`}
        aria-hidden
      >
        {active && <span className="block h-2 w-2 rounded-full bg-emerald-600" />}
      </span>
      <span className={`text-[13px] font-semibold ${active ? "text-emerald-800" : "text-ppp-charcoal-700"}`}>
        {label}
      </span>
    </Link>
  );
}

/** Filter dropdown row — used inside the Filter <details> popover.
 *  Click toggles the URL param via `href`. Active rows render an
 *  emerald check + light-emerald background; the body of the popover
 *  also gives a one-line plain-English description so Alex sees what
 *  each filter does without needing the chip tooltip. */
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
        active
          ? "bg-emerald-50 hover:bg-emerald-100"
          : "hover:bg-ppp-charcoal-50"
      }`}
    >
      <span
        className={`mt-0.5 inline-flex items-center justify-center h-4 w-4 rounded border shrink-0 ${
          active
            ? "bg-emerald-600 border-emerald-700 text-white"
            : "bg-white border-ppp-charcoal-300 text-transparent"
        }`}
        aria-hidden
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-semibold ${active ? "text-emerald-800" : "text-ppp-charcoal"}`}>
          {label}
        </div>
        <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 leading-snug">
          {description}
        </p>
      </div>
    </Link>
  );
}

function FilterChip({
  href,
  active,
  tone,
  children,
  title,
}: {
  href: string;
  active: boolean;
  tone: "amber" | "rose" | "cold";
  children: React.ReactNode;
  /** Native browser tooltip — explains the chip's filter criteria for
   *  users who don't recognize the abbreviated label. */
  title?: string;
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
      title={title}
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
    <li className="flex items-start gap-2 hover:bg-emerald-50/40 transition-colors group/row">
      {/* Checkbox sits OUTSIDE the Link so clicking it doesn't navigate.
          Touch-manipulation keeps the iOS tap responsive. The label
          wraps both checkbox + the row content for big-tap-target
          friendliness — clicking anywhere along the left margin
          toggles selection. */}
      <label className="pl-3 sm:pl-4 pt-4 cursor-pointer touch-manipulation">
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
