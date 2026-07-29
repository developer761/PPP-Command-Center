/**
 * Projects data layer (2026-07-28) — the cross-account production view. A
 * "Project" is a post-sale opportunity (Won → pre-construction → in-progress →
 * billing → closed). This assembles, for every project in ONE batch (no N+1),
 * its contract sum to date (bid + approved COs), open change orders, and its
 * latest AIA application's status + % complete. Service-role only.
 */
import { commercialDb } from "@/lib/commercial/db";
import { POST_SALE_STATUSES } from "@/lib/commercial/opportunities/constants";
import type { CommercialOpportunity } from "@/lib/commercial/opportunities/db";

export type ProjectRow = {
  opp: CommercialOpportunity;
  accountId: string;
  accountName: string;
  baseContractCents: number;
  netApprovedCoCents: number;
  contractToDateCents: number;
  pendingCoCount: number;
  latestAppNumber: number | null;
  latestAppStatus: "draft" | "submitted" | "paid" | null;
  /** Latest application's Total Completed & Stored ÷ contract sum to date. */
  percentCompleteBps: number | null;
};

function bidMidCents(o: CommercialOpportunity): number {
  if (o.bid_value_low_cents != null && o.bid_value_high_cents != null) {
    return Math.round((o.bid_value_low_cents + o.bid_value_high_cents) / 2);
  }
  return o.bid_value_low_cents ?? o.bid_value_high_cents ?? 0;
}

export async function listProjects(opts: {
  search?: string;
  includeClosed?: boolean;
} = {}): Promise<ProjectRow[]> {
  const sb = commercialDb();

  // Post-sale = any POST_SALE_STATUS, OR the moment it's Won (pre_sale_closed +
  // won). Optionally drop completed jobs (post_sale_closed).
  const postSale = (POST_SALE_STATUSES as readonly string[]).filter(
    (s) => opts.includeClosed || s !== "post_sale_closed"
  );
  let q = sb
    .from("commercial_opportunities")
    .select("*, account:commercial_accounts!inner(id, company_name, deleted_at)")
    .is("deleted_at", null)
    .is("archived_at", null)
    .is("account.deleted_at", null)
    .or(`status.in.(${postSale.join(",")}),and(status.eq.pre_sale_closed,sub_status.eq.won)`)
    .order("updated_at", { ascending: false });

  const { data: oppsData } = await q;
  let opps = (oppsData ?? []) as (CommercialOpportunity & { account?: { id: string; company_name: string } })[];

  // Search across the displayed-name fields (matches the pipeline list).
  if (opts.search && opts.search.trim()) {
    const t = opts.search.trim().toLowerCase();
    opps = opps.filter((o) => {
      const acct = o.account?.company_name ?? "";
      return (
        (o.title ?? "").toLowerCase().includes(t) ||
        (o.title_override ?? "").toLowerCase().includes(t) ||
        (o.client_name ?? "").toLowerCase().includes(t) ||
        (o.property_street ?? "").toLowerCase().includes(t) ||
        acct.toLowerCase().includes(t)
      );
    });
  }

  if (opps.length === 0) return [];
  const oppIds = opps.map((o) => o.id);

  // ── Batch: change orders (net approved + pending count per opp) ──
  const { data: coData } = await sb
    .from("commercial_change_orders")
    .select("opportunity_id, status, amount_cents")
    .in("opportunity_id", oppIds)
    .is("deleted_at", null);
  const coByOpp = new Map<string, { netApproved: number; pending: number }>();
  for (const c of (coData ?? []) as { opportunity_id: string; status: string; amount_cents: number }[]) {
    const e = coByOpp.get(c.opportunity_id) ?? { netApproved: 0, pending: 0 };
    if (c.status === "approved") e.netApproved += Number(c.amount_cents);
    else if (c.status === "pending") e.pending += 1;
    coByOpp.set(c.opportunity_id, e);
  }

  // ── Batch: latest AIA application per opp ──
  const { data: appData } = await sb
    .from("commercial_aia_applications")
    .select("id, opportunity_id, application_number, status")
    .in("opportunity_id", oppIds)
    .is("deleted_at", null)
    .order("application_number", { ascending: false });
  const latestAppByOpp = new Map<string, { id: string; application_number: number; status: string }>();
  for (const a of (appData ?? []) as { id: string; opportunity_id: string; application_number: number; status: string }[]) {
    if (!latestAppByOpp.has(a.opportunity_id)) latestAppByOpp.set(a.opportunity_id, a);
  }

  // ── Batch: completed-to-date for those latest applications ──
  const latestAppIds = [...latestAppByOpp.values()].map((a) => a.id);
  const completedByApp = new Map<string, number>();
  if (latestAppIds.length > 0) {
    const { data: liData } = await sb
      .from("commercial_aia_line_items")
      .select("application_id, from_previous_cents, this_period_cents, materials_stored_cents")
      .in("application_id", latestAppIds);
    for (const l of (liData ?? []) as {
      application_id: string;
      from_previous_cents: number;
      this_period_cents: number;
      materials_stored_cents: number;
    }[]) {
      const done =
        Math.max(0, Math.round(l.from_previous_cents)) +
        Math.max(0, Math.round(l.this_period_cents)) +
        Math.max(0, Math.round(l.materials_stored_cents));
      completedByApp.set(l.application_id, (completedByApp.get(l.application_id) ?? 0) + done);
    }
  }

  return opps.map((o) => {
    const co = coByOpp.get(o.id) ?? { netApproved: 0, pending: 0 };
    const base = bidMidCents(o);
    const contractToDate = base + co.netApproved;
    const latest = latestAppByOpp.get(o.id) ?? null;
    const completed = latest ? completedByApp.get(latest.id) ?? 0 : 0;
    const pct = latest && contractToDate > 0 ? Math.round((completed / contractToDate) * 10000) : null;
    return {
      opp: o as CommercialOpportunity,
      accountId: o.account?.id ?? o.account_id,
      accountName: o.account?.company_name ?? "",
      baseContractCents: base,
      netApprovedCoCents: co.netApproved,
      contractToDateCents: contractToDate,
      pendingCoCount: co.pending,
      latestAppNumber: latest?.application_number ?? null,
      latestAppStatus: (latest?.status as ProjectRow["latestAppStatus"]) ?? null,
      percentCompleteBps: pct,
    };
  });
}
