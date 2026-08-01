/**
 * Projects data layer (2026-07-28) — the cross-account production view. A
 * "Project" is a post-sale opportunity (Won → pre-construction → in-progress →
 * billing → closed). This assembles, for every project in ONE batch (no N+1),
 * its contract sum to date (bid + approved COs), open change orders, and its
 * latest AIA application's status + % complete. Service-role only.
 */
import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { POST_SALE_STATUSES } from "@/lib/commercial/opportunities/constants";
import { pickContractBaseCents } from "@/lib/commercial/aia/constants";
import { listSubmittalCountByOpp } from "@/lib/commercial/opportunities/submittals";
import { costBreakdownByOpp, emptyCostBreakdown, type CostBreakdown } from "@/lib/commercial/purchases/db";
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
  // ── Billing (financial truth, 2026-07-29) ──
  /** Σ of this project's non-void invoice totals (WITH tax) — AR / "Invoiced". */
  invoicedCents: number;
  /** Σ of non-void invoice SUBTOTALS (PRE-tax) — the figure compared to the
   *  (pre-tax) contract for left-to-bill / over-billed / %-of-contract. */
  billedContractCents: number;
  /** Σ of payments recorded against those invoices. */
  paidCents: number;
  invoiceCount: number;
  draftInvoiceCount: number;
  /** Σ of DRAFT invoice totals (not yet billed to the GC) — shown separately,
   *  never counted toward invoiced / % billed / left-to-bill. */
  draftedCents: number;
  /** Contract to date − invoiced, clamped ≥ 0. "How much you can still bill." */
  leftToBillCents: number;
  /** Invoiced − paid. The GC's outstanding balance (AR). */
  outstandingCents: number;
  /** Invoiced beyond the contract sum — flagged, never shown as negative. */
  overBilled: boolean;
  // ── Closeout (2026-07-30) — so the account/deal shows a "closed out" state ──
  /** Most-advanced non-void close-out package status for this project, or null
   *  when no package exists yet. */
  closeoutStatus: "draft" | "sent" | "acknowledged" | "complete" | null;
  /** True once a close-out package reaches `complete` — the deal is closed out. */
  isClosedOut: boolean;
  // ── Submittals (2026-07-30) — so the project card shows all four tool states ──
  submittalTotal: number;
  submittalAwaiting: number;
  // ── Costs / Job P&L (Phase 2) ──
  /** Σ live project purchases (materials/labor/subs/equipment/permits). */
  costsCents: number;
  /** Per-category cost breakdown for the P&L. */
  costs: CostBreakdown;
  /** Contract to date − total costs = projected gross profit (negative = over budget). */
  grossMarginCents: number;
  /** grossMargin ÷ contract, whole %, null when contract is 0. */
  grossMarginPct: number | null;
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
  /** Scope to a single GC account (Account 360 production summary). */
  accountId?: string;
  /** Include EVERY deal (pre-sale bids too), not just post-sale/won projects.
   *  Used by the deal drill-in so a bid opens the same full project view
   *  (tools + invoicing unlocked) as a Won job — nothing gated on Won. The
   *  production-summary + projects-list callers leave this off so those stay
   *  scoped to real jobs under contract. */
  allDeals?: boolean;
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
        .is("account.deleted_at", null);
      // Gate to post-sale/won unless the caller wants every deal.
      if (!opts.allDeals) {
        q = q.or(`status.in.(${postSale.join(",")}),and(status.eq.pre_sale_closed,sub_status.eq.won)`);
      }
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
        .order("id", { ascending: true })
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

  // ── Batch: invoicing per opp (2026-07-29 financial truth). Invoiced = Σ
  // non-void invoice totals; Paid = Σ payments. These drive "left to bill"
  // (contract − invoiced) + "outstanding" (invoiced − paid) so billing
  // actually moves the numbers — the old rollup ignored invoices entirely. ──
  const invData = await paginateAll<{ opportunity_id: string; status: string; subtotal_cents: number; total_cents: number; paid_cents: number }>(
    () =>
      sb
        .from("commercial_invoices")
        .select("opportunity_id, status, subtotal_cents, total_cents, paid_cents")
        .in("opportunity_id", oppIds)
        .is("deleted_at", null)
        .order("id", { ascending: true })
  );
  // "Invoiced" = ISSUED invoices only (sent/viewed/partial/overdue/paid) — a
  // draft isn't billed to the GC yet, so it must NOT inflate billed / %-billed
  // / left-to-bill (2026-07-29 audit: a $50k draft was flipping a job to "100%
  // billed"). Drafts are tracked separately + shown as a "$X in N drafts" note.
  // `invoiced`/`paid` are WITH tax (AR — what the GC owes/paid). `billedPreTax`
  // is Σ subtotal (pre-tax): the contract is a pre-tax number (proposal total +
  // pre-tax CO amounts), so left-to-bill / over-billed / %-of-contract MUST
  // compare pre-tax against pre-tax — else an 8.875%-taxed full bill looks
  // "over-billed" (2026-08 money audit #1).
  const invByOpp = new Map<string, { invoiced: number; billedPreTax: number; paid: number; invoiceCount: number; draftCount: number; draftedCents: number }>();
  for (const inv of invData) {
    if (inv.status === "void") continue;
    const e = invByOpp.get(inv.opportunity_id) ?? { invoiced: 0, billedPreTax: 0, paid: 0, invoiceCount: 0, draftCount: 0, draftedCents: 0 };
    if (inv.status === "draft") {
      e.draftCount += 1;
      e.draftedCents += Number(inv.total_cents);
    } else {
      e.invoiced += Number(inv.total_cents);
      e.billedPreTax += Number(inv.subtotal_cents);
      e.paid += Number(inv.paid_cents);
      e.invoiceCount += 1;
    }
    invByOpp.set(inv.opportunity_id, e);
  }

  // ── Batch: project costs per opp (Phase 2). One grouped query; only live
  // purchases (costBreakdownByOpp filters deleted_at IS NULL — audit C2). ──
  const costsByOpp = await costBreakdownByOpp(oppIds);

  // ── Batch: proposals per opp — the WON one is the signed contract; if none
  // is won, the LATEST (highest revision) proposal drives the contract so a deal
  // never shows its first/oldest quote (Karan 2026-08 smoke-test fix). ──
  const propData = await paginateAll<{ opportunity_id: string; total_cents: number; status: string; revision_number: number }>(
    () =>
      sb
        .from("commercial_proposals")
        .select("opportunity_id, total_cents, status, revision_number")
        .in("opportunity_id", oppIds)
        .is("deleted_at", null)
        .order("id", { ascending: true })
  );
  const acceptedProposalByOpp = new Map<string, number>();
  const latestProposalByOpp = new Map<string, { rev: number; cents: number }>();
  for (const p of propData) {
    if (p.status === "won") {
      // If somehow >1 won proposal, keep the largest (defensive; should be one).
      acceptedProposalByOpp.set(p.opportunity_id, Math.max(acceptedProposalByOpp.get(p.opportunity_id) ?? 0, Number(p.total_cents)));
    }
    const cur = latestProposalByOpp.get(p.opportunity_id);
    if (!cur || p.revision_number > cur.rev) {
      latestProposalByOpp.set(p.opportunity_id, { rev: p.revision_number, cents: Number(p.total_cents) });
    }
  }

  // ── Batch: close-out package status per opp. Keep the most-advanced non-void
  // status so the account/deal can badge "Closed out" (2026-07-30). ──
  const CLOSEOUT_RANK: Record<string, number> = { draft: 1, sent: 2, acknowledged: 3, complete: 4 };
  const closeoutData = await paginateAll<{ opportunity_id: string; status: string }>(
    () =>
      sb
        .from("commercial_closeout_packages")
        .select("opportunity_id, status")
        .in("opportunity_id", oppIds)
        .is("voided_at", null)
        .order("id", { ascending: true })
  );
  const closeoutByOpp = new Map<string, ProjectRow["closeoutStatus"]>();
  for (const c of closeoutData) {
    if (c.status === "voided") continue;
    const cur = closeoutByOpp.get(c.opportunity_id);
    if (!cur || (CLOSEOUT_RANK[c.status] ?? 0) > (CLOSEOUT_RANK[cur] ?? 0)) {
      closeoutByOpp.set(c.opportunity_id, c.status as ProjectRow["closeoutStatus"]);
    }
  }

  // ── Batch: submittal counts per opp (total + awaiting GC response). ──
  const submittalCounts = await listSubmittalCountByOpp(oppIds);

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
        .order("id", { ascending: true })
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
          .order("id", { ascending: true })
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
    // Contract base — the ONE shared ladder (pickContractBaseCents), also used
    // by the AIA G702 + Change Orders page, so every surface ties out.
    const sovTotal = latest ? sovByApp.get(latest.id) ?? 0 : 0;
    const base = pickContractBaseCents({
      hasBillingApp: latest != null,
      originalContractCents: latest?.original_contract_cents ?? 0,
      sovTotalCents: sovTotal,
      acceptedProposalCents: acceptedProposalByOpp.get(o.id) ?? 0,
      latestProposalCents: latestProposalByOpp.get(o.id)?.cents ?? 0,
      bidMidCents: bidMidCents(o),
    });
    const contractToDate = base + co.netApproved;
    const completed = latest ? completedByApp.get(latest.id) ?? 0 : 0;
    const retainageHeld = latest ? retainageByApp.get(latest.id) ?? 0 : 0;
    const pct = latest && contractToDate > 0 ? Math.round((completed / contractToDate) * 10000) : null;
    const inv = invByOpp.get(o.id) ?? { invoiced: 0, billedPreTax: 0, paid: 0, invoiceCount: 0, draftCount: 0, draftedCents: 0 };
    // Left to bill = contract − PRE-TAX billed (clamped). Over-billed when the
    // pre-tax billed exceeds the (pre-tax) contract — unapproved CO, deduct CO,
    // or a mistake — surfaced, never a negative, and never a phantom over-bill
    // from sales tax. hasContract gates whether "left to bill" is meaningful.
    const hasContract = contractToDate > 0;
    const leftToBill = hasContract ? Math.max(0, contractToDate - inv.billedPreTax) : 0;
    const overBilled = hasContract && inv.billedPreTax > contractToDate;
    // Job P&L (Phase 2): margin vs the SAME contractToDate used everywhere else
    // (base + net-approved COs), so the card ties out with the deal P&L (audit C1).
    const costs = costsByOpp.get(o.id) ?? emptyCostBreakdown();
    const grossMarginCents = contractToDate - costs.total;
    const grossMarginPct = hasContract ? Math.round((grossMarginCents / contractToDate) * 100) : null;
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
      invoicedCents: inv.invoiced,
      billedContractCents: inv.billedPreTax,
      paidCents: inv.paid,
      invoiceCount: inv.invoiceCount,
      draftInvoiceCount: inv.draftCount,
      draftedCents: inv.draftedCents,
      leftToBillCents: leftToBill,
      // Clamp: an overpaid project (paid > invoiced) is a credit, not negative
      // AR — don't let it drag the account's Outstanding below zero (audit 4C).
      outstandingCents: Math.max(0, inv.invoiced - inv.paid),
      overBilled,
      closeoutStatus: closeoutByOpp.get(o.id) ?? null,
      isClosedOut: (closeoutByOpp.get(o.id) ?? null) === "complete",
      submittalTotal: submittalCounts.get(o.id)?.total ?? 0,
      submittalAwaiting: submittalCounts.get(o.id)?.awaiting_response ?? 0,
      costsCents: costs.total,
      costs,
      grossMarginCents,
      grossMarginPct,
    };
  });
}

/** Portfolio (or per-account) roll-up of production + billing numbers. */
export type ProductionSummary = {
  activeProjects: number;
  inProductionProjects: number;
  billingProjects: number;
  contractValueCents: number;
  /** Work completed & stored to date (AIA line 4) — PRODUCTION, not "billed". */
  completedToDateCents: number;
  /** DEPRECATED name kept for callers: now = leftToBillCents (contract −
   *  invoiced), not contract − completed. See leftToBillCents. */
  remainingCents: number;
  retainageHeldCents: number;
  pendingCoCount: number;
  pendingCoCents: number;
  // ── Billing (financial truth) ──
  /** Σ invoice totals WITH tax — AR / "Invoiced". */
  invoicedCents: number;
  /** Σ invoice subtotals PRE-tax — the figure compared to the contract. */
  billedContractCents: number;
  paidCents: number;
  /** Contract to date − pre-tax billed (clamped ≥ 0). "How much you can still bill." */
  leftToBillCents: number;
  /** Invoiced − paid. Outstanding AR across these projects. */
  outstandingCents: number;
  // ── Job P&L (Phase 2) ──
  /** Σ project costs across these projects. */
  costsCents: number;
  /** Σ contract − Σ costs = portfolio projected gross profit. */
  grossMarginCents: number;
};

/**
 * Summarize a set of project rows into headline production KPIs. "Completed to
 * date" = work completed & stored across the latest applications (AIA line 4 —
 * NOT necessarily certified/invoiced, so it's labeled production, not "billed").
 * "remaining" = contract sum still to complete (never negative). Pure — call
 * over rows from listProjects (portfolio) or listProjects({ accountId }) (360).
 */
export function summarizeProduction(rows: ProjectRow[]): ProductionSummary {
  let contractValueCents = 0;
  let completedToDateCents = 0;
  let retainageHeldCents = 0;
  let pendingCoCount = 0;
  let pendingCoCents = 0;
  let inProductionProjects = 0;
  let billingProjects = 0;
  let invoicedCents = 0;
  let billedContractCents = 0;
  let paidCents = 0;
  let leftToBillCents = 0;
  let costsCents = 0;
  for (const r of rows) {
    contractValueCents += r.contractToDateCents;
    completedToDateCents += r.completedToDateCents;
    retainageHeldCents += r.retainageHeldCents;
    pendingCoCount += r.pendingCoCount;
    pendingCoCents += r.pendingCoCents;
    invoicedCents += r.invoicedCents;
    billedContractCents += r.billedContractCents;
    paidCents += r.paidCents;
    costsCents += r.costsCents;
    // Sum per-project left-to-bill (already clamped ≥0 per project), so one
    // over-billed job can't mask another's remaining headroom.
    leftToBillCents += r.leftToBillCents;
    if (r.opp.status === "in_progress" || r.opp.status === "billing") inProductionProjects += 1;
    if (r.opp.status === "billing") billingProjects += 1;
  }
  return {
    activeProjects: rows.length,
    inProductionProjects,
    billingProjects,
    contractValueCents,
    completedToDateCents,
    retainageHeldCents,
    pendingCoCount,
    pendingCoCents,
    invoicedCents,
    billedContractCents,
    paidCents,
    leftToBillCents,
    outstandingCents: Math.max(0, invoicedCents - paidCents),
    costsCents,
    grossMarginCents: contractValueCents - costsCents,
    // remaining now means "left to bill" (contract − invoiced), the number
    // operators actually expect when they invoice.
    remainingCents: leftToBillCents,
  };
}
