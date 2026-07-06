/**
 * `/commercial/opportunities` — Phase 2 Opportunity Pipeline list page.
 *
 * UI rebuild 2026-07-05 (Karan: "confusing and unorganized, 100x better").
 * Same principles applied as the accounts page rebuild:
 *   1. One unified toolbar — search + view toggle + filter popover +
 *      sort popover + export + New CTA. Replaces the scattered
 *      3-tile-strip + 5-chip-row + separate Sort dropdown + Export
 *      button + Status snapshot layout.
 *   2. Slim KPI strip below the title — Open opps · Bid range ·
 *      Weighted pipeline · Wins this month. Left accent stripe + tint.
 *   3. Status snapshot pills preserved but now rendered as a secondary
 *      strip inside a unified surface, list-view only (kanban has
 *      columns for status).
 *   4. OpportunityRow simplified to a 3-line hierarchy: primary line
 *      (title + status + bid + due chip), meta line (account · rating ·
 *      prequal · confidence), signals line (days-in-status · tasks ·
 *      last-note · lead · files · finishes · submittals). Tab-jump chips
 *      + quick-flip form kept but reorganized into a right-side action
 *      column so the row header stays clean.
 *
 * Zero backend changes: every URL param read, server action call, data
 * fetch, and DAG rule is byte-identical to the prior version. Only the
 * visual layout + component composition changed.
 */
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
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
  HOT_DEAL_ACTIVE_STATUSES,
  isTerminalOpportunityStatus,
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
import { listSubmittalCountByOpp } from "@/lib/commercial/opportunities/submittals";
import { listFinishCountByOpp } from "@/lib/commercial/opportunities/finishes";
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
  if (to_status === "lost" || to_status === "no_bid") {
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
  if (to_status === "won") {
    const { postPlaceholderAutoNote } = await import("@/lib/commercial/win-loss/debrief");
    await postPlaceholderAutoNote({ opportunityId: opp_id, outcome: "won", actorUserId: user.id });
    redirect(`/commercial/opportunities/${opp_id}?tab=debrief&just_closed=1`);
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
  const createdTitle = pickFirst(sp.created_title);
  const statusOk = pickFirst(sp.status_ok) === "1";
  const statusError = pickFirst(sp.status_error);
  const deletedTitle = pickFirst(sp.deleted);

  const staleFilter = pickFirst(sp.stale) === "1";
  const hotFilter = pickFirst(sp.hot) === "1";
  const sourcesRaw = pickFirst(sp.sources);

  const viewRaw = pickFirst(sp.view);
  const viewMode: "list" | "kanban" = viewRaw === "list" ? "list" : "kanban";

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

  const [oppsRaw, accounts] = await Promise.all([
    listCommercialOpportunities({ search, status: validStatus }),
    listCommercialAccounts(),
  ]);
  const accountById = new Map<string, CommercialAccount>(accounts.map((a) => [a.id, a]));

  const oppIds = oppsRaw.map((o) => o.id);
  const [
    statusEnteredAtMap,
    taskStatsMap,
    lastNoteMap,
    primaryLeadMap,
    fileCountMap,
    submittalCountMap,
    finishCountMap,
  ] = await Promise.all([
    listCurrentStatusEnteredAtByOpp(oppIds),
    listOpenTaskStatsByOpp(oppIds),
    listLastNoteByOpp(oppIds),
    listPrimaryLeadByOpp(oppIds),
    listAttachmentCountByOpp(oppIds),
    listSubmittalCountByOpp(oppIds),
    listFinishCountByOpp(oppIds),
  ]);

  let opps = oppsRaw;
  if (staleFilter) {
    opps = opps.filter((o) => {
      if (!(OPEN_OPP_STATUSES as readonly string[]).includes(o.status)) return false;
      const days = Math.floor((Date.now() - new Date(o.updated_at).getTime()) / MS_PER_DAY);
      return Number.isFinite(days) && days >= STALE_OPP_DAYS;
    });
  }
  if (hotFilter) {
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
      const av = a.proposal_due_at ? new Date(a.proposal_due_at).getTime() : Infinity;
      const bv = b.proposal_due_at ? new Date(b.proposal_due_at).getTime() : Infinity;
      const diff = av - bv;
      return diff !== 0 ? diff : stableTie(a, b);
    }
    if (sortKey === "probability_high") {
      const diff = (b.probability_pct ?? 0) - (a.probability_pct ?? 0);
      return diff !== 0 ? diff : stableTie(a, b);
    }
    return stableTie(a, b);
  });

  const openOpps = opps.filter((o) => (OPEN_OPP_STATUSES as readonly string[]).includes(o.status));
  const totalPipelineCents = openOpps.reduce((acc, o) => acc + weightedPipelineCents(o), 0);
  const totalBidLowCents = openOpps.reduce((acc, o) => acc + (o.bid_value_low_cents ?? 0), 0);
  const totalBidHighCents = openOpps.reduce((acc, o) => acc + (o.bid_value_high_cents ?? 0), 0);
  // Wins this month — mirrors the /commercial dashboard KPI so the two
  // surfaces agree. Uses UTC-month-start; close enough for exec-review
  // "how'd we do this month" scan.
  const now = new Date();
  const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const wonThisMonth = oppsRaw.filter((o) => o.status === "won" && (o.decided_at ?? "") >= monthStartIso).length;

  // URL builders — behavior unchanged from prior file.
  const baseParams = new URLSearchParams();
  if (search) baseParams.set("q", search);
  if (validStatus) baseParams.set("status", validStatus);
  if (sourceSet.size > 0) baseParams.set("sources", Array.from(sourceSet).join(","));
  if (sortKey !== "recent") baseParams.set("sort", sortKey);
  if (viewMode === "list") baseParams.set("view", "list");

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
  const clearFilterHref = (drop: "q" | "status" | "hot" | "stale" | "sources"): string => {
    const p = new URLSearchParams();
    if (search && drop !== "q") p.set("q", search);
    if (validStatus && drop !== "status") p.set("status", validStatus);
    if (hotFilter && drop !== "hot") p.set("hot", "1");
    if (staleFilter && drop !== "stale") p.set("stale", "1");
    if (sourceSet.size > 0 && drop !== "sources") p.set("sources", Array.from(sourceSet).join(","));
    if (sortKey !== "recent") p.set("sort", sortKey);
    if (viewMode === "list") p.set("view", "list");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  const exportParams = new URLSearchParams(baseParams);
  if (staleFilter) exportParams.set("stale", "1");
  if (hotFilter) exportParams.set("hot", "1");
  const exportHref = `/api/commercial/opportunities/export${exportParams.toString() ? `?${exportParams.toString()}` : ""}`;

  const anyFilterActive =
    !!search || !!validStatus || staleFilter || hotFilter || sourceSet.size > 0;
  const sortChanged = sortKey !== "recent";
  const activeFilterCount =
    (search ? 1 : 0) + (validStatus ? 1 : 0) +
    (hotFilter ? 1 : 0) + (staleFilter ? 1 : 0) + sourceSet.size;
  const currentSortLabel = SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Most recently updated";

  const statusSnapshot: Array<{ status: OpportunityStatus; count: number }> = (
    OPEN_OPP_STATUSES as readonly OpportunityStatus[]
  )
    .map((s) => ({ status: s, count: openOpps.filter((o) => o.status === s).length }))
    .filter((r) => r.count > 0);

  const statusDrillHref = (s: OpportunityStatus) => {
    const p = new URLSearchParams(baseParams);
    if (validStatus === s) {
      p.delete("status");
    } else {
      p.set("status", s);
    }
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  return (
    <div className="space-y-5">
      {/* ─── Hero + slim KPI strip ─── */}
      <header className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
              Opportunities
            </h1>
            <p className="mt-1 text-sm text-ppp-charcoal-500">
              The deal record. From inquiry through won — every commercial bid.
            </p>
          </div>
          <Link
            href="/commercial/opportunities/new"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors touch-manipulation shadow-sm shadow-cc-brand-600/30 min-h-[44px] shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14 M5 12h14" />
            </svg>
            New opportunity
          </Link>
        </div>

        {/* KPI strip. Red primary = Open opps count. Blue supporting =
            Weighted pipeline + Wins this month. Neutral = bid range. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            tone="cc-brand"
            label="Open opportunities"
            value={openOpps.length.toString()}
            sub={`${opps.length - openOpps.length} closed`}
          />
          <KpiCard
            tone="cc-brand"
            label="Weighted pipeline"
            value={formatCents(totalPipelineCents)}
            sub="Σ midpoint × probability"
          />
          <KpiCard
            tone="neutral"
            label="Bid range (open)"
            value={
              totalBidLowCents === 0 && totalBidHighCents === 0
                ? "—"
                : `${formatCents(totalBidLowCents)}–${formatCents(totalBidHighCents)}`
            }
            sub="low + high across open deals"
          />
          <KpiCard
            tone="blue"
            label="Wins this month"
            value={wonThisMonth.toString()}
            sub={wonThisMonth === 0 ? "no closes yet" : "and counting"}
          />
        </div>
      </header>

      {/* ─── Result banners ─── */}
      {(created || deletedTitle || statusOk || statusError) && (
        <div className="space-y-2">
          {created && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
              <span aria-hidden>✓</span>
              <span className="flex-1">
                {createdTitle ? (
                  <><strong>{createdTitle}</strong> logged. Ready for the next bid.</>
                ) : (
                  "Opportunity created."
                )}
              </span>
            </div>
          )}
          {deletedTitle && (
            <div className="bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-xl px-4 py-3 text-sm text-ppp-charcoal-700 flex items-start justify-between gap-3">
              <span>
                Deleted <strong className="text-ppp-charcoal">{deletedTitle}</strong>. Soft-deleted — an admin can restore it.
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
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start justify-between gap-3">
              <span>Status updated.</span>
              <Link
                href="/commercial/opportunities"
                className="text-[12px] text-blue-700 hover:text-blue-900 underline shrink-0 min-h-[24px] inline-flex items-center"
              >
                Dismiss
              </Link>
            </div>
          )}
          {statusError && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800 flex items-start justify-between gap-3">
              <span>{statusError}</span>
              <Link
                href="/commercial/opportunities"
                className="text-[12px] text-rose-700 hover:text-rose-900 underline shrink-0 min-h-[24px] inline-flex items-center"
              >
                Dismiss
              </Link>
            </div>
          )}
        </div>
      )}

      {/* ─── Toolbar: single row. Search + View toggle + Filter popover
          + Sort popover + Export + Clear. ─── */}
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
              placeholder="Search opportunities by title…"
              className="w-full pl-10 pr-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]"
            />
          </div>
          {validStatus && <input type="hidden" name="status" value={validStatus} />}
          {viewMode === "list" && <input type="hidden" name="view" value="list" />}
          {hotFilter && <input type="hidden" name="hot" value="1" />}
          {staleFilter && <input type="hidden" name="stale" value="1" />}
          {sourceSet.size > 0 && (
            <input type="hidden" name="sources" value={Array.from(sourceSet).join(",")} />
          )}
          {sortKey !== "recent" && <input type="hidden" name="sort" value={sortKey} />}

          {/* View toggle — segmented control. Kanban is default, list
              is the explicit opt-out. */}
          <div className="inline-flex rounded-lg border border-ppp-charcoal-200 bg-white overflow-hidden shrink-0">
            <Link
              href={viewToggleHref("kanban")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1.5 touch-manipulation ${
                viewMode === "kanban"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="Kanban — drag deals through the pipeline"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="18" rx="1" />
                <rect x="14" y="3" width="7" height="12" rx="1" />
              </svg>
              Kanban
            </Link>
            <Link
              href={viewToggleHref("list")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1.5 touch-manipulation border-l border-ppp-charcoal-200 ${
                viewMode === "list"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="List view — best for scanning + filtering + CSV export"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              List
            </Link>
          </div>

          {/* Filter popover — hot / stale / source multi-select all live
              here. Native <details> for zero-JS state. */}
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
            <div className="absolute right-0 sm:right-auto mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-3 min-w-[320px] max-w-[calc(100vw-1rem)] max-h-[75vh] overflow-y-auto space-y-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 mb-1">
                  Priority
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
              <div className="border-t border-ppp-charcoal-100 pt-3">
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

          {/* Sort popover. */}
          <details className="relative inline-block group">
            <summary
              className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[13px] font-semibold min-h-[44px] touch-manipulation transition-colors ${
                sortChanged
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
            <div className="absolute right-0 mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-2 min-w-[260px] max-w-[calc(100vw-1rem)]">
              <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 pt-2 pb-1">
                Sort by
              </div>
              <div className="space-y-0.5">
                {SORT_OPTIONS.map((o) => (
                  <SortOption
                    key={o.key}
                    href={setSortHref(o.key)}
                    active={sortKey === o.key}
                    label={o.label}
                  />
                ))}
              </div>
            </div>
          </details>

          {/* Export CSV — takes the same params as the visible list. */}
          <a
            href={exportHref}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
            title="Download the current filter view as CSV"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
            </svg>
            Export
          </a>

          {anyFilterActive && (
            <Link
              // Preserve view mode when clearing filters — dropping filters
              // shouldn't yank the user from list view back to kanban default.
              href={viewMode === "list" ? "/commercial/opportunities?view=list" : "/commercial/opportunities"}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-600 text-[12px] font-medium hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6L6 18 M6 6l12 12" />
              </svg>
              Clear
            </Link>
          )}
        </form>

        {/* Active filter chip strip — shows what's applied so users can
            drop one at a time without opening the popover. */}
        {anyFilterActive && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">
              Applied:
            </span>
            {search && <ActiveFilterChip href={clearFilterHref("q")} label={`Search: "${search}"`} />}
            {validStatus && <ActiveFilterChip href={clearFilterHref("status")} label={`Status: ${opportunityStatusLabel(validStatus)}`} />}
            {hotFilter && <ActiveFilterChip href={clearFilterHref("hot")} label="🔥 Hot" />}
            {staleFilter && <ActiveFilterChip href={clearFilterHref("stale")} label={`Stale > ${STALE_OPP_DAYS}d`} />}
            {sourceSet.size > 0 && (
              <ActiveFilterChip
                href={clearFilterHref("sources")}
                label={`Source: ${Array.from(sourceSet).map((s) => opportunitySourceLabel(s)).join(", ")}`}
              />
            )}
          </div>
        )}
      </div>

      {/* ─── Status snapshot (list mode only — kanban columns ARE the
          snapshot) ─── */}
      {viewMode === "list" && statusSnapshot.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-2 flex items-center justify-between">
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
                      ? "bg-cc-brand-600 border-cc-brand-700 text-white"
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

      {/* ─── List / Kanban / Empty ─── */}
      {opps.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-12 text-center">
          <div aria-hidden className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" />
            </svg>
          </div>
          <div className="text-sm font-semibold text-ppp-charcoal">
            {anyFilterActive ? "No opportunities match these filters" : "No opportunities yet"}
          </div>
          <p className="mt-1 text-sm text-ppp-charcoal-500">
            {anyFilterActive
              ? "Try clearing a filter or use search to find a specific bid."
              : "Log the first commercial deal to get started."}
          </p>
          {!anyFilterActive ? (
            <Link
              href="/commercial/opportunities/new"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New opportunity
            </Link>
          ) : (
            <Link
              href="/commercial/opportunities"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              Clear all filters
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
          submittalCountMap={submittalCountMap}
          finishCountMap={finishCountMap}
        />
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-ppp-charcoal">
                {opps.length} opportunit{opps.length === 1 ? "y" : "ies"}
              </h2>
              <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                Sorted by {currentSortLabel.toLowerCase()}
              </p>
            </div>
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
                submittalStats={submittalCountMap.get(o.id) ?? null}
                finishCount={finishCountMap.get(o.id) ?? 0}
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
 * Kanban board — same shape as the prior implementation. Columns +
 * terminal drop targets + overflow drawer preserved unchanged. Only
 * the drag-hint header re-worded slightly for clarity.
 */
function KanbanBoard({
  opps,
  accountById,
  statusEnteredAtMap,
  taskStatsMap,
  primaryLeadMap,
  fileCountMap,
  submittalCountMap,
  finishCountMap,
}: {
  opps: CommercialOpportunity[];
  accountById: Map<string, CommercialAccount>;
  statusEnteredAtMap: Map<string, string>;
  taskStatsMap: Map<string, { open: number; overdue: number; due_soon: number }>;
  primaryLeadMap: Map<string, { user_email: string; user_full_name: string | null; role: string }>;
  fileCountMap: Map<string, number>;
  submittalCountMap: Map<string, { total: number; awaiting_response: number }>;
  finishCountMap: Map<string, number>;
}) {
  const OPEN_COLUMNS = OPEN_OPP_STATUSES as readonly OpportunityStatus[];
  const TERMINAL_COLUMNS: readonly OpportunityStatus[] = ["won", "lost", "no_bid"];
  const KANBAN_COLUMNS = [...OPEN_COLUMNS, ...TERMINAL_COLUMNS] as readonly OpportunityStatus[];
  const TERMINAL_DISPLAY_CAP = 10;

  const byStatus = new Map<OpportunityStatus, CommercialOpportunity[]>();
  for (const s of KANBAN_COLUMNS) byStatus.set(s, []);
  const overflowClosed: CommercialOpportunity[] = [];
  for (const o of opps) {
    if (KANBAN_COLUMNS.includes(o.status as OpportunityStatus)) {
      byStatus.get(o.status as OpportunityStatus)!.push(o);
    }
  }
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
  // Karan 2026-07-05: "so many statuses and its a lot to scroll thru."
  // Split the board into two flex-groups so users see the OPEN pipeline
  // (main flow) first, then a narrower "Closed" cluster grouped visually
  // at the far right. Drag-drop targets stay intact — each terminal
  // column still exists as a separate drop zone so the debrief flow
  // still routes correctly on drop.
  return (
    <KanbanDnDProvider>
      <div className="space-y-3">
        <div className="inline-flex items-center gap-2 text-[11px] text-ppp-charcoal-600 bg-blue-50 border border-blue-100 rounded-full px-3 py-1.5">
          <span aria-hidden>💡</span>
          <span>
            Drag a card between stages to move it forward. Drop into <strong>Won / Lost / No-bid</strong> to close the deal.
          </span>
        </div>
        <div className="overflow-x-auto -mx-2 px-2 pb-2">
          <div className="flex gap-3 min-w-max items-stretch">
            {/* Open pipeline — 8 wide columns for the active flow. */}
            {OPEN_COLUMNS.map((status) => {
              const colOpps = byStatus.get(status) ?? [];
              const colTotal = colOpps.reduce(
                (acc, o) => acc + (o.bid_value_high_cents ?? o.bid_value_low_cents ?? 0),
                0
              );
              const tone =
                status === "reopened"
                  ? { col: "bg-blue-50/40 border-blue-200", head: "bg-blue-50 border-blue-200" }
                  : { col: "bg-ppp-charcoal-50/60 border-ppp-charcoal-100", head: "bg-white border-ppp-charcoal-100" };
              return (
                <KanbanDnDColumn key={status} status={status}>
                  <div className={`w-64 sm:w-72 shrink-0 border rounded-xl overflow-hidden flex flex-col h-full ${tone.col}`}>
                    <div className={`px-3 py-2 border-b ${tone.head}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] font-bold text-ppp-charcoal">
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
                          {status === "reopened" ? "Reopened deals land here" : "Drop a deal here"}
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
                              submittalStats={submittalCountMap.get(opp.id) ?? null}
                              finishCount={finishCountMap.get(opp.id) ?? 0}
                            />
                          </KanbanDnDCard>
                        ))
                      )}
                    </ul>
                  </div>
                </KanbanDnDColumn>
              );
            })}

            {/* Closed cluster — 3 narrow stacked drop-target columns.
                Visually grouped inside a single "Closed" outer card so
                the eye reads them as one section. Each is still a
                separate KanbanDnDColumn so drag-to-Won vs drag-to-Lost
                still triggers the correct debrief routing. Narrower
                (w-44) so all 3 fit in the horizontal space one normal
                column used to take. */}
            <div className="shrink-0 border rounded-xl overflow-hidden flex flex-col h-full bg-white border-ppp-charcoal-100">
              <div className="px-3 py-2 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-bold text-ppp-charcoal uppercase tracking-wide">
                    Closed
                  </span>
                  <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-white text-ppp-charcoal-700 text-[11px] font-semibold border border-ppp-charcoal-100">
                    {TERMINAL_COLUMNS.reduce((acc, s) => acc + (byStatus.get(s)?.length ?? 0), 0)}
                  </span>
                </div>
                <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                  Drop here to close the deal
                </div>
              </div>
              {/* Cluster interior — stacks vertically on narrow phones (<640px)
                  so the 3 sub-columns don't force horizontal scroll inside
                  the already-narrow board layout. Side-by-side from sm+. */}
              <div className="flex flex-col sm:flex-row gap-2 p-2">
                {TERMINAL_COLUMNS.map((status) => {
                  const colOpps = byStatus.get(status) ?? [];
                  const tone =
                    status === "won"
                      ? { col: "bg-emerald-50/40 border-emerald-200", head: "bg-emerald-100 border-emerald-200 text-emerald-800" }
                      : status === "lost"
                      ? { col: "bg-rose-50/40 border-rose-200", head: "bg-rose-100 border-rose-200 text-rose-800" }
                      : { col: "bg-slate-50 border-slate-200", head: "bg-slate-100 border-slate-200 text-slate-700" };
                  return (
                    <KanbanDnDColumn key={status} status={status}>
                      <div className={`w-full sm:w-44 lg:w-48 shrink-0 border rounded-lg overflow-hidden flex flex-col h-full ${tone.col}`}>
                        <div className={`px-2 py-1.5 border-b ${tone.head}`}>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-bold uppercase tracking-wide">
                              {opportunityStatusLabel(status)}
                            </span>
                            <span className="inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded-full bg-white/80 text-ppp-charcoal-700 text-[10px] font-semibold">
                              {colOpps.length}
                            </span>
                          </div>
                        </div>
                        <ul className="p-1.5 space-y-1.5 overflow-y-auto max-h-[70vh] min-h-[64px]">
                          {colOpps.length === 0 ? (
                            <li className="text-[10px] text-ppp-charcoal-400 italic text-center py-3 leading-tight">
                              {status === "won" ? "Drop a winning deal" : status === "lost" ? "Drop a lost deal" : "Drop a no-bid deal"}
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
                                  submittalStats={submittalCountMap.get(opp.id) ?? null}
                                  finishCount={finishCountMap.get(opp.id) ?? 0}
                                  compact
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
          </div>
        </div>
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
                    className="text-[13px] text-blue-700 hover:text-blue-800 underline"
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
  submittalStats,
  finishCount,
  compact,
}: {
  opp: CommercialOpportunity;
  account: CommercialAccount | null;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: string } | null;
  fileCount: number;
  submittalStats: { total: number; awaiting_response: number } | null;
  finishCount: number;
  /** Compact mode — used inside the narrow "Closed" cluster where cards
   *  have half the horizontal space of the open pipeline. Hides quick-flip
   *  form + trims the meta band to just title + bid. */
  compact?: boolean;
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
      : "text-cc-brand-600";
  const leadFirst = primaryLead
    ? primaryLead.user_full_name?.split(" ")[0] ?? primaryLead.user_email.split("@")[0]
    : null;
  if (compact) {
    // Compact mode — used inside the narrow "Closed" cluster. Just
    // title + account + bid; no quick-flip form (closed deals shouldn't
    // be re-routed by drag, they go through the Reopen action instead).
    return (
      <li className="bg-white border border-ppp-charcoal-100 rounded-md p-1.5 hover:border-ppp-charcoal-200 transition-colors">
        <Link href={`/commercial/opportunities/${opp.id}`} className="block">
          <div className="text-[11px] font-semibold text-ppp-charcoal leading-snug break-words line-clamp-2">
            {opp.title || "(untitled)"}
          </div>
          {account && (
            <div className="text-[10px] text-ppp-charcoal-500 mt-0.5 truncate">
              {account.company_name}
            </div>
          )}
          <div className="text-[10px] font-medium text-ppp-charcoal-700 mt-0.5">
            {formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
          </div>
        </Link>
      </li>
    );
  }
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
            <span>· <span aria-hidden>★</span> {leadFirst}</span>
          )}
          {taskStats && taskStats.overdue > 0 && (
            <span className="text-rose-600">· {taskStats.overdue} overdue</span>
          )}
          {fileCount > 0 && (
            <span>· <span aria-hidden>📎</span> {fileCount}</span>
          )}
          {finishCount > 0 && (
            <span>· <span aria-hidden>🎨</span> {finishCount}</span>
          )}
          {submittalStats && submittalStats.total > 0 && (
            <span className={submittalStats.awaiting_response > 0 ? "text-sky-700 font-medium" : undefined}>
              · <span aria-hidden>📋</span> {submittalStats.total}
              {submittalStats.awaiting_response > 0 && ` (${submittalStats.awaiting_response} awaiting)`}
            </span>
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
            className={`${SELECT_CLS} flex-1 text-base sm:text-xs py-1.5 min-h-[44px] sm:min-h-[36px]`}
            style={SELECT_BG_STYLE}
            aria-label={`Move ${opp.title}`}
          >
            <option value="" disabled>Move to…</option>
            {nextStatuses.map((s) => {
              const isTerminal = isTerminalOpportunityStatus(s);
              return (
                <option key={s} value={s}>
                  {isTerminal ? "→ Close as " : "→ "}{opportunityStatusLabel(s)}
                </option>
              );
            })}
          </select>
          <button
            type="submit"
            className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-cc-brand-600 text-white hover:bg-cc-brand-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
          >
            Go
          </button>
        </form>
      )}
    </li>
  );
}

/**
 * Slim KPI card — same shape as the accounts page. Consistency across
 * both list pages so users learn the pattern once.
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
      ? "border-blue-200 bg-gradient-to-br from-white to-blue-50/50"
      : "border-ppp-charcoal-100 bg-white";
  const stripe =
    tone === "cc-brand" ? "bg-cc-brand-600" : tone === "blue" ? "bg-blue-500" : "bg-ppp-charcoal-200";
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

/**
 * One-click "remove this specific filter" chip. Same shape as the
 * accounts page ActiveFilterChip for visual consistency.
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
        active ? "bg-blue-50 hover:bg-blue-100" : "hover:bg-ppp-charcoal-50"
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
        <div className={`text-[13px] font-semibold ${active ? "text-blue-800" : "text-ppp-charcoal"}`}>
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
 * Opportunity row — redesigned 3-line hierarchy:
 *   Line 1: title + status pill + DueChip
 *   Line 2: account · rating · prequal · bid · confidence
 *   Line 3: days-in-status · tasks · last-note · lead · files · finishes · submittals
 *   Line 4 (conditional): tab-jump chips (finishes / submittals with awaiting)
 *   Line 5 (conditional): quick-flip form
 *
 * Same data as before, cleaner visual grouping. Right chevron aligns to
 * the first line. All signals preserved (Karan: "the information we have
 * is all needed, dont take anything out").
 */
function OpportunityRow({
  opportunity,
  account,
  statusEnteredAt,
  taskStats,
  lastNote,
  primaryLead,
  fileCount,
  submittalStats,
  finishCount,
}: {
  opportunity: CommercialOpportunity;
  account: CommercialAccount | null;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  lastNote: { created_at: string; author_label: string | null } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: import("@/lib/commercial/opportunities/assignments").OpportunityAssignmentRole } | null;
  fileCount: number;
  submittalStats: { total: number; awaiting_response: number } | null;
  finishCount: number;
}) {
  const bid = formatBidRange(opportunity.bid_value_low_cents, opportunity.bid_value_high_cents);
  const dueChip = decisionChip(opportunity.proposal_due_at);
  const daysInStatus = statusEnteredAt
    ? Math.floor((Date.now() - new Date(statusEnteredAt).getTime()) / MS_PER_DAY)
    : null;
  const defaultProb = DEFAULT_PROBABILITY_BY_STATUS[opportunity.status] ?? null;
  const probOverridden = defaultProb !== null && opportunity.probability_pct !== defaultProb;
  const nextStatuses = allowedNextStatuses(opportunity.status);
  return (
    <li className="relative group/row hover:bg-blue-50/30 transition-colors">
      <Link
        href={`/commercial/opportunities/${opportunity.id}`}
        className="block px-4 py-4 touch-manipulation"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Line 1 — title + status + due chip. Bigger typography so
                scanning finds titles fast. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-ppp-charcoal text-[15px] leading-tight">
                {opportunity.title}
              </span>
              <StatusPill status={opportunity.status} />
              {dueChip && <DueChip {...dueChip} />}
            </div>

            {/* Line 2 — account context + bid + confidence. Muted so
                the eye lands on the title first. */}
            <div className="text-[12px] text-ppp-charcoal-500 mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              {account && (
                <span className="text-ppp-charcoal-700 font-medium">{account.company_name}</span>
              )}
              {account?.rating && <RatingPill rating={account.rating} />}
              {account?.prequalification_status && account.prequalification_status !== "not_started" && (
                <PrequalPill status={account.prequalification_status} />
              )}
              {account && <span aria-hidden>·</span>}
              <span>
                <strong className="text-ppp-charcoal">{bid}</strong> bid
              </span>
              <span aria-hidden>·</span>
              <span title={probOverridden ? `Default ${defaultProb}% for ${opportunityStatusLabel(opportunity.status)} — overridden` : undefined}>
                {opportunity.probability_pct}% confident
                {probOverridden && <span className="ml-0.5 text-amber-700" aria-label="Probability overridden from status default">*</span>}
              </span>
            </div>

            {/* Line 3 — signal row: days-in-status, tasks, last-note,
                lead, files, finishes, submittals. Each only renders
                when data warrants it. Colored tint on urgent signals
                (overdue tasks, stuck deal). */}
            {(daysInStatus !== null || taskStats || lastNote || primaryLead || fileCount > 0 || finishCount > 0 || (submittalStats && submittalStats.total > 0)) && (
              <div className="text-[12px] mt-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-ppp-charcoal-600">
                {daysInStatus !== null && (
                  <span
                    className={
                      daysInStatus > 14
                        ? "text-rose-700 font-medium"
                        : daysInStatus > 7
                        ? "text-amber-700"
                        : "text-ppp-charcoal-600"
                    }
                    title={`Entered ${opportunityStatusLabel(opportunity.status)} ${daysInStatus}d ago`}
                  >
                    {daysInStatus}d in {opportunityStatusLabel(opportunity.status).toLowerCase()}
                  </span>
                )}
                {taskStats && taskStats.open > 0 && (
                  <span
                    className={
                      taskStats.overdue > 0
                        ? "text-rose-700 font-medium"
                        : taskStats.due_soon > 0
                        ? "text-amber-700"
                        : "text-ppp-charcoal-600"
                    }
                    title={`${taskStats.open} open · ${taskStats.overdue} overdue · ${taskStats.due_soon} due in 7d`}
                  >
                    {taskStats.overdue > 0
                      ? `${taskStats.overdue} overdue task${taskStats.overdue === 1 ? "" : "s"}`
                      : `${taskStats.open} open task${taskStats.open === 1 ? "" : "s"}`}
                  </span>
                )}
                {lastNote && (
                  <span className="text-ppp-charcoal-600" title={new Date(lastNote.created_at).toLocaleString()}>
                    Last note {relativeAgo(lastNote.created_at)}
                    {lastNote.author_label ? ` · ${lastNote.author_label}` : ""}
                  </span>
                )}
                {primaryLead && (
                  <span
                    className="inline-flex items-center gap-1 text-blue-700"
                    title={`${opportunityAssignmentRoleLabel(primaryLead.role)}: ${primaryLead.user_full_name ?? primaryLead.user_email}`}
                  >
                    <span aria-hidden>★</span>
                    {(primaryLead.user_full_name ?? primaryLead.user_email).split(" ")[0]}
                  </span>
                )}
                {fileCount > 0 && (
                  <span className="text-ppp-charcoal-600" title="Plans & Specs attachments">
                    <span aria-hidden>📎</span> {fileCount} {fileCount === 1 ? "file" : "files"}
                  </span>
                )}
                {finishCount > 0 && (
                  <span className="text-ppp-charcoal-600" title={`${finishCount} finish-schedule code${finishCount === 1 ? "" : "s"} defined`}>
                    <span aria-hidden>🎨</span> {finishCount} {finishCount === 1 ? "finish" : "finishes"}
                  </span>
                )}
                {submittalStats && submittalStats.total > 0 && (
                  <span
                    className={submittalStats.awaiting_response > 0 ? "text-sky-700 font-medium" : "text-ppp-charcoal-600"}
                    title={
                      submittalStats.awaiting_response > 0
                        ? `${submittalStats.awaiting_response} awaiting GC response`
                        : `${submittalStats.total} submittal${submittalStats.total === 1 ? "" : "s"} closed`
                    }
                  >
                    <span aria-hidden>📋</span> {submittalStats.total}
                    {submittalStats.awaiting_response > 0 && (
                      <span className="ml-1 inline-flex items-center px-1 py-0 rounded bg-sky-100 text-sky-800 text-[10px] font-bold uppercase tracking-wider">
                        {submittalStats.awaiting_response} awaiting
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right chevron aligns to first line — group-hover tint. */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 group-hover/row:text-cc-brand-600 shrink-0 mt-1 transition-colors" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </Link>

      {/* Tab-jump chips — sibling of the wrapping Link so clicking them
          navigates to the specific tab. Only renders when there's a
          count > 0. */}
      {(finishCount > 0 || (submittalStats && submittalStats.total > 0)) && (
        <div className="px-4 pb-2 -mt-1 flex flex-wrap items-center gap-2">
          {finishCount > 0 && (
            <Link
              href={`/commercial/opportunities/${opportunity.id}?tab=finishes`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-blue-800 bg-blue-50 border border-blue-100 hover:bg-blue-100 transition-colors min-h-[28px] touch-manipulation"
            >
              <span aria-hidden>🎨</span>
              <span>{finishCount} {finishCount === 1 ? "finish" : "finishes"} →</span>
            </Link>
          )}
          {submittalStats && submittalStats.total > 0 && (
            <Link
              href={`/commercial/opportunities/${opportunity.id}?tab=submittals`}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors min-h-[28px] touch-manipulation ${
                submittalStats.awaiting_response > 0
                  ? "text-sky-900 bg-sky-50 border-sky-100 hover:bg-sky-100"
                  : "text-ppp-charcoal-700 bg-ppp-charcoal-50 border-ppp-charcoal-100 hover:bg-ppp-charcoal-100/70"
              }`}
            >
              <span aria-hidden>📋</span>
              <span>
                {submittalStats.total} submittal{submittalStats.total === 1 ? "" : "s"}
                {submittalStats.awaiting_response > 0 && (
                  <span className="ml-1 font-semibold">· {submittalStats.awaiting_response} awaiting</span>
                )}
                {" →"}
              </span>
            </Link>
          )}
        </div>
      )}

      {/* Quick status-flip form — outside Link so form controls don't
          trigger nav. Same server action + form fields as before. */}
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
            className={`${SELECT_CLS} text-base sm:text-sm py-1.5 min-h-[44px] sm:min-h-[36px]`}
            style={SELECT_BG_STYLE}
          >
            <option value="" disabled>
              Next status…
            </option>
            {nextStatuses.map((s) => {
              const isTerminal = isTerminalOpportunityStatus(s);
              return (
                <option key={s} value={s}>
                  {isTerminal ? "→ Close as " : "→ "}{opportunityStatusLabel(s)}
                </option>
              );
            })}
          </select>
          <button
            type="submit"
            className="px-3 py-1 rounded-md bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 active:bg-ppp-charcoal-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
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
      : "bg-blue-50 text-blue-700 border-blue-200";
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
    inquiry: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    site_visit_scheduled: "bg-sky-100 text-sky-800 border-sky-300",
    site_visit_done: "bg-cyan-100 text-cyan-800 border-cyan-300",
    estimating: "bg-amber-100 text-amber-900 border-amber-300",
    proposal_sent: "bg-orange-100 text-orange-900 border-orange-300",
    negotiating: "bg-orange-100 text-orange-900 border-orange-300",
    on_hold: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    won: "bg-emerald-100 text-emerald-800 border-emerald-300",
    lost: "bg-rose-100 text-rose-800 border-rose-300",
    no_bid: "bg-rose-100 text-rose-800 border-rose-300",
    reopened: "bg-blue-100 text-blue-800 border-blue-300",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border ${map[status]}`}>
      {opportunityStatusLabel(status)}
    </span>
  );
}
