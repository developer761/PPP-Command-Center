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
// CommercialOpportunitiesSortPicker removed 2026-06-17 — sort merged into
// the unified Sort & Filter dropdown below. The client component file
// remains in the repo in case a future surface needs a standalone sort.
import { KanbanDnDProvider, KanbanDnDCard, KanbanDnDColumn } from "@/components/commercial-kanban-dnd";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

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
  const deletedTitle = pickFirst(sp.deleted);

  // Chip filters (client-side post-fetch — no DB index help needed):
  //   ?stale=1            — only open opps not updated in STALE_OPP_DAYS
  //   ?hot=1              — bid_value_high >= $50k AND proposal_due_at <= 14d
  //                         AND status in HOT_DEAL_ACTIVE_STATUSES
  //   ?sources=email,phone — multi-select source filter (comma-joined)
  const staleFilter = pickFirst(sp.stale) === "1";
  const hotFilter = pickFirst(sp.hot) === "1";
  const sourcesRaw = pickFirst(sp.sources);

  // View toggle: classic list (default) vs kanban board. Kanban is
  // Alex's preferred sales-pipeline view; list is better for scan +
  // filter + CSV export workflows. URL state survives so a bookmark of
  // "?view=kanban" deep-links to the board.
  // Default to kanban (Alex's preferred view); `?view=list` is the
  // explicit opt-out. Treat anything else as kanban so a bookmark like
  // /commercial/opportunities just goes straight to the board.
  const viewRaw = pickFirst(sp.view);
  const viewMode: "list" | "kanban" = viewRaw === "list" ? "list" : "kanban";

  // Sort dropdown — Alex's Friday workflow needs the right lens at the
  // right time. recent = "what's been touched" (default), oldest = "what's
  // stuck", bid_high / bid_low = "biggest first / smallest first" for
  // pricing conversations, due_soon = "next-week urgency."
  const SORT_OPTIONS = [
    { key: "recent", label: "Most recently updated" },
    { key: "oldest", label: "Oldest / stuck deals" },
    { key: "bid_high", label: "Highest bid first" },
    { key: "due_soon", label: "Proposal due soonest" },
    { key: "probability_high", label: "Most likely to win" },
  ] as const;
  type SortKey = (typeof SORT_OPTIONS)[number]["key"];
  const sortRaw = pickFirst(sp.sort);
  const sortKey: SortKey =
    sortRaw && SORT_OPTIONS.some((o) => o.key === sortRaw)
      ? (sortRaw as SortKey)
      : "recent";
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

  // Apply sort after all filters so the ordering reflects exactly what
  // Alex is looking at. Stable secondary key on updated_at so ties land
  // in a predictable order (newest-touched-wins-tie).
  const stableTie = (a: CommercialOpportunity, b: CommercialOpportunity) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  opps = [...opps].sort((a, b) => {
    if (sortKey === "oldest") {
      return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
    }
    if (sortKey === "bid_high") {
      const diff = (b.bid_value_high_cents ?? -1) - (a.bid_value_high_cents ?? -1);
      return diff !== 0 ? diff : stableTie(a, b);
    }
    if (sortKey === "due_soon") {
      // Opps with NO proposal_due_at go to the bottom so the soonest
      // due rises to the top.
      const av = a.proposal_due_at ? new Date(a.proposal_due_at).getTime() : Infinity;
      const bv = b.proposal_due_at ? new Date(b.proposal_due_at).getTime() : Infinity;
      const diff = av - bv;
      return diff !== 0 ? diff : stableTie(a, b);
    }
    if (sortKey === "probability_high") {
      const diff = (b.probability_pct ?? 0) - (a.probability_pct ?? 0);
      return diff !== 0 ? diff : stableTie(a, b);
    }
    // "recent" default — already returned newest-first by listCommercialOpportunities.
    return stableTie(a, b);
  });

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
  if (sortKey !== "recent") baseParams.set("sort", sortKey);
  // Kanban is now the default — only list mode needs the URL param.
  if (viewMode === "list") baseParams.set("view", "list");

  // View toggle hrefs preserve the rest of the filter context.
  const viewToggleHref = (target: "list" | "kanban") => {
    const p = new URLSearchParams(baseParams);
    if (target === "list") p.set("view", "list");
    else p.delete("view");
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
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
  // Sort link builder — preserves every other URL param and just flips
  // the sort key. Drops the param when picking the default.
  const setSortHref = (newSort: string): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (validStatus) p.set("status", validStatus);
    if (sourceSet.size > 0) p.set("sources", Array.from(sourceSet).join(","));
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (viewMode === "list") p.set("view", "list");
    if (newSort !== "recent") p.set("sort", newSort);
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  // The CSV export endpoint takes the exact same params the page does
  // (including sort) so the download is "what the user sees, as a
  // spreadsheet" — row order included.
  const exportParams = new URLSearchParams(baseParams);
  if (staleFilter) exportParams.set("stale", "1");
  if (hotFilter) exportParams.set("hot", "1");
  // `sort` is already in baseParams when not the default.
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

  // Toggle: tapping a status pill drills in OR clears the filter if
  // that status is already active. Other chips (sources, hot, stale)
  // preserved either way so drilling in/out doesn't wipe context.
  const statusDrillHref = (s: OpportunityStatus) => {
    const p = new URLSearchParams(baseParams);
    if (validStatus === s) {
      p.delete("status"); // tap the active pill again to clear
    } else {
      p.set("status", s);
    }
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
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
        <div className="flex items-center gap-2 flex-wrap">
          {/* View toggle — kanban vs list. Sits next to the New CTA so
              the primary surface choice + the primary action are in
              the same neighborhood. Active view uses emerald to match
              the platform's "selected" language. */}
          <div className="inline-flex rounded-lg border border-ppp-charcoal-200 bg-white overflow-hidden">
            <Link
              href={viewToggleHref("list")}
              className={`px-3 py-2 text-[12px] font-medium min-h-[44px] inline-flex items-center touch-manipulation ${
                viewMode === "list"
                  ? "bg-emerald-50 text-emerald-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="List view — best for scanning + filtering + CSV export"
            >
              List
            </Link>
            <Link
              href={viewToggleHref("kanban")}
              className={`px-3 py-2 text-[12px] font-medium min-h-[44px] inline-flex items-center touch-manipulation border-l border-ppp-charcoal-200 ${
                viewMode === "kanban"
                  ? "bg-emerald-50 text-emerald-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="Kanban — drag deals through the pipeline (status-by-status)"
            >
              Kanban
            </Link>
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
        </div>
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

      {/* Search bar — replaces the old "Search field + Status dropdown
          + Filter button" trio Karan flagged as ugly. Status filtering
          now happens via the "Open by status" snapshot pills below
          (which are also the kanban column headers). One clean search
          input, magnifying-glass icon, auto-submit on Enter, and a
          single inline "Clear" chip when any filter is active. */}
      <form className="flex items-center gap-2 flex-wrap">
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
            placeholder="Search opportunities by title…"
            className="w-full pl-10 pr-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] shadow-sm"
          />
        </div>
        {/* Hidden status + view fields preserve them through search submit
            so picking a search doesn't reset status filtering. */}
        {validStatus && <input type="hidden" name="status" value={validStatus} />}
        {viewMode === "list" && <input type="hidden" name="view" value="list" />}
        {hotFilter && <input type="hidden" name="hot" value="1" />}
        {staleFilter && <input type="hidden" name="stale" value="1" />}
        {sourceSet.size > 0 && (
          <input type="hidden" name="sources" value={Array.from(sourceSet).join(",")} />
        )}
        {sortKey !== "recent" && <input type="hidden" name="sort" value={sortKey} />}
        {anyFilterActive && (
          <Link
            href={viewMode === "kanban" ? "/commercial/opportunities" : "/commercial/opportunities?view=list"}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ppp-charcoal-50 border border-ppp-charcoal-200 text-ppp-charcoal-700 text-[12px] font-medium hover:bg-ppp-charcoal-100 min-h-[44px] touch-manipulation shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6L6 18 M6 6l12 12" />
            </svg>
            Clear filters
          </Link>
        )}
      </form>

      {created && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700">
          Opportunity created.
        </div>
      )}
      {deletedTitle && (
        <div className="bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-lg px-4 py-3 text-sm text-ppp-charcoal-700 flex items-start justify-between gap-3">
          <span>
            Deleted <strong className="text-ppp-charcoal">{deletedTitle}</strong>. The record is soft-deleted — an admin can restore it.
          </span>
          <Link
            href="/commercial/opportunities"
            className="text-[12px] text-ppp-charcoal-600 hover:text-ppp-charcoal-800 underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
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
      {/* Hide "Open by status" pill row on KANBAN — the columns ARE the
          status filter, so the pills are redundant noise. List view still
          shows them (the list doesn't group by status visually so the
          chips give the same "where are deals sitting" snapshot Alex
          uses for triage). Karan flagged the kanban clutter 2026-06-24. */}
      {viewMode === "list" && statusSnapshot.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1.5 flex items-center justify-between">
            <span>Open by status</span>
            <span className="font-normal text-ppp-charcoal-400 normal-case tracking-normal text-[10px]">
              {validStatus ? "Tap active pill to clear" : "Tap to filter"}
            </span>
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
                      ? "bg-emerald-600 border-emerald-700 text-white"
                      : "bg-white border-ppp-charcoal-100 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                  }`}
                  title={isActive ? `Showing only ${opportunityStatusLabel(r.status)} — tap to clear` : `Filter to ${opportunityStatusLabel(r.status)}`}
                >
                  <span>{opportunityStatusLabel(r.status)}</span>
                  <strong className={isActive ? "text-white" : "text-ppp-charcoal"}>
                    {r.count}
                  </strong>
                  {isActive && <span aria-hidden className="text-white">×</span>}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Unified Sort & Filter dropdown — Karan 2026-06-16 round 4:
          merged the separate Sort picker + Filter chips into ONE
          button so the opps surface matches the accounts page. URL-
          driven; active count on the label. */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {(() => {
            const activeChipCount = (hotFilter ? 1 : 0) + (staleFilter ? 1 : 0) + sourceSet.size;
            const sortChanged = sortKey !== "recent";
            const activeCount = activeChipCount + (sortChanged ? 1 : 0);
            const currentSortLabel = SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Most recently updated";
            return (
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
                        key={o.key}
                        href={setSortHref(o.key)}
                        active={sortKey === o.key}
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
                        href={toggleHotHref}
                        active={hotFilter}
                        label={`🔥 Hot ($50k+ · <${HOT_DEAL_DECISION_DAYS}d)`}
                        description={`Bid ≥ $50k, proposal due within ${HOT_DEAL_DECISION_DAYS} days, still in play.`}
                      />
                      <FilterOption
                        href={toggleStaleHref}
                        active={staleFilter}
                        label={`Stale > ${STALE_OPP_DAYS}d`}
                        description={`Open opps with no update in over ${STALE_OPP_DAYS} days.`}
                      />
                    </div>
                  </div>
                  <div className="border-t border-ppp-charcoal-100 my-2 pt-2">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 mb-1">
                      By source
                    </div>
                    <div className="space-y-1">
                      {OPPORTUNITY_SOURCES.map((s) => (
                        <FilterOption
                          key={s}
                          href={toggleSourceHref(s)}
                          active={sourceSet.has(s)}
                          label={opportunitySourceLabel(s)}
                          description="How this opportunity came in."
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </details>
            );
          })()}
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
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
      </div>

      {/* List or Kanban — driven by ?view=kanban URL param. The empty
          state is shared (no opps = same message regardless of view). */}
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
      ) : viewMode === "kanban" ? (
        <KanbanBoard
          opps={opps}
          accountById={accountById}
          statusEnteredAtMap={statusEnteredAtMap}
          taskStatsMap={taskStatsMap}
          primaryLeadMap={primaryLeadMap}
          fileCountMap={fileCountMap}
        />
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

/**
 * Kanban board view — column per open status, card per opp. Click a
 * card to open the detail page. Each card has an inline "Next →"
 * dropdown using the existing quickFlipStatusAction (DAG-filtered) so
 * Alex moves deals forward without leaving the board.
 *
 * Columns scroll horizontally on mobile; vertical scroll within each
 * column when the stack is taller than the viewport. Terminal opps
 * (won/lost/no_bid) get their own collapsed footer summary rather than
 * a column each, since the value of the kanban is the LIVE pipeline.
 */
function KanbanBoard({
  opps,
  accountById,
  statusEnteredAtMap,
  taskStatsMap,
  primaryLeadMap,
  fileCountMap,
}: {
  opps: CommercialOpportunity[];
  accountById: Map<string, CommercialAccount>;
  statusEnteredAtMap: Map<string, string>;
  taskStatsMap: Map<string, { open: number; overdue: number; due_soon: number }>;
  primaryLeadMap: Map<string, { user_email: string; user_full_name: string | null; role: string }>;
  fileCountMap: Map<string, number>;
}) {
  // Open columns (7) + terminal columns (3) = 10. Terminal columns are
  // drop targets too — that's where the Win/Loss Debrief flow starts
  // (drag → bounce to detail page with debrief form pre-opened).
  // Karan 2026-06-24: was just the 7 open columns; users couldn't
  // drag-to-close because there was no Won/Lost/No-bid target.
  const OPEN_COLUMNS = OPEN_OPP_STATUSES as readonly OpportunityStatus[];
  const TERMINAL_COLUMNS: readonly OpportunityStatus[] = ["won", "lost", "no_bid"];
  const KANBAN_COLUMNS = [...OPEN_COLUMNS, ...TERMINAL_COLUMNS] as readonly OpportunityStatus[];
  const TERMINAL_DISPLAY_CAP = 10; // show most-recent N per terminal column; overflow lives in the Decided drawer

  const byStatus = new Map<OpportunityStatus, CommercialOpportunity[]>();
  for (const s of KANBAN_COLUMNS) byStatus.set(s, []);
  const overflowClosed: CommercialOpportunity[] = []; // beyond the per-column cap, listed in the Decided drawer
  // First bucket all opps by status.
  for (const o of opps) {
    if (KANBAN_COLUMNS.includes(o.status as OpportunityStatus)) {
      byStatus.get(o.status as OpportunityStatus)!.push(o);
    }
  }
  // Then cap terminal columns + move overflow to the drawer. Sort
  // terminal columns by decided_at DESC (most recently closed first).
  for (const s of TERMINAL_COLUMNS) {
    const list = byStatus.get(s) ?? [];
    list.sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""));
    if (list.length > TERMINAL_DISPLAY_CAP) {
      const visible = list.slice(0, TERMINAL_DISPLAY_CAP);
      const overflow = list.slice(TERMINAL_DISPLAY_CAP);
      byStatus.set(s, visible);
      overflowClosed.push(...overflow);
    }
  }
  return (
    <KanbanDnDProvider>
    <div className="space-y-3">
      <div className="text-[11px] text-ppp-charcoal-500 px-1 flex flex-wrap gap-x-3 gap-y-1">
        <span>💡 Drag a card between columns to move the deal forward. Dragging to <strong>Won / Lost / No-bid</strong> opens a quick debrief.</span>
        <span className="text-ppp-charcoal-400">Sort applies within each column.</span>
      </div>
      <div className="overflow-x-auto -mx-2 px-2 pb-2">
        <div className="flex gap-3 min-w-max">
          {KANBAN_COLUMNS.map((status) => {
            const colOpps = byStatus.get(status) ?? [];
            const colTotal = colOpps.reduce(
              (acc, o) => acc + (o.bid_value_high_cents ?? o.bid_value_low_cents ?? 0),
              0
            );
            // Distinct visual treatment by status family — Won/Lost/No-bid
            // get terminal tints (emerald/rose/slate). Reopened gets a
            // blue tint to signal "re-engaged — needs re-routing" so it
            // visually stands out from the regular pipeline.
            const tone =
              status === "won"
                ? { col: "bg-emerald-50/40 border-emerald-200", head: "bg-emerald-50 border-emerald-200" }
                : status === "lost"
                ? { col: "bg-rose-50/40 border-rose-200", head: "bg-rose-50 border-rose-200" }
                : status === "no_bid"
                ? { col: "bg-slate-50 border-slate-200", head: "bg-slate-100 border-slate-200" }
                : status === "reopened"
                ? { col: "bg-blue-50/40 border-blue-200", head: "bg-blue-50 border-blue-200" }
                : { col: "bg-ppp-charcoal-50/60 border-ppp-charcoal-100", head: "bg-white border-ppp-charcoal-100" };
            return (
              <KanbanDnDColumn key={status} status={status}>
              <div className={`w-72 sm:w-80 shrink-0 border rounded-xl overflow-hidden flex flex-col h-full ${tone.col}`}>
                <div className={`px-3 py-2 border-b ${tone.head}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-ppp-charcoal">
                      {opportunityStatusLabel(status)}
                    </span>
                    <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-white/70 text-ppp-charcoal-700 text-[11px] font-semibold border border-ppp-charcoal-100">
                      {colOpps.length}
                    </span>
                  </div>
                  {colTotal > 0 && (
                    <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                      {formatCents(colTotal)} top-of-range
                    </div>
                  )}
                </div>
                <ul className="p-2 space-y-2 overflow-y-auto max-h-[70vh] min-h-[120px]">
                  {colOpps.length === 0 ? (
                    <li className="text-[11px] text-ppp-charcoal-400 italic text-center py-6">
                      {status === "won"
                        ? "Drag a winning deal here"
                        : status === "lost"
                        ? "Drag a lost deal here"
                        : status === "no_bid"
                        ? "Deals we passed on"
                        : status === "reopened"
                        ? "Reopened deals land here — drop them back into the right column"
                        : "Drop a deal here"}
                    </li>
                  ) : (
                    colOpps.map((opp) => (
                      <KanbanDnDCard key={opp.id} oppId={opp.id}>
                        <KanbanCard
                          opp={opp}
                          account={accountById.get(opp.account_id) ?? null}
                          statusEnteredAt={statusEnteredAtMap.get(opp.id) ?? null}
                          taskStats={taskStatsMap.get(opp.id) ?? null}
                          primaryLead={primaryLeadMap.get(opp.id) ?? null}
                          fileCount={fileCountMap.get(opp.id) ?? 0}
                        />
                      </KanbanDnDCard>
                    ))
                  )}
                </ul>
              </div>
              </KanbanDnDColumn>
            );
          })}
        </div>
      </div>
      {/* Overflow drawer — only shows when a terminal column hit the
          per-column display cap (10). Lets users still reach older
          decided opps without scrolling forever in a single column. */}
      {overflowClosed.length > 0 && (
        <details className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <summary className="px-4 py-2.5 cursor-pointer text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between min-h-[44px] touch-manipulation">
            <span>Older decided deals · {overflowClosed.length}</span>
            <span aria-hidden className="text-ppp-charcoal-400">▾</span>
          </summary>
          <ul className="divide-y divide-ppp-charcoal-100 px-3 py-2">
            {overflowClosed.map((opp) => (
              <li key={opp.id} className="py-2">
                <Link
                  href={`/commercial/opportunities/${opp.id}`}
                  className="text-[13px] text-emerald-700 hover:text-emerald-800 underline"
                >
                  {opp.title}
                </Link>
                <span className="text-[11px] text-ppp-charcoal-500 ml-2">
                  {opportunityStatusLabel(opp.status)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
    </KanbanDnDProvider>
  );
}

function KanbanCard({
  opp,
  account,
  statusEnteredAt,
  taskStats,
  primaryLead,
  fileCount,
}: {
  opp: CommercialOpportunity;
  account: CommercialAccount | null;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: string } | null;
  fileCount: number;
}) {
  const nextStatuses = allowedNextStatuses(opp.status);
  const days = statusEnteredAt
    ? Math.floor((Date.now() - new Date(statusEnteredAt).getTime()) / MS_PER_DAY)
    : null;
  const daysTone =
    days === null
      ? "text-ppp-charcoal-400"
      : days > 14
      ? "text-rose-600"
      : days > 7
      ? "text-amber-600"
      : "text-emerald-600";
  const leadFirst = primaryLead
    ? primaryLead.user_full_name?.split(" ")[0] ?? primaryLead.user_email.split("@")[0]
    : null;
  return (
    <li className="bg-white border border-ppp-charcoal-100 rounded-lg p-2.5 hover:border-ppp-charcoal-200 transition-colors">
      <Link
        href={`/commercial/opportunities/${opp.id}`}
        className="block"
      >
        <div className="text-[13px] font-semibold text-ppp-charcoal leading-snug mb-1 break-words">
          {opp.title || "(untitled)"}
        </div>
        {account && (
          <div className="text-[11px] text-ppp-charcoal-500 mb-1.5 truncate">
            {account.company_name}
          </div>
        )}
        <div className="text-[12px] font-medium text-ppp-charcoal-800">
          {formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
        </div>
        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          <span>{opp.probability_pct}%</span>
          {days !== null && (
            <span className={daysTone}>· {days}d here</span>
          )}
          {leadFirst && (
            <span>· ★ {leadFirst}</span>
          )}
          {taskStats && taskStats.overdue > 0 && (
            <span className="text-rose-600">· {taskStats.overdue} overdue</span>
          )}
          {fileCount > 0 && (
            <span>· 📎 {fileCount}</span>
          )}
        </div>
      </Link>
      {nextStatuses.length > 0 && (
        <form action={quickFlipStatusAction} className="mt-2 pt-2 border-t border-ppp-charcoal-100 flex items-center gap-1.5">
          <input type="hidden" name="opp_id" value={opp.id} />
          <select
            name="to_status"
            defaultValue=""
            required
            className={`${SELECT_CLS} flex-1 text-[12px] sm:text-xs py-1.5 min-h-[44px] sm:min-h-[36px]`}
            style={SELECT_BG_STYLE}
            aria-label={`Move ${opp.title}`}
          >
            <option value="" disabled>Move to…</option>
            {nextStatuses.map((s) => {
              const isTerminal = s === "won" || s === "lost" || s === "no_bid";
              return (
                <option key={s} value={s}>
                  {isTerminal ? "→ Close as " : "→ "}{opportunityStatusLabel(s)}
                </option>
              );
            })}
          </select>
          <button
            type="submit"
            className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
          >
            Go
          </button>
        </form>
      )}
    </li>
  );
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

/** Sort dropdown row — radio-style. Mirrors the accounts-page
 *  SortOption shape for visual consistency. URL link sets the sort
 *  key + preserves every other filter on the URL. */
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
 *  Mirrors the accounts-page FilterOption shape for visual consistency. */
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
  tone: "neutral" | "cold" | "hot";
  children: React.ReactNode;
  /** Native browser tooltip — hover on desktop, long-press on mobile.
   *  Explains the chip's filter criteria for users who don't recognize
   *  the abbreviated label. */
  title?: string;
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
  // Quick-flip dropdown options — ALL DAG-valid next statuses, including
  // terminal won/lost/no_bid. Picking a terminal state triggers a redirect
  // to the detail page via quickFlipStatusAction's server-side check
  // (line 57) so the user can fill out the structured debrief. Karan
  // 2026-06-24: previously hid terminal here — broke the discoverability
  // of "how do I mark a deal closed" since users only had kanban-drag.
  const nextStatuses = allowedNextStatuses(opportunity.status);
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
            className={`${SELECT_CLS} text-[12px] sm:text-sm py-1.5 min-h-[36px]`}
            style={SELECT_BG_STYLE}
          >
            <option value="" disabled>
              Next status…
            </option>
            {nextStatuses.map((s) => {
              const isTerminal = s === "won" || s === "lost" || s === "no_bid";
              return (
                <option key={s} value={s}>
                  {isTerminal ? "→ Close as " : "→ "}{opportunityStatusLabel(s)}
                </option>
              );
            })}
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
