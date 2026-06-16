import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";

/**
 * GET /api/commercial/accounts/suggest?q=mi
 *
 * Lightweight type-ahead for the accounts search box. Returns up to 10
 * matches by ILIKE on company_name + dba so "mi" finds "Microsoft" AND
 * "Mike's Pizza Co." Soft-deleted accounts excluded.
 *
 * Auth gate: must be signed in. We don't expose any sensitive columns —
 * just id + display fields needed for the dropdown row.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 1 || q.length > 80) {
    return NextResponse.json({ results: [] });
  }

  // Escape Postgres ILIKE wildcards in the user's input so a literal
  // "%" or "_" doesn't make the search match everything.
  const safe = q.replace(/[%_\\]/g, (m) => "\\" + m);
  const pattern = `%${safe}%`;

  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_accounts")
    .select("id, company_name, dba, industry, rating")
    .is("deleted_at", null)
    .or(`company_name.ilike.${pattern},dba.ilike.${pattern}`)
    .order("company_name", { ascending: true })
    .limit(10);

  if (error) {
    console.warn("[commercial/accounts/suggest] query failed:", error.message);
    return NextResponse.json({ results: [] });
  }

  const results = (data ?? []).map((r) => ({
    id: r.id as string,
    company_name: r.company_name as string,
    industry: (r.industry as string | null) ?? null,
    rating: (r.rating as string | null) ?? null,
  }));

  return NextResponse.json(
    { results },
    {
      // Brief private cache — same user typing "mi" → "mic" → "micr"
      // benefits from the in-flight responses. No CDN edge-cache.
      headers: { "Cache-Control": "private, max-age=10" },
    }
  );
}
