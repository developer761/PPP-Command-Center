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
import { applyPipelineChipFilters } from "@/lib/commercial/opportunities/pipeline-filters";
import { etTodayIso } from "@/lib/date-et";
import {
  KANBAN_COLUMNS,
  PRE_CONTRACT_COLUMNS,
  columnKeyForOpp,
  columnDbStatusHint,
  kanbanColumnLabel,
} from "@/lib/commercial/opportunities/kanban-columns";
import { isUnderContract } from "@/lib/commercial/opportunities/attention";
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

  // The board's own chip filters, not a copy of them. This file used to carry
  // its own: DATE columns parsed as UTC midnight and compared to `Date.now()`,
  // so a proposal due TODAY was "overdue" in the CSV and not on the board, the
  // hot window ran a day short, cold RFPs tipped a day early, and the overdue /
  // cold / follow-up sets used a wider status list than the board does.
  opps = applyPipelineChipFilters(
    opps,
    { stale, hot, newDays, overdue, coldRfp, followup },
    etTodayIso(),
  );
  if (sourceSet.size > 0) {
    opps = opps.filter((o) => !!o.source && sourceSet.has(o.source));
  }
  // mine / estimator / lane — mirror the page's post-fetch filters 1:1 so
  // the CSV matches the visible set (audit D4).
  if (mine) opps = opps.filter((o) => o.estimator_user_id === auth.user.id);
  if (estimatorId) opps = opps.filter((o) => o.estimator_user_id === estimatorId);
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
