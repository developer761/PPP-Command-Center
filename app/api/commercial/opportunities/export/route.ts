import { NextResponse } from "next/server";
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
import { MS_PER_DAY } from "@/lib/commercial/accounts/constants";

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

  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? undefined;
  const statusRaw = url.searchParams.get("status") ?? undefined;
  const sourcesRaw = url.searchParams.get("sources") ?? undefined;
  const stale = url.searchParams.get("stale") === "1";
  const hot = url.searchParams.get("hot") === "1";

  const validStatus =
    statusRaw && (OPPORTUNITY_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as OpportunityStatus)
      : undefined;
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
  });
  let opps = oppsRaw;

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
  if (sourceSet.size > 0) {
    opps = opps.filter((o) => !!o.source && sourceSet.has(o.source));
  }

  const filters: OpportunitiesExportFilters = {
    search: q || undefined,
    status: validStatus,
    sources: sourceList,
    stale,
    hot,
  };

  const csv = await exportOpportunitiesCsv(opps);
  const filename = exportOpportunitiesFilename(filters, opps.length);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
