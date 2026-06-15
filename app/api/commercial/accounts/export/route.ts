import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { listCommercialAccounts, type AccountsListFilters } from "@/lib/commercial/accounts/db";
import { exportAccountsCsv, exportAccountsFilename } from "@/lib/commercial/accounts/export";

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

  // Pre-count for the filename. listCommercialAccounts is the same call
  // exportAccountsCsv runs internally — we accept the second roundtrip
  // because it lets the filename carry the row count.
  const accounts = await listCommercialAccounts(filters);
  const csv = await exportAccountsCsv(filters);
  const filename = exportAccountsFilename(filters, accounts.length);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // No cache — the list changes frequently and a stale CSV is
      // worse than a fresh round-trip.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
