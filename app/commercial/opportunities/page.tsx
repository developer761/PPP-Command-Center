import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  listCommercialOpportunities,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_SOURCES,
  opportunityStatusLabel,
  opportunitySourceLabel,
  formatBidRange,
  weightedPipelineCents,
  type CommercialOpportunity,
  type OpportunityStatus,
  type OpportunitySource,
} from "@/lib/commercial/opportunities/db";
import { listCommercialAccounts, type CommercialAccount, type CommercialAccountRating, type CommercialPrequalStatus } from "@/lib/commercial/accounts/db";
import { pickFirst } from "@/lib/commercial/form-utils";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  OPEN_OPP_STATUSES,
  DEFAULT_PROBABILITY_BY_STATUS,
  STALE_OPP_DAYS,
  QUICK_FLIP_BLOCKED_STATUSES,
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
  HOT_DEAL_ACTIVE_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import {
  allowedNextStatuses,
  changeOpportunityStatus,
  listCurrentStatusEnteredAtByOpp,
} from "@/lib/commercial/opportunities/status";
import { listPrimaryLeadByOpp, opportunityAssignmentRoleLabel } from "@/lib/commercial/opportunities/assignments";
import { listOpenTaskStatsByOpp } from "@/lib/commercial/opportunities/tasks";
import { listLastNoteByOpp } from "@/lib/commercial/opportunities/notes";
import { listAttachmentCountByOpp } from "@/lib/commercial/opportunities/attachments";

const MS_PER_DAY = 86_400_000;

async function quickFlipStatusAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  const to_status = String(formData.get("to_status") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/opportunities");
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    redirect("/commercial/opportunities?status_error=" + encodeURIComponent("Invalid status."));
  }
  // Block terminal statuses from list-page quick-flip — they need extra
  // fields (loss reason, etc.) and live on the detail page.
  if (QUICK_FLIP_BLOCKED_STATUSES.has(to_status)) {
    redirect(`/commercial/opportunities/${opp_id}?action=change-status&to=${to_status}`);
  }
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    acting_user_id: user.id,
  });
  if (!result.ok) {
    redirect("/commercial/opportunities?status_error=" + encodeURIComponent(result.error));
  }
  redirect("/commercial/opportunities?status_ok=1");
}

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
  const statusOk = pickFirst(sp.status_ok) === "1";
  const statusError = pickFirst(sp.status_error);

  // Chip filters (client-side post-fetch — no DB index help needed):
  //   ?stale=1            — only open opps not updated in STALE_OPP_DAYS
  //   ?hot=1              — bid_value_high >= $50k AND proposal_due_at <= 14d
  //                         AND status in HOT_DEAL_ACTIVE_STATUSES
  //   ?sources=email,phone — multi-select source filter (comma-joined)
  const staleFilter = pickFirst(sp.stale) === "1";
  const hotFilter = pickFirst(sp.hot) === "1";
  const sourcesRaw = pickFirst(sp.sources);
  const sourceSet: Set<OpportunitySource> = new Set();
  if (sourcesRaw) {
    for (const s of sourcesRaw.split(",")) {
      const t = s.trim();
      if ((OPPORTUNITY_SOURCES as readonly string[]).includes(t)) {
        sourceSet.add(t as OpportunitySource);
      }
    }
  }

  // Load opps + accounts in parallel so we can show the account name
  // per row without an N+1 join. PPP's commercial book is small enough
  // (~50 accounts) that this is one round-trip not many.
  const [oppsRaw, accounts] = await Promise.all([
    listCommercialOpportunities({ search, status: validStatus }),
    listCommercialAccounts(),
  ]);
  const accountById = new Map<string, CommercialAccount>(accounts.map((a) => [a.id, a]));

  // Row-augmentation bulk fetches — all in one parallel Promise.all so
  // the row's signal-rich badges (days-in-status, overdue tasks count,
  // last-note-at, primary lead) cost one round-trip each, not N+1.
  const oppIds = oppsRaw.map((o) => o.id);
  const [statusEnteredAtMap, taskStatsMap, lastNoteMap, primaryLeadMap, fileCountMap] = await Promise.all([
    listCurrentStatusEnteredAtByOpp(oppIds),
    listOpenTaskStatsByOpp(oppIds),
    listLastNoteByOpp(oppIds),
    listPrimaryLeadByOpp(oppIds),
    listAttachmentCountByOpp(oppIds),
  ]);

  // Apply chip filters post-fetch.
  let opps = oppsRaw;
  if (staleFilter) {
    opps = opps.filter((o) => {
      if (!(OPEN_OPP_STATUSES as readonly string[]).includes(o.status)) return false;
      const days = Math.floor((Date.now() - new Date(o.updated_at).getTime()) / MS_PER_DAY);
      return Number.isFinite(days) && days >= STALE_OPP_DAYS;
    });
  }
  if (hotFilter) {
    // Hot = the deal we want to win NOW. Big bid + clock running + still
    // actively in flight. Filter mirrors lib/.../export.ts so the CSV
    // export of "?hot=1" returns the same rows the user sees.
    opps = opps.filter((o) => {
      if (!(HOT_DEAL_ACTIVE_STATUSES as readonly string[]).includes(o.status)) return false;
      if (!o.bid_value_high_cents || o.bid_value_high_cents < HOT_DEAL_BID_CENTS) return false;
      if (!o.proposal_due_at) return false;
      const daysUntilDue = Math.ceil(
        (new Date(o.proposal_due_at).getTime() - Date.now()) / MS_PER_DAY
      );
      return Number.isFinite(daysUntilDue) && daysUntilDue >= 0 && daysUntilDue <= HOT_DEAL_DECISION_DAYS;
    });
  }
  if (sourceSet.size > 0) {
    opps = opps.filter((o) => o.source && sourceSet.has(o.source));
  }

  // Pipeline summary tile values — computed across the visible (filtered)
  // open opps so the number on the page matches what's listed below.
  const openOpps = opps.filter((o) => (OPEN_OPP_STATUSES as readonly string[]).includes(o.status));
  const totalPipelineCents = openOpps.reduce((acc, o) => acc + weightedPipelineCents(o), 0);
  const totalBidLowCents = openOpps.reduce((acc, o) => acc + (o.bid_value_low_cents ?? 0), 0);
  const totalBidHighCents = openOpps.reduce((acc, o) => acc + (o.bid_value_high_cents ?? 0), 0);

  // URL state preservation for chip toggles. Stale + sources collapse
  // into the URL so reload + bookmark survive.
  const baseParams = new URLSearchParams();
  if (search) baseParams.set("q", search);
  if (validStatus) baseParams.set("status", validStatus);
  if (sourceSet.size > 0) baseParams.set("sources", Array.from(sourceSet).join(","));
  const toggleStaleHref = (() => {
    const p = new URLSearchParams(baseParams);
    if (!staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  const toggleHotHref = (() => {
    const p = new URLSearchParams(baseParams);
    if (!hotFilter) p.set("hot", "1");
    if (staleFilter) p.set("stale", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  const toggleSourceHref = (src: OpportunitySource) => {
    const p = new URLSearchParams(baseParams);
    const next = new Set(sourceSet);
    if (next.has(src)) next.delete(src);
    else next.add(src);
    if (next.size > 0) p.set("sources", Array.from(next).join(","));
    else p.delete("sources");
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  // The CSV export endpoint takes the exact same params the page does
  // so the download is "what the user sees, as a spreadsheet".
  const exportParams = new URLSearchParams(baseParams);
  if (staleFilter) exportParams.set("stale", "1");
  if (hotFilter) exportParams.set("hot", "1");
  const exportHref = `/api/commercial/opportunities/export${exportParams.toString() ? `?${exportParams.toString()}` : ""}`;

  const anyFilterActive =
    !!search || !!validStatus || staleFilter || hotFilter || sourceSet.size > 0;

  // Status snapshot — open-opp count per status, for the inline "where
  // is the pipeline stuck?" pill row above the chip cluster. Each pill
  // is clickable: tapping "Estimating 7" deep-links to the same view
  // pre-filtered to estimating, so the card doubles as a drill-down.
  const statusSnapshot: Array<{ status: OpportunityStatus; count: number }> = (
    OPEN_OPP_STATUSES as readonly OpportunityStatus[]
  )
    .map((s) => ({ status: s, count: openOpps.filter((o) => o.status === s).length }))
    .filter((r) => r.count > 0);

  // Build a "go to this status" href that preserves the other active
  // chips (sources, hot, stale) so drilling into estimating doesn't
  // wipe the user's other filter context.
  const statusDrillHref = (s: OpportunityStatus) => {
    const p = new URLSearchParams(baseParams);
    p.set("status", s);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    return `/commercial/opportunities?${p.toString()}`;
  };

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
      {statusOk && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700 flex items-start justify-between gap-3">
          <span>Status updated.</span>
          <Link
            href="/commercial/opportunities"
            className="text-[12px] text-emerald-700 hover:text-emerald-900 underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {statusError && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700 flex items-start justify-between gap-3">
          <span>{statusError}</span>
          <Link
            href="/commercial/opportunities"
            className="text-[12px] text-rose-700 hover:text-rose-900 underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}

      {/* Status snapshot — open opps grouped by status. Shows the
          pipeline shape at a glance: where are deals sitting? where's
          the bottleneck? Hidden when no open opps. Each pill is a
          tappable drill-down — "Estimating 7" → list filtered to
          estimating with the other filter chips preserved. */}
      {statusSnapshot.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1.5">
            Open by status
            <span className="font-normal text-ppp-charcoal-400 normal-case tracking-normal"> · tap to drill in</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {statusSnapshot.map((r) => {
              const isActive = validStatus === r.status;
              return (
                <Link
                  key={r.status}
                  href={statusDrillHref(r.status)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border min-h-[36px] touch-manipulation transition-colors ${
                    isActive
                      ? "bg-emerald-100 border-emerald-300 text-emerald-800"
                      : "bg-white border-ppp-charcoal-100 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                  }`}
                >
                  <span>{opportunityStatusLabel(r.status)}</span>
                  <strong className={isActive ? "text-emerald-900" : "text-ppp-charcoal"}>
                    {r.count}
                  </strong>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Chip cluster — quick toggles + CSV export. Heavy filters (search
          + status) live in the form above; glanceable boolean chips live
          here. CSV button takes the same params so the download is
          "what the user sees, as a spreadsheet." */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip href={toggleHotHref} active={hotFilter} tone="hot">
            🔥 Hot ($50k+ · &lt;{HOT_DEAL_DECISION_DAYS}d)
          </FilterChip>
          <FilterChip href={toggleStaleHref} active={staleFilter} tone="cold">
            Stale &gt; {STALE_OPP_DAYS}d
          </FilterChip>
          {OPPORTUNITY_SOURCES.map((s) => (
            <FilterChip
              key={s}
              href={toggleSourceHref(s)}
              active={sourceSet.has(s)}
              tone="neutral"
            >
              {opportunitySourceLabel(s)}
            </FilterChip>
          ))}
        </div>
        <a
          href={exportHref}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-ppp-charcoal-200 text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 hover:border-ppp-charcoal-300 min-h-[44px] touch-manipulation shrink-0"
          title="Download the current filter view as a CSV"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
          </svg>
          Export CSV
        </a>
      </div>

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
                statusEnteredAt={statusEnteredAtMap.get(o.id) ?? null}
                taskStats={taskStatsMap.get(o.id) ?? null}
                lastNote={lastNoteMap.get(o.id) ?? null}
                primaryLead={primaryLeadMap.get(o.id) ?? null}
                fileCount={fileCountMap.get(o.id) ?? 0}
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

function FilterChip({
  href,
  active,
  tone,
  children,
}: {
  href: string;
  active: boolean;
  tone: "neutral" | "cold" | "hot";
  children: React.ReactNode;
}) {
  const inactiveCls =
    "bg-white border-ppp-charcoal-100 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50";
  const activeCls =
    tone === "cold"
      ? "bg-ppp-charcoal-100 border-ppp-charcoal-300 text-ppp-charcoal-700"
      : tone === "hot"
      ? "bg-rose-100 border-rose-300 text-rose-800"
      : "bg-emerald-100 border-emerald-300 text-emerald-800";
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

function OpportunityRow({
  opportunity,
  account,
  statusEnteredAt,
  taskStats,
  lastNote,
  primaryLead,
  fileCount,
}: {
  opportunity: CommercialOpportunity;
  account: CommercialAccount | null;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  lastNote: { created_at: string; author_label: string | null } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: import("@/lib/commercial/opportunities/assignments").OpportunityAssignmentRole } | null;
  fileCount: number;
}) {
  const bid = formatBidRange(opportunity.bid_value_low_cents, opportunity.bid_value_high_cents);
  // Decision countdown — color-coded so Alex's eye catches urgency on
  // a Friday scan. Reuses the same green/amber/rose language as the
  // accounts list activity tones.
  const dueChip = decisionChip(opportunity.proposal_due_at);
  // Days-in-current-status — from the status_log "entered at" lookup.
  // Tones: <7 muted / 7-14 amber / >14 rose. Surfaces "stuck deals"
  // at a glance without opening detail.
  const daysInStatus = statusEnteredAt
    ? Math.floor((Date.now() - new Date(statusEnteredAt).getTime()) / MS_PER_DAY)
    : null;
  // Probability override badge — shows a quiet "custom" indicator when
  // the user set probability away from the status default. Signals
  // "this is a gut call, not the system default" — useful intel.
  const defaultProb = DEFAULT_PROBABILITY_BY_STATUS[opportunity.status] ?? null;
  const probOverridden = defaultProb !== null && opportunity.probability_pct !== defaultProb;
  // Quick-flip dropdown options — only DAG-valid next statuses, and
  // we hide terminal states (won/lost/no_bid) because they need extra
  // fields and live on the detail page.
  const nextStatuses = allowedNextStatuses(opportunity.status).filter(
    (s) => !QUICK_FLIP_BLOCKED_STATUSES.has(s)
  );
  return (
    <li className="relative">
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
            {/* Signal row — secondary glance band. Shows up to 4 quick
                cues so Alex can scan the list without opening detail:
                days-in-status, overdue/due-soon task chips, last-note
                touchpoint, primary lead initials. Each only renders
                when the data warrants it. */}
            {(daysInStatus !== null || taskStats || lastNote || primaryLead) && (
              <div className="text-[11px] mt-1 flex items-center gap-x-2 gap-y-1 flex-wrap">
                {daysInStatus !== null && (
                  <span
                    className={
                      daysInStatus > 14
                        ? "text-rose-700"
                        : daysInStatus > 7
                        ? "text-amber-700"
                        : "text-ppp-charcoal-500"
                    }
                    title={`Entered ${opportunityStatusLabel(opportunity.status)} ${daysInStatus}d ago`}
                  >
                    {daysInStatus}d in {opportunityStatusLabel(opportunity.status).toLowerCase()}
                  </span>
                )}
                {taskStats && taskStats.open > 0 && (
                  <>
                    <span aria-hidden className="text-ppp-charcoal-300">·</span>
                    <span
                      className={
                        taskStats.overdue > 0
                          ? "text-rose-700 font-medium"
                          : taskStats.due_soon > 0
                          ? "text-amber-700"
                          : "text-ppp-charcoal-500"
                      }
                      title={`${taskStats.open} open · ${taskStats.overdue} overdue · ${taskStats.due_soon} due in 7d`}
                    >
                      {taskStats.overdue > 0
                        ? `${taskStats.overdue} overdue task${taskStats.overdue === 1 ? "" : "s"}`
                        : `${taskStats.open} open task${taskStats.open === 1 ? "" : "s"}`}
                    </span>
                  </>
                )}
                {lastNote && (
                  <>
                    <span aria-hidden className="text-ppp-charcoal-300">·</span>
                    <span className="text-ppp-charcoal-500" title={new Date(lastNote.created_at).toLocaleString()}>
                      Last note {relativeAgo(lastNote.created_at)}
                      {lastNote.author_label ? ` by ${lastNote.author_label}` : ""}
                    </span>
                  </>
                )}
                {primaryLead && (
                  <>
                    <span aria-hidden className="text-ppp-charcoal-300">·</span>
                    <span
                      className="inline-flex items-center gap-1 text-emerald-700"
                      title={`${opportunityAssignmentRoleLabel(primaryLead.role)}: ${primaryLead.user_full_name ?? primaryLead.user_email}`}
                    >
                      <span aria-hidden>★</span>
                      {(primaryLead.user_full_name ?? primaryLead.user_email).split(" ")[0]}
                    </span>
                  </>
                )}
                {fileCount > 0 && (
                  <>
                    <span aria-hidden className="text-ppp-charcoal-300">·</span>
                    <span className="text-ppp-charcoal-500" title="Plans & Specs attachments">
                      📎 {fileCount} {fileCount === 1 ? "file" : "files"}
                    </span>
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
      {/* Quick status-flip — lives OUTSIDE the row Link so the select
          + submit don't trigger navigation. Native <select> renders
          the iOS picker on phones (familiar) and a standard dropdown
          on desktop. The submit button is small + adjacent so a single
          tap → pick → tap commits the change. Hidden when nothing's a
          valid next status (terminal-from won/lost/no_bid render the
          "open detail to reopen" hint instead). */}
      {nextStatuses.length > 0 ? (
        <form
          action={quickFlipStatusAction}
          className="px-4 pb-3 -mt-1 flex items-center gap-2 flex-wrap"
        >
          <input type="hidden" name="opp_id" value={opportunity.id} />
          <label htmlFor={`flip-${opportunity.id}`} className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500">
            Quick flip
          </label>
          <select
            id={`flip-${opportunity.id}`}
            name="to_status"
            defaultValue=""
            required
            className="px-2 py-1 text-base sm:text-sm border border-ppp-charcoal-100 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[36px] bg-white"
          >
            <option value="" disabled>
              Next status…
            </option>
            {nextStatuses.map((s) => (
              <option key={s} value={s}>
                → {opportunityStatusLabel(s)}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-3 py-1 rounded-md bg-ppp-charcoal text-white text-[12px] font-semibold hover:bg-ppp-charcoal-700 active:bg-ppp-charcoal-700 min-h-[36px] touch-manipulation"
          >
            Apply
          </button>
        </form>
      ) : (
        <p className="px-4 pb-3 -mt-1 text-[11px] text-ppp-charcoal-500">
          <Link
            href={`/commercial/opportunities/${opportunity.id}?tab=info`}
            className="underline hover:text-ppp-charcoal-700"
          >
            Open to change status
          </Link>
        </p>
      )}
    </li>
  );
}

/** Compact "3d ago" / "yesterday" / "today" relative-time for the
 *  list-row last-note signal. Future timestamps (clock skew) collapse
 *  to "just now" rather than render confusingly. */
function relativeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const days = Math.floor(ms / MS_PER_DAY);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
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
