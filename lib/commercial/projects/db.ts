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
  /** Latest application's Total Completed & Stored to date (AIA line 4). */
  completedToDateCents: number;
  /** Retainage held on the latest application (summed per line). */
  retainageHeldCents: number;
  pendingCoCount: number;
  /** Signed $ of pending (undecided) change orders. */
  pendingCoCents: number;
  /** True once an AIA application exists (even an empty draft). */
  hasBilling: boolean;
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
  /** Scope to a single GC account (Account 360 production summary). */
  accountId?: string;
} = {}): Promise<ProjectRow[]> {
  const sb = commercialDb();

  // Post-sale = any POST_SALE_STATUS, OR the moment it's Won (pre_sale_closed +
  // won). Optionally drop completed jobs (post_sale_closed).
  const postSale = (POST_SALE_STATUSES as readonly string[]).filter(
    (s) => opts.includeClosed || s !== "post_sale_closed"
  );
  let opps = await paginateAll<CommercialOpportunity & { account?: { id: string; company_name: string } }>(
    () => {
      let q = sb
        .from("commercial_opportunities")
        .select("*, account:commercial_accounts!inner(id, company_name, deleted_at)")
        .is("deleted_at", null)
        .is("archived_at", null)
        .is("account.deleted_at", null)
        .or(`status.in.(${postSale.join(",")}),and(status.eq.pre_sale_closed,sub_status.eq.won)`);
      if (opts.accountId) q = q.eq("account_id", opts.accountId);
      return q.order("updated_at", { ascending: false });
    }
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
  const coByOpp = new Map<string, { netApproved: number; pending: number; pendingCents: number }>();
  for (const c of coData) {
    const e = coByOpp.get(c.opportunity_id) ?? { netApproved: 0, pending: 0, pendingCents: 0 };
    if (c.status === "approved") e.netApproved += Number(c.amount_cents);
    else if (c.status === "pending") {
      e.pending += 1;
      e.pendingCents += Number(c.amount_cents);
    }
    coByOpp.set(c.opportunity_id, e);
  }

  // ── Batch: latest AIA application per opp. We fetch ALL apps (paginated) and
  // pick the max application_number per opp in memory — a global DB sort + row
  // cap could otherwise starve a short project's only app and drop it. ──
  const appData = await paginateAll<{ id: string; opportunity_id: string; application_number: number; status: string; original_contract_cents: number; retainage_pct: number }>(
    () =>
      sb
        .from("commercial_aia_applications")
        .select("id, opportunity_id, application_number, status, original_contract_cents, retainage_pct")
        .in("opportunity_id", oppIds)
        .is("deleted_at", null)
  );
  const latestAppByOpp = new Map<string, { id: string; application_number: number; status: string; original_contract_cents: number; retainage_pct: number }>();
  for (const a of appData) {
    const cur = latestAppByOpp.get(a.opportunity_id);
    if (!cur || a.application_number > cur.application_number) latestAppByOpp.set(a.opportunity_id, a);
  }

  // ── Batch: completed-to-date + scheduled-value total for those latest apps ──
  const latestAppIds = [...latestAppByOpp.values()].map((a) => a.id);
  const completedByApp = new Map<string, number>();
  const sovByApp = new Map<string, number>();
  const retainageByApp = new Map<string, number>();
  // App id → retainage %, so completed retainage can be summed PER LINE (the
  // same way computeG702 / the G703 sheet does), keeping the portfolio total
  // penny-consistent with each project's AIA page.
  const pctByApp = new Map<string, number>();
  for (const a of latestAppByOpp.values()) {
    pctByApp.set(a.id, Math.min(100, Math.max(0, a.retainage_pct)));
  }
  if (latestAppIds.length > 0) {
    const liData = await paginateAll<{
      application_id: string;
      scheduled_value_cents: number;
      from_previous_cents: number;
      this_period_cents: number;
      materials_stored_cents: number;
    }>(
      () =>
        sb
          .from("commercial_aia_line_items")
          .select("application_id, scheduled_value_cents, from_previous_cents, this_period_cents, materials_stored_cents")
          .in("application_id", latestAppIds)
    );
    for (const l of liData) {
      const done =
        Math.max(0, Math.round(l.from_previous_cents)) +
        Math.max(0, Math.round(l.this_period_cents)) +
        Math.max(0, Math.round(l.materials_stored_cents));
      completedByApp.set(l.application_id, (completedByApp.get(l.application_id) ?? 0) + done);
      sovByApp.set(l.application_id, (sovByApp.get(l.application_id) ?? 0) + Math.max(0, Math.round(l.scheduled_value_cents)));
      const pct = pctByApp.get(l.application_id) ?? 0;
      retainageByApp.set(l.application_id, (retainageByApp.get(l.application_id) ?? 0) + Math.round((done * pct) / 100));
    }
  }

  return opps.map((o) => {
    const co = coByOpp.get(o.id) ?? { netApproved: 0, pending: 0, pendingCents: 0 };
    const latest = latestAppByOpp.get(o.id) ?? null;
    // Contract base — reconciles with the AIA page (resolveG702 uses the same
    // precedence): once billing starts, use the app's explicit snapshotted
    // contract, else its schedule-of-values total (which by AIA convention IS
    // the contract sum), else the deal's bid midpoint. Approved COs add on top.
    const sovTotal = latest ? sovByApp.get(latest.id) ?? 0 : 0;
    const base = latest
      ? latest.original_contract_cents > 0
        ? latest.original_contract_cents
        : sovTotal > 0
        ? sovTotal
        : bidMidCents(o)
      : bidMidCents(o);
    const contractToDate = base + co.netApproved;
    const completed = latest ? completedByApp.get(latest.id) ?? 0 : 0;
    const retainageHeld = latest ? retainageByApp.get(latest.id) ?? 0 : 0;
    const pct = latest && contractToDate > 0 ? Math.round((completed / contractToDate) * 10000) : null;
    return {
      opp: o as CommercialOpportunity,
      accountId: o.account?.id ?? o.account_id,
      accountName: o.account?.company_name ?? "",
      baseContractCents: base,
      netApprovedCoCents: co.netApproved,
      contractToDateCents: contractToDate,
      completedToDateCents: completed,
      retainageHeldCents: retainageHeld,
      pendingCoCount: co.pending,
      pendingCoCents: co.pendingCents,
      hasBilling: latest != null,
      latestAppNumber: latest?.application_number ?? null,
      latestAppStatus: (latest?.status as ProjectRow["latestAppStatus"]) ?? null,
      percentCompleteBps: pct,
    };
  });
}

/** Portfolio (or per-account) roll-up of production numbers. */
export type ProductionSummary = {
  activeProjects: number;
  inProductionProjects: number;
  billingProjects: number;
  contractValueCents: number;
  billedToDateCents: number;
  outstandingCents: number;
  retainageHeldCents: number;
  pendingCoCount: number;
  pendingCoCents: number;
};

/**
 * Summarize a set of project rows into headline production KPIs. "Billed to
 * date" = work completed & stored across the latest applications; "outstanding"
 * = contract sum still to bill (never negative). Pure — call over the rows from
 * listProjects (portfolio) or listProjects({ accountId }) (Account 360).
 */
export function summarizeProduction(rows: ProjectRow[]): ProductionSummary {
  let contractValueCents = 0;
  let billedToDateCents = 0;
  let retainageHeldCents = 0;
  let pendingCoCount = 0;
  let pendingCoCents = 0;
  let inProductionProjects = 0;
  let billingProjects = 0;
  for (const r of rows) {
    contractValueCents += r.contractToDateCents;
    billedToDateCents += r.completedToDateCents;
    retainageHeldCents += r.retainageHeldCents;
    pendingCoCount += r.pendingCoCount;
    pendingCoCents += r.pendingCoCents;
    if (r.opp.status === "in_progress" || r.opp.status === "billing") inProductionProjects += 1;
    if (r.opp.status === "billing") billingProjects += 1;
  }
  return {
    activeProjects: rows.length,
    inProductionProjects,
    billingProjects,
    contractValueCents,
    billedToDateCents,
    outstandingCents: Math.max(0, contractValueCents - billedToDateCents),
    retainageHeldCents,
    pendingCoCount,
    pendingCoCents,
  };
}
