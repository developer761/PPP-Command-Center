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

/**
 * Fetch EVERY row of a select, paging past PostgREST's 1000-row cap. Without
 * this, a large job count silently truncates the change-order / AIA-app /
 * line-item batches and understates (or drops) projects (2026-07-28 post-audit).
 */
async function paginateAll<T>(make: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }> }): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await make().range(from, from + PAGE - 1);
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
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
  let opps = await paginateAll<CommercialOpportunity & { account?: { id: string; company_name: string } }>(
    () =>
      sb
        .from("commercial_opportunities")
        .select("*, account:commercial_accounts!inner(id, company_name, deleted_at)")
        .is("deleted_at", null)
        .is("archived_at", null)
        .is("account.deleted_at", null)
        .or(`status.in.(${postSale.join(",")}),and(status.eq.pre_sale_closed,sub_status.eq.won)`)
        .order("updated_at", { ascending: false })
  );

  // Search across the displayed-name fields (matches the pipeline list). Runs
  // over the FULLY-paginated set, so a match past row 1000 is still found.
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
  const coData = await paginateAll<{ opportunity_id: string; status: string; amount_cents: number }>(
    () =>
      sb
        .from("commercial_change_orders")
        .select("opportunity_id, status, amount_cents")
        .in("opportunity_id", oppIds)
        .is("deleted_at", null)
  );
  const coByOpp = new Map<string, { netApproved: number; pending: number }>();
  for (const c of coData) {
    const e = coByOpp.get(c.opportunity_id) ?? { netApproved: 0, pending: 0 };
    if (c.status === "approved") e.netApproved += Number(c.amount_cents);
    else if (c.status === "pending") e.pending += 1;
    coByOpp.set(c.opportunity_id, e);
  }

  // ── Batch: latest AIA application per opp. We fetch ALL apps (paginated) and
  // pick the max application_number per opp in memory — a global DB sort + row
  // cap could otherwise starve a short project's only app and drop it. ──
  const appData = await paginateAll<{ id: string; opportunity_id: string; application_number: number; status: string; original_contract_cents: number }>(
    () =>
      sb
        .from("commercial_aia_applications")
        .select("id, opportunity_id, application_number, status, original_contract_cents")
        .in("opportunity_id", oppIds)
        .is("deleted_at", null)
  );
  const latestAppByOpp = new Map<string, { id: string; application_number: number; status: string; original_contract_cents: number }>();
  for (const a of appData) {
    const cur = latestAppByOpp.get(a.opportunity_id);
    if (!cur || a.application_number > cur.application_number) latestAppByOpp.set(a.opportunity_id, a);
  }

  // ── Batch: completed-to-date for those latest applications ──
  const latestAppIds = [...latestAppByOpp.values()].map((a) => a.id);
  const completedByApp = new Map<string, number>();
  if (latestAppIds.length > 0) {
    const liData = await paginateAll<{
      application_id: string;
      from_previous_cents: number;
      this_period_cents: number;
      materials_stored_cents: number;
    }>(
      () =>
        sb
          .from("commercial_aia_line_items")
          .select("application_id, from_previous_cents, this_period_cents, materials_stored_cents")
          .in("application_id", latestAppIds)
    );
    for (const l of liData) {
      const done =
        Math.max(0, Math.round(l.from_previous_cents)) +
        Math.max(0, Math.round(l.this_period_cents)) +
        Math.max(0, Math.round(l.materials_stored_cents));
      completedByApp.set(l.application_id, (completedByApp.get(l.application_id) ?? 0) + done);
    }
  }

  return opps.map((o) => {
    const co = coByOpp.get(o.id) ?? { netApproved: 0, pending: 0 };
    const latest = latestAppByOpp.get(o.id) ?? null;
    // Contract base: once AIA billing starts, use the app's SNAPSHOTTED signed
    // contract so this card reconciles with the AIA page it links to. Before
    // billing, fall back to the bid midpoint. Approved COs add on top of both.
    const base = latest && latest.original_contract_cents > 0 ? latest.original_contract_cents : bidMidCents(o);
    const contractToDate = base + co.netApproved;
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
