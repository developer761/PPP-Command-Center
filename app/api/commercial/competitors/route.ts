import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchCompetitors } from "@/lib/commercial/competitors";
import { commercialDb } from "@/lib/commercial/db";

/**
 * GET /api/commercial/competitors?q=...
 *
 * Typeahead lookup for the Win/Loss Debrief modal. Returns up to 20
 * active competitors matching the query, ranked exact → prefix → substring.
 * Empty `q` returns the 20 most-recently-seen.
 *
 * Auth: any signed-in user with new-platform access (same as the debrief
 * modal — if you can submit a debrief, you can search the typeahead).
 * No rate limit because typeahead is intentionally per-keystroke; downstream
 * SQL is indexed + capped at 20 so even a noisy client can't hurt.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Audit fix 2026-06-24: gate on has_new_platform_access — competitor
  // names are commercial-only intel; a residential-only user signed
  // into the SaaS should not be able to enumerate them.
  const { data: prof } = await commercialDb()
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!prof || !(prof as { has_new_platform_access: boolean }).has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const rows = await searchCompetitors(q);
  return NextResponse.json(
    { competitors: rows.map((r) => ({ id: r.id, name: r.name })) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
