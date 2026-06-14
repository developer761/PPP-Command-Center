import Link from "next/link";
import {
  listCommercialAccounts,
  listCommercialAccountIndustries,
  type CommercialAccount,
} from "@/lib/commercial/accounts/db";
import {
  listAccountOverviews,
  relativeActivity,
  activityTone,
  type AccountOverview,
} from "@/lib/commercial/accounts/overview";

export const dynamic = "force-dynamic";

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
  const rating = pickFirst(sp.rating) as "A" | "B" | "C" | undefined;
  const compliance = pickFirst(sp.compliance) as
    | "green"
    | "yellow"
    | "red"
    | "not_started"
    | undefined;
  const industry = pickFirst(sp.industry);

  const [accounts, industries] = await Promise.all([
    listCommercialAccounts({ search, rating, compliance, industry }),
    listCommercialAccountIndustries(),
  ]);
  // Bulk-fetch the Account 360 overview rows so each list row can show
  // its 1-line snippet (contacts / team / docs / last activity) without
  // an N+1 round-trip. Missing rows fall back to placeholders in the UI.
  const overviewsById = await listAccountOverviews(accounts.map((a) => a.id));

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
        <Link
          href="/commercial/accounts/new"
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors touch-manipulation shadow-sm shadow-emerald-600/30"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          New account
        </Link>
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
            className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
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
            className="px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
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
            className="px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
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
              className="px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
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
        <button
          type="submit"
          className="px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 transition-colors touch-manipulation"
        >
          Filter
        </button>
      </form>

      {/* Accounts table / empty state */}
      {accounts.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <div className="text-sm text-ppp-charcoal-500">
            {search || rating || compliance || industry
              ? "No accounts match these filters."
              : "No accounts yet — add the first one to get started."}
          </div>
          {!(search || rating || compliance || industry) && (
            <Link
              href="/commercial/accounts/new"
              className="inline-flex items-center justify-center gap-1.5 mt-4 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700"
            >
              New account
            </Link>
          )}
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              {accounts.length} account{accounts.length === 1 ? "" : "s"}
            </h2>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} overview={overviewsById.get(a.id) ?? null} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AccountRow({ account, overview }: { account: CommercialAccount; overview: AccountOverview | null }) {
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
  return (
    <li>
      <Link
        href={`/commercial/accounts/${account.id}`}
        className="block px-4 py-4 hover:bg-emerald-50/40 transition-colors touch-manipulation"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
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
                {activity && (
                  <>
                    <span aria-hidden>·</span>
                    <span className={activityCls}>Active {activity}</span>
                  </>
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
