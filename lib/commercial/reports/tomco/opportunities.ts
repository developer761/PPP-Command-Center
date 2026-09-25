import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { bidMidCents } from "@/lib/commercial/reports/pipeline";
import { formatUsPhone } from "@/lib/commercial/format-phone";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";

/**
 * The three deal-shaped reports Tomco runs, off one read.
 *
 *   Opportunity Pipeline Manager — Brendan's open bids, with the GC's number
 *   Scheduling Report            — what is coming up, and what it owes
 *   Open Sales                   — everything not closed, with the money on it
 *
 * They ask for the same row, so they share one query and differ only in filter,
 * grouping and columns. Verified against Tomco's own printed totals; where a
 * figure deliberately differs from Salesforce, the reason is written next to it.
 */

export type DealReportRow = {
  oppId: string;
  accountId: string;
  accountName: string;
  oppName: string;
  status: string;
  statusGroup: string;
  workOrderNumber: string | null;
  phone: string | null;
  email: string | null;
  closeYmd: string | null;
  /** The contract, change orders included — see the column comment. */
  contractCents: number;
  /** What an open bid is quoted at. */
  bidCents: number;
  taxCents: number;
  billedCents: number;
  paidCents: number;
  balanceCents: number;
  isOpenBid: boolean;
  /** Tomco's own shop and WIP buckets — not a customer job. */
  internal: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  sent: "Estimate Sent",
  estimating: "Opportunity Assigned",
  rfp: "RFP",
  coordination: "Coordination",
  ready_to_mobilize: "Ready to Mobilize",
  wip_on_site: "Work In Progress",
  wip_on_hold: "On Hold",
  substantial_completion: "Substantial Completion",
  completed_and_invoiced: "Complete Balance Owed",
  closeout: "Closeout",
  closed: "Closed",
  won: "Won",
  lost: "Lost",
};

/**
 * "Tomco SHOP", "Tomco WIP - …" — the buckets Tomco books its own overheads
 * against. Salesforce's Scheduling Report leaves them out (its 25 records are
 * our 26 minus the SHOP row, and excluding it lands the balance on
 * $1,294,976.25 to the cent), and they are not jobs anyone schedules, bills or
 * chases. Named here once so every report agrees on what counts as a customer.
 */
export function isInternalJob(title: string | null | undefined): boolean {
  return /^\s*tomco\s+(shop|wip)\b/i.test(title ?? "");
}

export async function getDealReportRows(): Promise<DealReportRow[]> {
  const sb = commercialDb();

  const opps = await paginateAll<{
    id: string;
    account_id: string;
    title: string | null;
    client_name: string | null;
    title_override: string | null;
    title_override_mode: string | null;
    status: string;
    sub_status: string | null;
    ppp_job_number: string | null;
    property_street: string | null;
    decided_at: string | null;
    accepted_contract_cents: number | null;
    bid_value_low_cents: number | null;
    bid_value_high_cents: number | null;
  }>(() =>
    sb
      .from("commercial_opportunities")
      .select(
        "id, account_id, title, client_name, title_override, title_override_mode, status, sub_status, ppp_job_number, property_street, decided_at, accepted_contract_cents, bid_value_low_cents, bid_value_high_cents"
      )
      .is("deleted_at", null)
      .order("id", { ascending: true })
  );
  if (opps.length === 0) return [];

  const oppIds = opps.map((o) => o.id);
  const accountIds = [...new Set(opps.map((o) => o.account_id))];

  const [invoices, accounts, contacts] = await Promise.all([
    paginateAll<{
      opportunity_id: string;
      status: string | null;
      subtotal_cents: number;
      total_cents: number;
      paid_cents: number;
      balance_cents: number;
    }>(() =>
      sb
        .from("commercial_invoices")
        .select("opportunity_id, status, subtotal_cents, total_cents, paid_cents, balance_cents")
        .in("opportunity_id", oppIds)
        .is("deleted_at", null)
        .order("id", { ascending: true })
    ),
    sb
      .from("commercial_accounts")
      .select("id, company_name, phone")
      .in("id", accountIds)
      .then((r) => (r.data ?? []) as { id: string; company_name: string | null; phone: string | null }[]),
    sb
      .from("commercial_account_contacts")
      .select("account_id, is_primary, contact:commercial_contacts(email, phone)")
      .in("account_id", accountIds)
      .then(
        (r) =>
          (r.data ?? []) as unknown as {
            account_id: string;
            is_primary: boolean;
            contact: { email: string | null; phone: string | null } | null;
          }[]
      ),
  ]);

  /**
   * APPROVED CHANGE ORDERS, which this report's own column promised and never
   * delivered.
   *
   * The column is labelled "Contract (incl. COs)" and the doc comment on
   * SCHEDULING_SPEC states outright: "ours INCLUDES approved change orders,
   * which is what the job is now worth." It did not — `contractCents` read
   * `accepted_contract_cents` raw, which is the base BEFORE change orders.
   *
   * Measured 2026-09-22: $122,610.49 of approved change orders missing from
   * "Total contract" on Open Sales, and $72,683.40 on Scheduling. A label that
   * asserts what the number is not is worse than an unlabelled one, because
   * nobody re-checks it.
   *
   * Same definition the deal page and the AIA ladder use:
   * contract-to-date = base + net approved COs.
   */
  const coByOpp = new Map<string, number>();
  {
    const cos = await paginateAll<{ opportunity_id: string; amount_cents: number }>(() =>
      sb
        .from("commercial_change_orders")
        .select("opportunity_id, amount_cents")
        .eq("status", "approved")
        .is("deleted_at", null)
        .in("opportunity_id", opps.map((o) => o.id))
        .order("id")
    );
    for (const c of cos) {
      coByOpp.set(c.opportunity_id, (coByOpp.get(c.opportunity_id) ?? 0) + Number(c.amount_cents ?? 0));
    }
  }

  // The current proposal per opportunity, so a bid with no range still carries
  // its quoted value — see the note on `bid` below.
  const { listCurrentProposalTotalByOpp } = await import("@/lib/commercial/proposals/db");
  const proposalTotalByOpp = await listCurrentProposalTotalByOpp(opps.map((o) => o.id));

  /**
   * AIA BILLING, which every other money report already counts and this one
   * did not.
   *
   * Tomco's biggest GCs are billed through G702/G703 applications, not
   * invoices, and `money` above is built from `commercial_invoices` alone. So
   * on Open Sales — a report whose own blurb promises "what has been billed
   * and what is in" — the four AIREF Bellport buildings sat at the top of the
   * list reading:
   *
   *     AIREF Building #2   contract $404,836.00   billed $0.00   owed $0.00
   *     AIREF Building #1            $283,082.00          $0.00        $0.00
   *     AIREF Building #3            $256,624.50          $0.00        $0.00
   *     AIREF Building #4            $256,624.50          $0.00        $0.00
   *
   * $1.2M of live contract shown as never billed and nothing outstanding,
   * while the AIA tool has three submitted applications against #1 alone and
   * the job-costs report puts #2 at $272,448.21 billed. Two reports, the same
   * job, $272k apart.
   *
   * ar-aging, cash-flow, jobs, receivables and transactions were all folded
   * into AIA months ago; this module was simply missed. Using the same bulk
   * rollup they use, so it cannot answer differently — two queries for the
   * whole set, not five per opportunity (see aiaBillingRollupBulk).
   */
  const { aiaBillingRollupBulk } = await import("@/lib/commercial/aia/db");
  const aiaByOpp = await aiaBillingRollupBulk(opps.map((o) => o.id));

  const money = new Map<string, { sub: number; total: number; paid: number; bal: number }>();
  /**
   * A DRAFT IS NOT BILLED, AND A VOID IS NOT OWED.
   *
   * This added up `balance_cents` across every live invoice whatever its
   * status. On LMJ- Galil Brands -21 Newton Place that put a DRAFT invoice of
   * $75,000 into "balance owed" on a $75,000 contract — so the Scheduling
   * report showed $94,000 owed (the draft plus $19,000 genuinely due through
   * AIA) while the job's own page, the AR sheet and the invoice panel all said
   * $19k. Owed was larger than the whole contract, on a report Brendan reads
   * down to decide who to chase.
   *
   * The Bannett Group read $71,250 owed on a $37,500 contract for the same
   * reason. Every draft in the book was inflating the grand total too.
   *
   * `receivableVerdict` is where this is already decided, and it records why:
   * a void is money nobody owes, and a draft is owed but NOT BILLED — so it is
   * listed as uninvoiced and never aged. Asking it here rather than
   * re-deriving is the same fix made in the assistant's money tools earlier
   * today, in the module that sits right next to this one.
   */
  const { receivableVerdict } = await import("@/lib/commercial/reports/receivables");
  for (const i of invoices) {
    const verdict = receivableVerdict(i.status as Parameters<typeof receivableVerdict>[0]);
    // Void: nobody owes it and nobody billed it. It contributes nothing.
    if (verdict === "skip") continue;
    const e = money.get(i.opportunity_id) ?? { sub: 0, total: 0, paid: 0, bal: 0 };
    // A draft is work that will be billed, not work that has been. It counts
    // towards neither billed nor owed — "left to bill" is where it shows up.
    if (verdict === "uninvoiced") {
      money.set(i.opportunity_id, e);
      continue;
    }
    e.sub += Number(i.subtotal_cents);
    e.total += Number(i.total_cents);
    e.paid += Number(i.paid_cents);
    e.bal += Number(i.balance_cents);
    money.set(i.opportunity_id, e);
  }
  const acct = new Map(accounts.map((a) => [a.id, a]));
  // The primary contact wins; any contact beats none — Brendan rings whoever is
  // on the row, and a blank phone column is the report failing at its job.
  const reach = new Map<string, { email: string | null; phone: string | null }>();
  for (const l of contacts) {
    if (!l.contact) continue;
    const have = reach.get(l.account_id);
    if (!have || l.is_primary) reach.set(l.account_id, l.contact);
  }

  return opps.map((o) => {
    const m = money.get(o.id) ?? { sub: 0, total: 0, paid: 0, bal: 0 };
    const aia = aiaByOpp.get(o.id);
    const a = acct.get(o.account_id);
    const c = reach.get(o.account_id);
    /**
     * THE SAME BID FIGURE THE TILES ABOVE THIS TABLE USE.
     *
     * This read `bid_value_low_cents ?? 0` — one end of a range, and zero when
     * there is no range at all. The Pipeline page shows both this table and
     * `getPipelineReport`'s tiles, and on 2026-09-25 they disagreed by
     * $54,537.20 over the same forty open bids.
     *
     * The gap was two opportunities with no bid range and a priced proposal on
     * file, which this counted as $0 — one of them Vision General Contractors
     * at Tesla CC, a proposal actually SENT for $38,030.20. A pipeline report
     * that values a live quote at nothing is worse than one that is merely
     * imprecise: the deal is invisible in the total Brendan reads.
     *
     * `bidMidCents` is the shared derivation — midpoint of the range, falling
     * back to the current proposal when there is no range. Using it here means
     * the two halves of one page cannot disagree again.
     */
    const bid = bidMidCents(o, proposalTotalByOpp.get(o.id));
    return {
      oppId: o.id,
      accountId: o.account_id,
      accountName: (a?.company_name ?? "").trim() || "Unassigned account",
      oppName: derivedOppName({ ...o, title: o.title ?? "" }, a?.company_name ?? null),
      status: STATUS_LABEL[o.sub_status ?? ""] ?? o.sub_status ?? "—",
      statusGroup: o.status,
      workOrderNumber: o.ppp_job_number,
      phone: a?.phone ?? c?.phone ?? null,
      email: c?.email ?? null,
      closeYmd: o.decided_at ? String(o.decided_at).slice(0, 10) : null,
      contractCents: Number(o.accepted_contract_cents ?? 0) + (coByOpp.get(o.id) ?? 0),
      bidCents: bid,
      taxCents: Math.max(0, m.total - m.sub),
      // Invoice subtotal PLUS anything billed through AIA. The two are
      // mutually exclusive in practice — a job bills one way or the other —
      // but adding rather than choosing means a job that has done both is
      // still right, and a job that has done neither is still zero.
      billedCents: m.sub + (aia?.billedCents ?? 0),
      paidCents: m.paid + (aia?.collectedCents ?? 0),
      // `dueNowCents` is G702 line 6 less what has been collected, and it
      // EXCLUDES retainage on purpose: retainage is held to close-out, not
      // late, so counting it as owed would age money nobody is withholding
      // wrongly. Same field the AR aging report ages.
      balanceCents: m.bal + (aia?.dueNowCents ?? 0),
      isOpenBid: ["proposal", "estimating", "qualifying"].includes(o.status),
      internal: isInternalJob(o.title),
    };
  });
}

// ─── 1. Opportunity Pipeline Manager ────────────────────────────────────────

/**
 * Brendan's open book. 39 bids, $2,116,612.79 — the figure printed at the top
 * of his Salesforce report, to the cent.
 *
 * The phone and email columns are the point of it: he works down this list.
 */
export const PIPELINE_MANAGER_SPEC: ReportSpec<DealReportRow> = {
  title: "Opportunity Pipeline Manager",
  sourceLabel: "Opportunities with or without Quotes",
  blurb: "Every open bid with what it is quoted at and who to ring about it.",
  totals: [{ label: "Total quoted subtotal", value: (rows) => rows.reduce((n, r) => n + r.bidCents, 0) }],
  groupings: [
    [{ key: "status", label: "Status", of: (r) => r.status }],
    [{ key: "account", label: "GC", of: (r) => r.accountName }],
  ],
  columns: [
    { key: "opp", label: "Opportunity name", text: (r) => r.oppName, href: (r) => `/commercial/opportunities/${r.oppId}` },
    { key: "account", label: "GC", text: (r) => r.accountName, secondary: true },
    { key: "quoted", label: "Quoted subtotal", kind: "money", amount: (r) => r.bidCents },
    /**
     * THE TWO COLUMNS THIS REPORT EXISTS FOR, AND NEITHER WAS CLICKABLE.
     *
     * The blurb right above says he works down this list, and every other
     * surface that shows a contact — the account page, the project team card —
     * dials and mails from it. Here they were plain text, so the one report
     * built for ringing people was the one you had to copy a number out of,
     * on a phone as much as on a desk.
     *
     * Formatted too: the numbers arrive however they were typed, so the column
     * ran "631-224-8894" down to "5165236737" and back. A column you read down
     * at speed, with one row in a different shape, is where the misdial comes
     * from. The `tel:` target keeps the raw digits — formatting is for the eye,
     * not the dialler.
     */
    {
      key: "phone",
      label: "Phone",
      text: (r) => formatUsPhone(r.phone),
      href: (r) => (r.phone ? `tel:${r.phone.replace(/[^0-9+]/g, "")}` : null),
      csvText: (r) => r.phone,
    },
    {
      key: "email",
      label: "Email",
      text: (r) => r.email,
      href: (r) => (r.email ? `mailto:${r.email}` : null),
      secondary: true,
    },
  ],
};

export const pipelineManagerRows = (rows: DealReportRow[]) =>
  rows.filter((r) => r.isOpenBid).sort((a, b) => b.bidCents - a.bidCents);

// ─── 2. Scheduling Report ───────────────────────────────────────────────────

/**
 * What is on, coming up, or stuck — and what each one still owes.
 *
 * 25 records and $1,294,976.25 owed, matching Salesforce exactly once Tomco's
 * own SHOP bucket is left out (see `isInternalJob`).
 *
 * The contract column deliberately differs from Salesforce's "Quoted Subtotal":
 * ours INCLUDES approved change orders, which is what the job is now worth.
 * Salesforce's is the figure before them. The column says so.
 */
const SCHEDULING_STATUSES = new Set(["Coordination", "Ready to Mobilize", "Work In Progress", "On Hold"]);

export const SCHEDULING_SPEC: ReportSpec<DealReportRow> = {
  title: "Scheduling Report",
  sourceLabel: "Opportunities with Work Orders",
  blurb: "Jobs in coordination, on site, or on hold — what they are worth and what is still owed on them.",
  totals: [
    { label: "Total contract", value: (rows) => rows.reduce((n, r) => n + r.contractCents, 0) },
    { label: "Total balance owed", value: (rows) => rows.reduce((n, r) => n + r.balanceCents, 0) },
  ],
  groupings: [
    [{ key: "status", label: "Status", of: (r) => r.status }],
    [{ key: "account", label: "GC", of: (r) => r.accountName }],
  ],
  columns: [
    { key: "opp", label: "Name", text: (r) => r.oppName, href: (r) => `/commercial/opportunities/${r.oppId}` },
    { key: "wo", label: "Work order", text: (r) => r.workOrderNumber, secondary: true },
    { key: "contract", label: "Contract (incl. COs)", kind: "money", amount: (r) => r.contractCents },
    { key: "balance", label: "Balance owed", kind: "money", amount: (r) => r.balanceCents },
    // Same treatment as the Pipeline Manager's — this is the other report with
    // a GC's number beside a balance owed, and it is read the same way.
    {
      key: "phone",
      label: "Phone",
      text: (r) => formatUsPhone(r.phone),
      href: (r) => (r.phone ? `tel:${r.phone.replace(/[^0-9+]/g, "")}` : null),
      csvText: (r) => r.phone,
      secondary: true,
    },
  ],
};

export const schedulingRows = (rows: DealReportRow[]) =>
  rows
    .filter((r) => !r.internal && SCHEDULING_STATUSES.has(r.status))
    .sort((a, b) => b.contractCents - a.contractCents);

// ─── 3. Open Sales ──────────────────────────────────────────────────────────

/**
 * "All sales which are not closed" — every live job with the money on it, which
 * is the one screen that answers "what is in flight and what is it worth".
 */
export const OPEN_SALES_SPEC: ReportSpec<DealReportRow> = {
  title: "Open Sales",
  sourceLabel: "Opportunities with Work Orders",
  blurb: "Every won job that is not yet closed out, with what it is worth, what has been billed and what is in.",
  totals: [
    { label: "Total contract", value: (rows) => rows.reduce((n, r) => n + r.contractCents, 0) },
    { label: "Total tax", value: (rows) => rows.reduce((n, r) => n + r.taxCents, 0) },
    { label: "Total billed", value: (rows) => rows.reduce((n, r) => n + r.billedCents, 0) },
    { label: "Total balance owed", value: (rows) => rows.reduce((n, r) => n + r.balanceCents, 0) },
  ],
  groupings: [
    [{ key: "status", label: "Status", of: (r) => r.status }],
    [{ key: "account", label: "GC", of: (r) => r.accountName }],
  ],
  columns: [
    { key: "opp", label: "Opportunity name", text: (r) => r.oppName, href: (r) => `/commercial/opportunities/${r.oppId}` },
    { key: "wo", label: "Work order", text: (r) => r.workOrderNumber, secondary: true },
    { key: "close", label: "Close date", text: (r) => r.closeYmd, secondary: true },
    { key: "contract", label: "Contract", kind: "money", amount: (r) => r.contractCents },
    { key: "tax", label: "Tax", kind: "money", amount: (r) => r.taxCents, secondary: true },
    { key: "billed", label: "Billed", kind: "money", amount: (r) => r.billedCents },
    { key: "balance", label: "Balance owed", kind: "money", amount: (r) => r.balanceCents },
  ],
};

/** Won, and not finished with: everything post-sale that is not closed out. */
export const openSalesRows = (rows: DealReportRow[]) =>
  rows
    .filter((r) => !r.internal && !r.isOpenBid && r.statusGroup !== "post_sale_closed" && r.statusGroup !== "pre_sale_closed")
    .sort((a, b) => b.contractCents - a.contractCents);
