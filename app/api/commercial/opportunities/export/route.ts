import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import {
  listCommercialOpportunities,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_SOURCES,
  type OpportunityStatus,
  type OpportunitySource,
} from "@/lib/commercial/opportunities/db";
import {
  exportOpportunitiesCsv,
  exportOpportunitiesFilename,
  type OpportunitiesExportFilters,
} from "@/lib/commercial/opportunities/export";
import {
  OPEN_OPP_STATUSES,
  STALE_OPP_DAYS,
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
  HOT_DEAL_ACTIVE_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import {
  KANBAN_COLUMNS,
  PRE_CONTRACT_COLUMNS,
  columnKeyForOpp,
  columnDbStatusHint,
  kanbanColumnLabel,
} from "@/lib/commercial/opportunities/kanban-columns";
import { isUnderContract } from "@/lib/commercial/opportunities/attention";
import { MS_PER_DAY } from "@/lib/commercial/accounts/constants";
import { csvResponse } from "@/lib/commercial/reports/export-guard";

/**
 * GET /api/commercial/opportunities/export?q=&status=&sources=&stale=&hot=
 *
 * Streams a UTF-8 CSV of the (filtered) opportunity pipeline. The chip
 * filters that live post-fetch on the page (sources, stale, hot) are
 * applied here too so the export matches what the user sees.
 *
 * Gated on signed-in + has_new_platform_access — a Command Center-only
 * user must not be able to scrape the commercial bid book.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Crew logins are page-allowlisted only; this API tree isn't covered by
  // that gate, so deny here (see denyCrewApi).
  { const denied = await denyCrewApi(auth?.user?.id); if (denied) return denied; }

  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access || profile?.is_active === false) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? undefined;
  const statusRaw = url.searchParams.get("status") ?? undefined;
  const sourcesRaw = url.searchParams.get("sources") ?? undefined;
  const stale = url.searchParams.get("stale") === "1";
  const hot = url.searchParams.get("hot") === "1";
  // 2026-07-21 audit #5: honor the archived toggle so the CSV matches
  // the visible/filtered set. Without this a user viewing archived deals
  // exported the ACTIVE set instead — a silent wrong-data export.
  const includeArchived = url.searchParams.get("archived") === "1";
  // 2026-07-21: dashboard "Needs attention" deep-link filters — mirror the
  // pipeline page 1:1 so an export from a filtered view matches what's on
  // screen.
  const overdue = url.searchParams.get("overdue") === "1";
  const coldRfp = url.searchParams.get("coldrfp") === "1";
  const followup = url.searchParams.get("followup") === "1";
  // mine / estimator / new / lane — the page applies these post-fetch; the
  // export ignored them, so a filtered view exported the wider set (audit D4).
  const mine = url.searchParams.get("mine") === "1";
  const estimatorId = url.searchParams.get("estimator") || undefined;
  const newDays = url.searchParams.get("new") === "7d" ? 7 : undefined;
  const laneRaw = url.searchParams.get("lane");
  const lane = laneRaw === "under_contract" || laneRaw === "pre_contract" ? laneRaw : undefined;

  // `status` carries a KANBAN COLUMN key, matching what the pipeline page
  // puts in the URL. Validating it against OPPORTUNITY_STATUSES alone
  // silently DROPPED the filter for rfp/won/lost (they're column keys, not
  // top-level statuses) — so exporting a filtered board handed you the
  // entire pipeline. Resolve exactly as the page does: pre-narrow in the
  // query where the column maps to one status, then refine in memory.
  const validColumn = statusRaw
    ? (KANBAN_COLUMNS.some((c) => c.key === statusRaw)
        ? statusRaw
        : (OPPORTUNITY_STATUSES as readonly string[]).includes(statusRaw)
          ? columnKeyForOpp(statusRaw, null)
          : undefined)
    : undefined;
  const validStatus = ((validColumn ? columnDbStatusHint(validColumn) : null) ??
    undefined) as OpportunityStatus | undefined;
  const sourceList: OpportunitySource[] = [];
  if (sourcesRaw) {
    for (const s of sourcesRaw.split(",")) {
      const t = s.trim();
      if ((OPPORTUNITY_SOURCES as readonly string[]).includes(t)) {
        sourceList.push(t as OpportunitySource);
      }
    }
  }
  const sourceSet = new Set(sourceList);

  // Pull the base set, then apply post-fetch chip filters EXACTLY like
  // the page does. Mirroring 1:1 prevents "I see 10 but the CSV has 12"
  // confusion.
  const oppsRaw = await listCommercialOpportunities({
    search: q || undefined,
    status: validStatus,
    includeArchived,
  });
  // Column refine — the step the query hint can't do (Qualifying vs RFP share
  // a status; Proposal spans two). Without it the CSV is a superset/subset of
  // what the board shows.
  let opps = validColumn
    ? oppsRaw.filter((o) => columnKeyForOpp(o.status, o.sub_status) === validColumn)
    : oppsRaw;

  if (stale) {
    opps = opps.filter((o) => {
      if (!(OPEN_OPP_STATUSES as readonly string[]).includes(o.status)) return false;
      const days = Math.floor((Date.now() - new Date(o.updated_at).getTime()) / MS_PER_DAY);
      return Number.isFinite(days) && days >= STALE_OPP_DAYS;
    });
  }
  if (hot) {
    opps = opps.filter((o) => {
      if (!(HOT_DEAL_ACTIVE_STATUSES as readonly string[]).includes(o.status)) return false;
      if (!o.bid_value_high_cents || o.bid_value_high_cents < HOT_DEAL_BID_CENTS) return false;
      if (!o.proposal_due_at) return false;
      const days = Math.ceil((new Date(o.proposal_due_at).getTime() - Date.now()) / MS_PER_DAY);
      return Number.isFinite(days) && days >= 0 && days <= HOT_DEAL_DECISION_DAYS;
    });
  }
  if (overdue) {
    const nowMs = Date.now();
    opps = opps.filter(
      (o) =>
        (OPEN_OPP_STATUSES as readonly string[]).includes(o.status) &&
        o.proposal_due_at != null &&
        new Date(o.proposal_due_at).getTime() < nowMs
    );
  }
  if (coldRfp) {
    const nowMs = Date.now();
    opps = opps.filter((o) => {
      if (!(OPEN_OPP_STATUSES as readonly string[]).includes(o.status)) return false;
      if (!o.rfp_received_at) return false;
      const days = Math.floor((nowMs - new Date(o.rfp_received_at).getTime()) / MS_PER_DAY);
      return Number.isFinite(days) && days > 7;
    });
  }
  if (followup) {
    const todayEtIso = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    ).toISOString();
    opps = opps.filter(
      (o) =>
        (OPEN_OPP_STATUSES as readonly string[]).includes(o.status) &&
        o.follow_up_at != null &&
        o.follow_up_at <= todayEtIso
    );
  }
  if (sourceSet.size > 0) {
    opps = opps.filter((o) => !!o.source && sourceSet.has(o.source));
  }
  // mine / estimator / new / lane — mirror the page's post-fetch filters 1:1 so
  // the CSV matches the visible set (audit D4).
  if (mine) opps = opps.filter((o) => o.estimator_user_id === auth.user.id);
  if (estimatorId) opps = opps.filter((o) => o.estimator_user_id === estimatorId);
  if (newDays) {
    const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const cutoff = new Date(Date.UTC(+todayEt.slice(0, 4), +todayEt.slice(5, 7) - 1, +todayEt.slice(8, 10)) - newDays * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    opps = opps.filter((o) => (o.created_at ?? "").slice(0, 10) >= cutoff);
  }
  if (lane === "under_contract") {
    opps = opps.filter((o) => isUnderContract(o.status, o.sub_status));
  } else if (lane === "pre_contract") {
    const laneKeys = new Set(PRE_CONTRACT_COLUMNS.map((c) => c.key));
    opps = opps.filter((o) => laneKeys.has(columnKeyForOpp(o.status, o.sub_status)));
  }

  const filters: OpportunitiesExportFilters = {
    search: q || undefined,
    status: validStatus,
    // Name the filename after the COLUMN, not the query hint — otherwise a
    // Proposal or Qualifying export (both fetch wide, hint = null) produced a
    // filename with no stage in it at all.
    stage: validColumn,
    sources: sourceList,
    stale,
    hot,
  };

  const csv = await exportOpportunitiesCsv(opps);
  const filename = exportOpportunitiesFilename(filters, opps.length);

  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(csv, filename, "Opportunities");
}
