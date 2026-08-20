import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { type AccountsListFilters } from "@/lib/commercial/accounts/db";
import { exportAccountsCsv, exportAccountsFilename } from "@/lib/commercial/accounts/export";
import { csvResponse } from "@/lib/commercial/reports/export-guard";

/**
 * GET /api/commercial/accounts/export?q=&rating=&compliance=&industry=
 *
 * Streams a UTF-8 CSV of the (filtered) accounts list. Filters mirror
 * the list-page query params 1:1 so a user clicking Export gets exactly
 * the same rows they were looking at.
 *
 * Gated on signed-in + has_new_platform_access — a Command Center-only
 * user must not be able to scrape the commercial book of business.
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
  const rating = url.searchParams.get("rating") ?? undefined;
  const compliance = url.searchParams.get("compliance") ?? undefined;
  const industry = url.searchParams.get("industry") ?? undefined;

  // Whitelist the literal values from the URL — anything else, drop.
  const filters: AccountsListFilters = {
    search: q || undefined,
    rating: rating === "A" || rating === "B" || rating === "C" ? rating : undefined,
    compliance:
      compliance === "green" || compliance === "yellow" || compliance === "red" || compliance === "not_started"
        ? compliance
        : undefined,
    industry: industry || undefined,
  };
  // The four POST-FETCH chip filters the list page also applies — these were
  // dropped by the export, so a filtered view exported the wider book (audit
  // D10). exportAccountsCsv applies them off the overview/tag data it already
  // loads, and returns the true row count for the filename.
  const quick = {
    stale: url.searchParams.get("stale") === "1",
    expiring: url.searchParams.get("expiring") === "1",
    issue: url.searchParams.get("issue") === "1",
    tag: url.searchParams.get("tag") || undefined,
  };

  const { csv, count } = await exportAccountsCsv(filters, quick);
  const filename = exportAccountsFilename(filters, count);

  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(csv, filename);
}
