import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getInvoiceRollupForAccount } from "@/lib/commercial/invoices/rollup";

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
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if ((await apiAccessDenied(auth?.user?.id, profile))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const { data: account } = await sb
    .from("commercial_accounts")
    // `city`/`state` are not columns on this table — the address fields are
    // billing_*/site_*. PostgREST rejects the WHOLE select on an unknown
    // column, so `account` came back null and this route answered 404 for
    // EVERY account, which meant the hover card never worked once. Billing is
    // the account's own address; site addresses vary per job.
    .select("id, company_name, billing_city, billing_state, industry, account_seq")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Two lightweight aggregate queries — small enough that a single
  // round trip beats keeping this data in a materialized view for now.
  const [openBidsRes, rollup, latestRes] = await Promise.all([
    sb
      .from("commercial_opportunities")
      .select("id", { count: "exact", head: true })
      .eq("account_id", id)
      .is("deleted_at", null)
      // Skip archived (buried) deals so this reconciles with the pipeline list
      // (2026-07-28 re-audit).
      .is("archived_at", null)
      // 2026-07-28 re-audit: the old whitelist was STALE v1 statuses
      // (solicitation/rfp/proposal_pending_approval/proposal_sent/follow_up) —
      // only "estimating" survived the v2 migration, so this count was badly
      // undercounting. "Open bids" = the pre-sale open lanes (v2).
      .in("status", ["qualifying", "estimating", "proposal"]),
    /**
     * THE ACCOUNT 360 FIGURE, NOT A COPY OF IT.
     *
     * This summed invoices and AIA by hand, and each fix to that arithmetic
     * was a fix to a second definition: drafts were counted until 2026-07-28,
     * AIA was missing until the next pass, and the `SF-####` carry-over was
     * never dropped — on a job billed by certificate it is the same money as
     * those certificates (lib/commercial/invoices/carryover.ts), so the card
     * would have counted LMJ Cipla twice while the tile beside it did not.
     *
     * `invoiced_cents` is issued invoices at their with-tax total (what the GC
     * was sent) plus AIA billed, which carries no separate tax line. Reading
     * the rollup means the hover card and Account 360 are one number.
     */
    getInvoiceRollupForAccount(id),
    sb
      .from("commercial_opportunities")
      .select("updated_at")
      .eq("account_id", id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // AIA is in it (LMJ Management read $456,723.49 on invoices alone, for a GC
  // that has billed well over a million by certificate) — see the rollup.
  const invoiced_cents = rollup.invoiced_cents;
  const last_activity_at =
    (latestRes.data as { updated_at?: string } | null)?.updated_at ?? null;

  return NextResponse.json({
    id: account.id,
    company_name: (account as { company_name: string }).company_name,
    city: (account as { billing_city: string | null }).billing_city,
    state: (account as { billing_state: string | null }).billing_state,
    industry: (account as { industry: string | null }).industry,
    account_seq: (account as { account_seq: number | null }).account_seq ?? null,
    open_bids_count: openBidsRes.count ?? 0,
    invoiced_cents,
    last_activity_at,
  });
}
