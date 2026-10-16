import "server-only";

/**
 * Job P&L for ONE project (Phase 2). Contract − Costs = Gross Margin.
 *
 * Consistency (audit C1): the contract comes from `contractValueCents` — the
 * one definition of base-plus-net-approved-change-orders — so the deal P&L
 * cannot drift from the project card, the G702 or the Salesforce sync on a
 * deal with a CO. This file used to add the two halves itself, which is the
 * shape that produced Stephanie's report; see contract-value.ts.
 *
 * Revenue is PRE-TAX vs the contract (the contract is a pre-tax number); AR uses
 * with-tax totals + the clamped per-invoice open balance (matches the account
 * rollup / AR statement). Costs come from commercial_project_purchases (which
 * only ever sums live rows — deleted purchases drop out, audit C2).
 */

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { aiaBillingRollup } from "@/lib/commercial/aia/db";
import { contractValueCents } from "@/lib/commercial/projects/contract-value";
import {
  costBreakdownForProject,
  laborByWorkerForProject,
  type CostBreakdown,
} from "@/lib/commercial/purchases/db";
import { fieldOpsLaborForOpp, fieldOpsCrewDetailForOpp } from "@/lib/commercial/field-ops/labor-cost";
import { findDoubleCounted } from "@/lib/commercial/field-ops/w2-readiness";
import {
  unratedHoursNote,
  type UnratedPayoutCoverage,
} from "@/lib/commercial/field-ops/unrated-hours-note";

export type ProjectFinancials = {
  /** Pre-tax contract to date = base ladder + net-approved COs. */
  contractCents: number;
  hasContract: boolean;
  /** Σ issued invoices total_cents (WITH tax) — the AR figure. */
  invoicedCents: number;
  /** Σ issued invoices subtotal_cents (PRE-tax) — compared to the contract. */
  billedPreTaxCents: number;
  /** Σ issued invoices paid_cents. */
  collectedCents: number;
  /** Σ per-invoice max(0, balance) — the true open receivable (a credit on one
   *  invoice can't mask another). */
  openBalanceCents: number;
  /** Σ per-invoice max(0, −balance) — overpayment credits, surfaced separately
   *  so an overpaid deal shows a credit, not a hidden $0 balance. */
  creditCents: number;
  /** AIA retainage the GC is holding back. NOT in `openBalanceCents` — it isn't
   *  payable until close-out — but it is real money, so it is carried here for
   *  surfaces that want to show "owed now, plus X at close-out". */
  retainageHeldCents: number;
  /** The AIA slice of `openBalanceCents`, and when it fell due. Carried so a
   *  caller can tell a LATE payment application from a current one: without
   *  the date, a job billed only through G702/G703 could be flagged for the
   *  amount it owes but never for being overdue. Both null/0 on a job with no
   *  AIA billing. */
  aiaDueNowCents: number;
  aiaDueAt: string | null;
  /** Purchases only (materials, subs, equipment, permits, subcontract labor…). */
  costs: CostBreakdown;
  /** Option A — burdened cost of in-house crew hours (approved time-entries ×
   *  effective cost rate), computed from Field Ops, NOT a purchase row. */
  fieldOpsLaborCents: number;
  /** Approved crew hours with no cost rate on file → they cost $0 here. On its
   *  own this says NOTHING about whether the margin is understated: on 79 of
   *  81 live deals the same hours are already paid through a labor payout.
   *  Use `laborUncostedHours` for that question. */
  laborUnratedHours: number;
  /** The subset of `laborUnratedHours` that NO labor payout on this deal
   *  covers — the hours that genuinely cost nothing yet. This is the number a
   *  "margin reads high" caveat may be stated about. */
  laborUncostedHours: number;
  /** Σ labor already paid on this deal to the people whose hours read
   *  unrated. > 0 is the evidence that those hours are not free. */
  laborUnratedPayoutCents: number;
  /** Purchases + field-ops labor = the deal's total cost. */
  totalCostCents: number;
  /** Contract − total costs = projected gross profit. Negative = over budget. */
  grossMarginCents: number;
  /** margin / contract, whole %, null when contract is 0 (no divide-by-zero). */
  grossMarginPct: number | null;
};

type InvRow = {
  invoice_number: string | null;
  opportunity_id: string | null;
  status: string;
  total_cents: number;
  subtotal_cents: number;
  paid_cents: number;
  balance_cents: number;
};

export async function getProjectFinancials(oppId: string): Promise<ProjectFinancials> {
  const sb = commercialDb();
  const [contractCents, costs, labor, invRes, aia] = await Promise.all([
    contractValueCents(oppId),
    costBreakdownForProject(oppId),
    fieldOpsLaborForOpp(oppId),
    sb
      .from("commercial_invoices")
      // `invoice_number` + `opportunity_id` so the carry-over guard can run —
      // see the fold below and lib/commercial/invoices/carryover.ts.
      .select("invoice_number, opportunity_id, status, total_cents, subtotal_cents, paid_cents, balance_cents")
      .eq("opportunity_id", oppId)
      .is("deleted_at", null),
    // AIA is a SEPARATE billing ledger — a job billed via G702/G703 writes no
    // commercial_invoices. `listProjects` folds the same figures the same way,
    // so the deal page, dashboard, portfolio + account detail all agree. No-op
    // (hasAia:false) for a non-AIA deal.
    aiaBillingRollup(oppId),
  ]);

  const hasContract = contractCents > 0;

  /*
   * THE MIGRATED SALESFORCE INVOICE IS THE SAME MONEY AS THE CERTIFICATES.
   *
   * This fold is `invoices + AIA`, and its own comment called that "additive
   * ... a deal that used both is the double-bill the CO-picker warns about, not
   * something to net". That is right for two genuine bills and wrong for the
   * one case the importer creates: an `SF-####` placeholder carrying a work
   * order's balance on a job now billed through G702. On LMJ Cipla it reported
   * invoiced $187,754.18 against an $88,627.09 contract — 212% — and collected
   * $176,204.19, because the same five cheques sit on both ledgers.
   *
   * `receivables.ts` and `ar-aging.ts` have excluded it since 2026-10-15. The
   * deal P&L, the portfolio, Account 360 and the GC's own statement did not.
   */
  const { isSupersededByAia } = await import("@/lib/commercial/invoices/carryover");
  const supersededByAia = aia.hasAia
    ? (r: { invoice_number?: string | null; opportunity_id?: string | null }) =>
        isSupersededByAia(r, new Set([oppId]))
    : () => false;

  let invoicedCents = 0;
  let billedPreTaxCents = 0;
  let collectedCents = 0;
  let openBalanceCents = 0;
  let creditCents = 0;
  let aiaRetainageHeldCents = 0;
  for (const r of (invRes.data ?? []) as InvRow[]) {
    // Issued only — a draft isn't billed; a void doesn't count (mirrors the
    // account rollup + listProjects).
    if (r.status === "draft" || r.status === "void") continue;
    // The carry-over placeholder and this job's certificates are one bill.
    if (supersededByAia(r)) continue;
    invoicedCents += Number(r.total_cents ?? 0);
    billedPreTaxCents += Number(r.subtotal_cents ?? 0);
    collectedCents += Number(r.paid_cents ?? 0);
    const bal = Number(r.balance_cents ?? 0);
    openBalanceCents += Math.max(0, bal);
    creditCents += Math.max(0, -bal);
  }
  // Fold in AIA billing (separate ledger — see aiaBillingRollup). AIA amounts
  // are pre-tax contract values with no separate sales-tax line, so `invoiced`
  // (the with-tax AR figure) takes the same amount as `billed`. Retainage held
  // stays in the open balance (billed − collected). Additive with invoices: a
  // deal that used both is the double-bill the CO-picker warns about, not
  // something to net. Definitions per docs/AIA_FINANCIALS_INTEGRATION.md (Karan
  // 2026-08-14 "fix everything"; Katie/Alex still to confirm retainage treatment).
  if (aia.hasAia) {
    invoicedCents += aia.billedCents;
    billedPreTaxCents += aia.billedCents;
    collectedCents += aia.collectedCents;
    // NET OF RETAINAGE (decided 2026-08-17). `dueNowCents` is G702 line 6 minus
    // collected — what the GC is contractually obliged to pay today. This used
    // to be `billed − collected`, which folded retainage into the receivable
    // and made a GC who is fully current read as owing money. Retainage is
    // carried separately (`retainageHeldCents`) and shown, never dropped.
    openBalanceCents += aia.dueNowCents;
    aiaRetainageHeldCents = aia.retainageHeldCents;
  }

  const coverage = await unratedCoverageForOpp(oppId, labor.unratedHours);

  const fieldOpsLaborCents = labor.cents;
  const totalCostCents = costs.total + fieldOpsLaborCents;
  const grossMarginCents = contractCents - totalCostCents;
  const grossMarginPct = hasContract ? Math.round((grossMarginCents / contractCents) * 100) : null;

  return {
    contractCents,
    hasContract,
    invoicedCents,
    billedPreTaxCents,
    collectedCents,
    openBalanceCents,
    creditCents,
    retainageHeldCents: aiaRetainageHeldCents,
    aiaDueNowCents: aia.hasAia ? aia.dueNowCents : 0,
    aiaDueAt: aia.hasAia ? aia.dueAt : null,
    costs,
    fieldOpsLaborCents,
    laborUnratedHours: labor.unratedHours,
    laborUncostedHours: coverage.uncostedHours,
    laborUnratedPayoutCents: coverage.coveredByPayoutCents,
    totalCostCents,
    grossMarginCents,
    grossMarginPct,
  };
}

// ── ARE THE UNRATED HOURS ACTUALLY UNPAID? ─────────────────────────────────

/**
 * Measured against production 2026-10-16: 14,637 hours read unrated across 81
 * deals, and 14,589 of them (99.7%, on 79 of the 81) already carried
 * `labor`/`employee_labor` purchases naming the same nine people —
 * $510,469.42. Every one of those deals was telling its reader the margin read
 * high and the hours needed costing, which is the double-charge the whole
 * payroll build exists to prevent. Only 2 deals / 48h were genuinely uncosted.
 *
 * So "unrated" is the input to the question, not the answer. The answer is
 * "unrated AND nobody has been paid for it", and `findDoubleCounted` already
 * owns the hard half — matching a roster name against the vendor on a payout,
 * trimmed and case-insensitive, because the money goes to "Tomco Labor - Greg"
 * rather than to an employee id.
 */

/**
 * Pure: which unrated hours survive the payout test.
 *
 * `laborPaidTo` is this deal's labor spend keyed by the vendor name on the
 * payment. A person whose name matches a payee is costed — their hours drop
 * out, and the payout is reported so a caller can say so.
 */
export function unratedCoverageFrom(
  unratedPeople: { id: string; name: string; unratedHours: number }[],
  laborPaidTo: Map<string, { cents: number; n: number }>
): UnratedPayoutCoverage {
  const covered = findDoubleCounted(
    unratedPeople.map((p) => ({ id: p.id, name: p.name })),
    laborPaidTo
  );
  const coveredIds = new Set(covered.map((c) => c.id));
  const uncostedHours = unratedPeople
    .filter((p) => !coveredIds.has(p.id))
    .reduce((n, p) => n + p.unratedHours, 0);
  return {
    uncostedHours: Math.round(uncostedHours * 100) / 100,
    coveredByPayoutCents: covered.reduce((n, c) => n + c.payoutCents, 0),
  };
}

/** ONE deal, name-matched and exact. Two reads, and only when there is
 *  something to decide — a deal with no unrated hours short-circuits. */
async function unratedCoverageForOpp(
  oppId: string,
  unratedHours: number
): Promise<UnratedPayoutCoverage> {
  if (!(unratedHours > 0)) return { uncostedHours: 0, coveredByPayoutCents: 0 };
  const [crew, paid] = await Promise.all([
    fieldOpsCrewDetailForOpp(oppId),
    laborByWorkerForProject(oppId),
  ]);
  const laborPaidTo = new Map(
    paid.map((w) => [w.worker, { cents: w.cost_cents, n: w.count }] as const)
  );
  const people = crew.workers
    .filter((w) => w.unratedHours > 0)
    .map((w) => ({ id: w.employeeId, name: w.name, unratedHours: w.unratedHours }));
  // The crew walk and `fieldOpsLaborForOpp` read the same entries under the
  // same rules, but if they ever disagree, believe the aggregate the P&L is
  // actually built from rather than silently shrinking the warning.
  if (people.length === 0) return { uncostedHours: unratedHours, coveredByPayoutCents: 0 };
  return unratedCoverageFrom(people, laborPaidTo);
}

/**
 * MANY deals at once, for the aggregate surfaces (geography, the CEO digest,
 * any report built on `listProjects`).
 *
 * DELIBERATELY COARSER than the per-deal version, and the reason is cost: the
 * exact test needs each deal's per-person crew detail, which is a handful of
 * queries per deal — 150+ deals on the geography report. This asks the
 * deal-level question instead ("is anybody being paid for labor on this
 * job?") in ONE query across the whole portfolio.
 *
 * What that trades away: a deal that pays person A while person B's hours read
 * unrated would be cleared here and flagged by the per-deal test. On the live
 * book today the two agree exactly — both say 79 of 81 deals covered, 2 deals
 * / 48h uncosted — because the uncovered deals carry no labor purchases at
 * all. It can only ever UNDER-report the warning, never invent one.
 */
export async function uncostedHoursByOpp(
  rows: { oppId: string; unratedHours: number }[]
): Promise<Map<string, UnratedPayoutCoverage>> {
  const out = new Map<string, UnratedPayoutCoverage>();
  const pending = rows.filter((r) => r.oppId && r.unratedHours > 0);
  for (const r of rows) out.set(r.oppId, { uncostedHours: 0, coveredByPayoutCents: 0 });
  if (pending.length === 0) return out;

  const sb = commercialDb();
  const purchases = await paginateAll<{ opportunity_id: string | null; amount_cents: number | null }>(() =>
    sb
      .from("commercial_project_purchases")
      .select("opportunity_id, amount_cents")
      // The same two categories `findDoubleCounted`'s caller feeds it: what
      // goes to a labor company, and payroll's own posted rows.
      .in("category", ["labor", "employee_labor"])
      .is("deleted_at", null)
      .order("id", { ascending: true })
  );
  const paidByOpp = new Map<string, number>();
  for (const p of purchases) {
    if (!p.opportunity_id) continue;
    paidByOpp.set(p.opportunity_id, (paidByOpp.get(p.opportunity_id) ?? 0) + (Number(p.amount_cents) || 0));
  }

  for (const r of pending) {
    const paid = paidByOpp.get(r.oppId) ?? 0;
    out.set(
      r.oppId,
      paid > 0
        ? { uncostedHours: 0, coveredByPayoutCents: paid }
        : { uncostedHours: r.unratedHours, coveredByPayoutCents: 0 }
    );
  }
  return out;
}

// ── ONE margin definition (2026-08) ────────────────────────────────────────

export type DealMargin = {
  /** Whole-percent margin, or null when it can't be stated honestly. */
  pct: number | null;
  /** Margin dollars — meaningful even when pct is null. */
  cents: number;
  /** What to call it. "Projected" until real costs are booked. */
  label: string;
  /** A one-line caveat to render under the number, or null. */
  caveat: string | null;
  /** True when the number is a loss big enough that a raw % misleads. */
  overBudget: boolean;
  /**
   * True when the percentage is arithmetically real but doesn't yet mean what
   * it appears to — nothing billed, or nothing spent.
   *
   * Callers use it to keep a chart from painting an unstarted job's 100%
   * emerald right next to a caption saying no costs have been booked.
   */
  provisional: boolean;
  /**
   * The contract-basis view — "how is this tracking against what we sold?"
   *
   * Carries its own label because D2 allows this number ONLY as an explicitly
   * labeled secondary. Rendering it under the bare word "margin" is what made
   * two surfaces disagree in the first place.
   */
  vsContract: { pct: number; cents: number; label: string } | null;
};

/**
 * The single margin every surface must use.
 *
 * There were THREE visible margins for one deal, disagreeing:
 *   - the deal Overview  — billed-based, guarded on costs > 0  → "—"
 *   - the P&L tab        — billed-based, NO cost guard         → "100%"
 *   - the Transactions chip — contract-based                   → different again
 * $200k billed with no costs booked yet showed "—" and "100%" two clicks apart.
 *
 * The basis is BILLED — margin to date, matching the dashboard bars, the
 * account Profitability rollup and the P&L cards. That was decision D2, and an
 * earlier version of this function ignored it and headlined the contract basis
 * instead: the two deal surfaces then agreed with each other but disagreed with
 * every rollup above them, which is the split unifying the margin was meant to
 * end. The contract view still has a use — it answers "how is this job tracking
 * against what we sold?" — so it comes back as `vsContract`, under a label that
 * says so. It must never appear under the bare word "margin".
 *
 * Because both billing and costs accrue over a job, either number is a
 * position, not a result. The labels say so rather than letting a 100% read as
 * money in the bank.
 */
/**
 * Margin from a billed/cost pair — the shared core, usable by the aggregate
 * surfaces (account rollup, dashboard bars, reports) that have two numbers
 * rather than a whole ProjectFinancials.
 *
 * The reason this is shared rather than re-derived per screen: `net ÷ gross` is
 * trivial arithmetic, so every surface wrote its own — and every one of them
 * printed "100%" next to "no costs logged", which reads as a triumph and
 * actually means nobody has spent anything yet.
 */
/**
 * `uncostedHours` — crew hours on this slice that NO labor payout covers.
 *
 * It is the THIRD argument and not a required one, which is a compromise worth
 * naming. The caveat belongs here so a caller cannot forget it, and the honest
 * version of that is a required parameter; `marginFrom` has eight call sites
 * across six files, several of which this change may not touch, and a required
 * parameter would simply fail to build. So: optional, defaulting to "nothing
 * uncosted", and the callers that know get it right. Surfaces still to be
 * wired: `reports/job-costs.ts`, `reports/jobs-rows.ts`, `reports/jobs.ts`,
 * `app/commercial/page.tsx`, `app/commercial/accounts/[id]/page.tsx`,
 * `app/commercial/invoices/new/page.tsx`.
 */
export function marginFrom(
  billedCents: number,
  costCents: number,
  uncostedHours = 0
): {
  pct: number | null;
  cents: number;
  label: string;
  caveat: string | null;
  provisional: boolean;
  overBudget: boolean;
} {
  const cents = billedCents - costCents;
  if (billedCents <= 0) {
    return {
      pct: null,
      cents,
      label: "Margin",
      caveat: costCents > 0 ? "Nothing billed yet — costs only." : "Nothing billed yet.",
      provisional: true,
      overBudget: false,
    };
  }
  const pct = Math.round((cents / billedCents) * 100);
  if (costCents === 0) {
    return {
      pct,
      cents,
      label: "Projected margin",
      caveat: "No costs booked yet — this is everything billed, not profit.",
      provisional: true,
      overBudget: false,
    };
  }
  return {
    pct,
    cents,
    label: "Margin",
    // The margin IS overstated when hours nobody has been paid for sit behind
    // it. Three surfaces printed a bare percentage here — the geography
    // report's per-city/zip/state rows and the CEO digest's "62% · healthy" —
    // while the portfolio carried 14,637 unrated hours. Only the hours no
    // payout covers earn the sentence; see unrated-hours-note.ts.
    caveat: unratedHoursNote({ uncostedHours, coveredByPayoutCents: 0 }),
    provisional: false,
    overBudget: pct < -100,
  };
}

export function dealMargin(fin: {
  billedPreTaxCents: number;
  contractCents: number;
  hasContract: boolean;
  laborUnratedHours: number;
  /**
   * The unrated hours no labor payout covers. REQUIRED on
   * `ProjectFinancials`, so every production caller supplies it; optional here
   * only so a pure unit test can state a case in two fields instead of five.
   * Omitted, it falls back to `laborUnratedHours` — the pre-2026-10-16
   * behaviour, which is wrong on 79 of 81 live deals and is why this field
   * exists.
   */
  laborUncostedHours?: number;
  totalCostCents: number;
}): DealMargin {
  const uncostedHours = fin.laborUncostedHours ?? fin.laborUnratedHours;
  const core = marginFrom(fin.billedPreTaxCents, fin.totalCostCents, uncostedHours);
  const marginCents = core.cents;

  // The contract view, always separately labeled. Null when there's no contract
  // to measure against — a ratio over zero is undefined, not 0%.
  const contractMarginCents = fin.contractCents - fin.totalCostCents;
  const vsContract =
    fin.hasContract && fin.contractCents > 0
      ? {
          pct: Math.round((contractMarginCents / fin.contractCents) * 100),
          cents: contractMarginCents,
          label: "vs contract (budget)",
        }
      : null;

  // Nothing billed → no margin to date. Costs already spent are still real, so
  // the dollars show; the percentage would be a division by zero.
  if (fin.billedPreTaxCents <= 0) {
    return {
      pct: null,
      cents: marginCents,
      label: "Gross margin",
      caveat:
        fin.totalCostCents > 0
          ? "Nothing billed yet — costs are booked against an unbilled job."
          : "Nothing billed yet.",
      overBudget: false,
      provisional: true,
      vsContract,
    };
  }

  const pct = Math.round((marginCents / fin.billedPreTaxCents) * 100);

  // Zero costs is not a 100% margin, it's a job nobody has spent anything on
  // yet. Saying "100%" there reads as a triumph and means nothing.
  if (fin.totalCostCents === 0) {
    return {
      pct,
      cents: marginCents,
      label: "Projected gross margin",
      caveat: "No costs booked yet — this is everything billed, not profit.",
      overBudget: false,
      provisional: true,
      vsContract,
    };
  }

  /**
   * The ninth surface carrying this sentence, and the one on every deal page.
   *
   * Eight screens were corrected earlier today; this one builds the string
   * that feeds the deal's own margin card, so AIREF Building #1 still read
   * "Margin understated — 326 crew hours have no cost rate" beside a "Crew
   * hours 91" tile.
   *
   * Having no cost rate is CORRECT for a W-2 employee: their cost is the real
   * Gusto liability, split across jobs when the week is posted. Telling
   * somebody to fix it invites the double-count the payroll build exists to
   * prevent. The hours are not misconfigured, they are waiting.
   */
  /**
   * "OF THE CREW HOURS ON THIS JOB" — because this number sits beside a
   * different one.
   *
   * The deal header puts this caveat directly next to a Crew hours tile. On
   * AIREF Building #1 that reads "Margin reads high — 326 crew hours not
   * costed yet" an inch from "CREW HOURS 400": two crew-hour figures on one
   * row, and nothing on screen saying that the first is part of the second.
   *
   * Both are right. `laborUnratedHours` is the subset of approved attendance
   * that has no cost rate on the work day — correct for a W-2 employee, whose
   * cost is the real Gusto liability split across jobs when the week is posted
   * — and the tile is all approved attendance. A reader cannot get that from
   * two bare numbers, and the one they act on is whichever they read second.
   *
   * The total is not passed in here and is NOT asserted: saying "326 of 400"
   * would claim the two are computed off the same base, which this function
   * cannot see. Naming it as a part is enough to stop it reading as a rival
   * total.
   */
  /**
   * 🔴 AND ONLY WHEN NOBODY HAS BEEN PAID FOR THEM (2026-10-16).
   *
   * This fired on `laborUnratedHours > 0` with no check that the labor was
   * paid some other way, which on the live book meant 79 of 81 deals. LMJ
   * Cipla read "Margin reads high — 1063 of the crew hours on this job are not
   * costed yet, until that week is posted in Payroll" while carrying
   * $37,416.22 of `employee_labor`/`labor` purchases naming those exact
   * people. Greg alone: 250 unrated hours against $12,295.01 booked, $49.18/h.
   *
   * The sentence was false, and the action it names — go and cost those hours
   * — is the double-charge. `laborUncostedHours` is the subset no payout
   * covers; on the live book that is 2 deals and 48 hours.
   */
  const caveat =
    uncostedHours > 0
      ? `Margin reads high — ${uncostedHours} of the crew hours on this job ${uncostedHours === 1 ? "is" : "are"} not costed yet, until that week is posted in Payroll.`
      : null;
  return {
    pct,
    cents: marginCents,
    label: "Gross margin",
    caveat,
    // Below −100% a raw percentage stops communicating ("-4900%"); the words
    // do the work instead.
    overBudget: pct < -100,
    provisional: false,
    vsContract,
  };
}
