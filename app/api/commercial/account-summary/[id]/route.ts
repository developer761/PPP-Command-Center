import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * GET /api/commercial/account-summary/[id]
 *
 * Compact account summary for the hover-card preview. Karan 2026-07-11
 * signature-moments Tier 2. Returns just enough to render a floating
 * preview: company name + city + state + industry + open bids count +
 * invoiced $ + last activity timestamp.
 *
 * Auth: same has_new_platform_access gate as other endpoints. Cached
 * client-side by AccountHoverCard so repeat hovers are free.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!(profile as { has_new_platform_access?: boolean } | null)?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const { data: account } = await sb
    .from("commercial_accounts")
    .select("id, company_name, city, state, industry")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Two lightweight aggregate queries — small enough that a single
  // round trip beats keeping this data in a materialized view for now.
  const [openBidsRes, invoiceRes, latestRes] = await Promise.all([
    sb
      .from("commercial_opportunities")
      .select("id", { count: "exact", head: true })
      .eq("account_id", id)
      .is("deleted_at", null)
      .not("status", "in", "(won,lost,no_bid)"),
    sb
      .from("commercial_invoices")
      .select("total_cents")
      .eq("account_id", id)
      .is("deleted_at", null)
      .neq("status", "void"),
    sb
      .from("commercial_opportunities")
      .select("updated_at")
      .eq("account_id", id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const invoiced_cents = ((invoiceRes.data ?? []) as { total_cents: number }[]).reduce(
    (acc, r) => acc + (r.total_cents ?? 0),
    0
  );
  const last_activity_at =
    (latestRes.data as { updated_at?: string } | null)?.updated_at ?? null;

  return NextResponse.json({
    id: account.id,
    company_name: (account as { company_name: string }).company_name,
    city: (account as { city: string | null }).city,
    state: (account as { state: string | null }).state,
    industry: (account as { industry: string | null }).industry,
    open_bids_count: openBidsRes.count ?? 0,
    invoiced_cents,
    last_activity_at,
  });
}
