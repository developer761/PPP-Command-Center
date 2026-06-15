import Link from "next/link";
import {
  listCommercialOpportunities,
  OPPORTUNITY_STATUSES,
  opportunityStatusLabel,
  formatBidRange,
  weightedPipelineCents,
  type CommercialOpportunity,
  type OpportunityStatus,
} from "@/lib/commercial/opportunities/db";
import { listCommercialAccounts, type CommercialAccount, type CommercialAccountRating, type CommercialPrequalStatus } from "@/lib/commercial/accounts/db";
import { pickFirst } from "@/lib/commercial/form-utils";
import { OPEN_OPP_STATUSES, DEFAULT_PROBABILITY_BY_STATUS } from "@/lib/commercial/opportunities/constants";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CommercialOpportunitiesPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const search = pickFirst(sp.q);
  const statusFilter = pickFirst(sp.status) as OpportunityStatus | undefined;
  const validStatus = statusFilter && (OPPORTUNITY_STATUSES as readonly string[]).includes(statusFilter)
    ? (statusFilter as OpportunityStatus)
    : undefined;
  const created = pickFirst(sp.created) === "1";

  // Load opps + accounts in parallel so we can show the account name
  // per row without an N+1 join. PPP's commercial book is small enough
  // (~50 accounts) that this is one round-trip not many.
  const [opps, accounts] = await Promise.all([
    listCommercialOpportunities({ search, status: validStatus }),
    listCommercialAccounts(),
  ]);
  const accountById = new Map<string, CommercialAccount>(accounts.map((a) => [a.id, a]));

  // Pipeline summary tile values — computed across the visible (filtered)
  // open opps so the number on the page matches what's listed below.
  const openOpps = opps.filter((o) => (OPEN_OPP_STATUSES as readonly string[]).includes(o.status));
  const totalPipelineCents = openOpps.reduce((acc, o) => acc + weightedPipelineCents(o), 0);
  const totalBidLowCents = openOpps.reduce((acc, o) => acc + (o.bid_value_low_cents ?? 0), 0);
  const totalBidHighCents = openOpps.reduce((acc, o) => acc + (o.bid_value_high_cents ?? 0), 0);

  // URL state preservation for chip toggles.
  const baseParams = new URLSearchParams();
  if (search) baseParams.set("q", search);
  if (validStatus) baseParams.set("status", validStatus);

  const anyFilterActive = !!search || !!validStatus;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold tracking-widest uppercase text-emerald-700">
            Phase 2 · Opportunities
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal mt-1">
            Opportunities
          </h1>
          <p className="text-sm text-ppp-charcoal-500 mt-1">
            The deal record. From inquiry through won — track every commercial bid.
          </p>
        </div>
        <Link
          href="/commercial/opportunities/new"
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors touch-manipulation shadow-sm shadow-emerald-600/30 min-h-[44px]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          New opportunity
        </Link>
      </header>

      {/* Pipeline summary — single-glance "where do we stand on open deals?" */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryTile
          label="Open opportunities"
          value={openOpps.length.toString()}
          sublabel={`${opps.length - openOpps.length} closed`}
          tone="emerald"
        />
        <SummaryTile
          label="Bid range (open)"
          value={`${formatCents(totalBidLowCents)} – ${formatCents(totalBidHighCents)}`}
          sublabel="Total of low + high"
          tone="neutral"
        />
        <SummaryTile
          label="Weighted pipeline"
          value={formatCents(totalPipelineCents)}
          sublabel="Σ midpoint × probability"
          tone="blue"
        />
      </section>

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
            placeholder="Title"
            className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
          />
        </div>
        <div>
          <label htmlFor="status" className="block text-[10px] font-bold tracking-wide uppercase text-ppp-charcoal-500 mb-1">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={validStatus ?? ""}
            className="px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
          >
            <option value="">Any</option>
            {OPPORTUNITY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {opportunityStatusLabel(s)}
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
        {anyFilterActive && (
          <Link
            href="/commercial/opportunities"
            className="text-[12px] text-emerald-700 hover:text-emerald-800 underline ml-1 min-h-[44px] inline-flex items-center"
          >
            Clear filters
          </Link>
        )}
      </form>

      {created && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700">
          Opportunity created.
        </div>
      )}

      {/* List */}
      {opps.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <div className="text-sm text-ppp-charcoal-500">
            {anyFilterActive
              ? "No opportunities match these filters."
              : "No opportunities yet — log the first deal to get started."}
          </div>
          {!anyFilterActive && (
            <Link
              href="/commercial/opportunities/new"
              className="inline-flex items-center justify-center gap-1.5 mt-4 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 min-h-[44px]"
            >
              New opportunity
            </Link>
          )}
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              {opps.length} opportunit{opps.length === 1 ? "y" : "ies"}
            </h2>
            <span className="text-[11px] text-ppp-charcoal-500">
              Sorted by most recently updated
            </span>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {opps.map((o) => (
              <OpportunityRow
                key={o.id}
                opportunity={o}
                account={accountById.get(o.account_id) ?? null}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars).toLocaleString()}`;
}

function SummaryTile({
  label,
  value,
  sublabel,
  tone,
}: {
  label: string;
  value: string;
  sublabel: string;
  tone: "emerald" | "blue" | "neutral";
}) {
  const ring =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50/40"
      : tone === "blue"
      ? "border-blue-200 bg-blue-50/40"
      : "border-ppp-charcoal-100 bg-white";
  return (
    <div className={`border rounded-xl px-4 py-3 ${ring}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
        {label}
      </div>
      <div className="text-xl sm:text-2xl font-bold text-ppp-charcoal mt-1">
        {value}
      </div>
      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sublabel}</div>
    </div>
  );
}

function OpportunityRow({
  opportunity,
  account,
}: {
  opportunity: CommercialOpportunity;
  account: CommercialAccount | null;
}) {
  const bid = formatBidRange(opportunity.bid_value_low_cents, opportunity.bid_value_high_cents);
  // Decision countdown — color-coded so Alex's eye catches urgency on
  // a Friday scan. Reuses the same green/amber/rose language as the
  // accounts list activity tones.
  const dueChip = decisionChip(opportunity.proposal_due_at);
  // Probability override badge — shows a quiet "custom" indicator when
  // the user set probability away from the status default. Signals
  // "this is a gut call, not the system default" — useful intel.
  const defaultProb = DEFAULT_PROBABILITY_BY_STATUS[opportunity.status] ?? null;
  const probOverridden = defaultProb !== null && opportunity.probability_pct !== defaultProb;
  return (
    <li>
      <Link
        href={`/commercial/opportunities/${opportunity.id}`}
        className="block px-4 py-4 hover:bg-emerald-50/40 transition-colors touch-manipulation"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ppp-charcoal text-sm">
                {opportunity.title}
              </span>
              <StatusPill status={opportunity.status} />
              {dueChip && <DueChip {...dueChip} />}
            </div>
            <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              {account && (
                <span className="text-ppp-charcoal-700">{account.company_name}</span>
              )}
              {account?.rating && <RatingPill rating={account.rating} />}
              {account?.prequalification_status && (
                <PrequalPill status={account.prequalification_status} />
              )}
              <span aria-hidden>·</span>
              <span>
                <strong className="text-ppp-charcoal">{bid}</strong> bid
              </span>
              <span aria-hidden>·</span>
              <span title={probOverridden ? `Default ${defaultProb}% for ${opportunityStatusLabel(opportunity.status)} — overridden` : undefined}>
                {opportunity.probability_pct}% confident
                {probOverridden && <span className="ml-0.5 text-amber-700" aria-label="Probability overridden from status default">*</span>}
              </span>
            </div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 shrink-0 mt-0.5" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </Link>
    </li>
  );
}

/** Decision-date chip — turns the bare ISO date into a glanceable
 *  urgency signal. Past-due → rose, ≤ 7d → amber, > 7d → emerald. */
function decisionChip(iso: string | null): { label: string; tone: "ok" | "soon" | "overdue" } | null {
  if (!iso) return null;
  const target = new Date(iso.slice(0, 10) + "T00:00:00").getTime();
  if (!Number.isFinite(target)) return null;
  const days = Math.ceil((target - Date.now()) / 86_400_000);
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: "overdue" };
  if (days === 0) return { label: "Due today", tone: "soon" };
  if (days === 1) return { label: "Due tomorrow", tone: "soon" };
  if (days <= 7) return { label: `Due in ${days}d`, tone: "soon" };
  return { label: `Due in ${days}d`, tone: "ok" };
}

function DueChip({ label, tone }: { label: string; tone: "ok" | "soon" | "overdue" }) {
  const cls =
    tone === "overdue"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : tone === "soon"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-emerald-50 text-emerald-700 border-emerald-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}

function RatingPill({ rating }: { rating: CommercialAccountRating }) {
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

function PrequalPill({ status }: { status: CommercialPrequalStatus }) {
  // Compliance signal inline on the opp row — Alex spots "C-rated +
  // prequal rejected" instantly so he doesn't burn a Friday on a deal
  // that can't legally close.
  const map = {
    not_started: { label: "Prequal: —", cls: "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100" },
    pending: { label: "Prequal: pending", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    approved: { label: "Prequal: ✓", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    rejected: { label: "Prequal: ✗", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  }[status];
  if (!map) return null;
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${map.cls}`}>
      {map.label}
    </span>
  );
}

function StatusPill({ status }: { status: OpportunityStatus }) {
  const map: Record<OpportunityStatus, string> = {
    inquiry: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100",
    site_visit_scheduled: "bg-blue-50 text-blue-700 border-blue-200",
    site_visit_done: "bg-blue-50 text-blue-700 border-blue-200",
    estimating: "bg-amber-50 text-amber-800 border-amber-200",
    proposal_sent: "bg-amber-50 text-amber-800 border-amber-200",
    negotiating: "bg-amber-50 text-amber-800 border-amber-200",
    on_hold: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100",
    won: "bg-emerald-50 text-emerald-700 border-emerald-200",
    lost: "bg-rose-50 text-rose-700 border-rose-200",
    no_bid: "bg-rose-50 text-rose-700 border-rose-200",
    reopened: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${map[status]}`}>
      {opportunityStatusLabel(status)}
    </span>
  );
}
