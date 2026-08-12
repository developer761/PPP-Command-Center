import "server-only";

/**
 * Job P&L for ONE project (Phase 2). Contract − Costs = Gross Margin.
 *
 * Consistency (audit C1): the contract base here is computed EXACTLY as
 * listProjects computes `contractToDateCents` — `getEffectiveContractBaseCents`
 * (the shared proposal→AIA→bid ladder) PLUS net-approved change orders. The
 * ladder helper does NOT include COs; every caller adds them, so we do too, or
 * the deal P&L would disagree with the project card on any deal with a CO.
 *
 * Revenue is PRE-TAX vs the contract (the contract is a pre-tax number); AR uses
 * with-tax totals + the clamped per-invoice open balance (matches the account
 * rollup / AR statement). Costs come from commercial_project_purchases (which
 * only ever sums live rows — deleted purchases drop out, audit C2).
 */

import { commercialDb } from "@/lib/commercial/db";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { netApprovedChangeOrderCents } from "@/lib/commercial/change-orders/db";
import { costBreakdownForProject, type CostBreakdown } from "@/lib/commercial/purchases/db";
import { fieldOpsLaborForOpp } from "@/lib/commercial/field-ops/labor-cost";

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
  /** Purchases only (materials, subs, equipment, permits, subcontract labor…). */
  costs: CostBreakdown;
  /** Option A — burdened cost of in-house crew hours (approved time-entries ×
   *  effective cost rate), computed from Field Ops, NOT a purchase row. */
  fieldOpsLaborCents: number;
  /** Approved crew hours with no cost rate on file → they cost $0 here, so a
   *  value > 0 means labor cost (and margin) is understated until a rate is set. */
  laborUnratedHours: number;
  /** Purchases + field-ops labor = the deal's total cost. */
  totalCostCents: number;
  /** Contract − total costs = projected gross profit. Negative = over budget. */
  grossMarginCents: number;
  /** margin / contract, whole %, null when contract is 0 (no divide-by-zero). */
  grossMarginPct: number | null;
};

type InvRow = {
  status: string;
  total_cents: number;
  subtotal_cents: number;
  paid_cents: number;
  balance_cents: number;
};

export async function getProjectFinancials(oppId: string): Promise<ProjectFinancials> {
  const sb = commercialDb();
  const [base, netCo, costs, labor, invRes] = await Promise.all([
    getEffectiveContractBaseCents(oppId),
    netApprovedChangeOrderCents(oppId),
    costBreakdownForProject(oppId),
    fieldOpsLaborForOpp(oppId),
    sb
      .from("commercial_invoices")
      .select("status, total_cents, subtotal_cents, paid_cents, balance_cents")
      .eq("opportunity_id", oppId)
      .is("deleted_at", null),
  ]);

  const contractCents = base + netCo;
  const hasContract = contractCents > 0;

  let invoicedCents = 0;
  let billedPreTaxCents = 0;
  let collectedCents = 0;
  let openBalanceCents = 0;
  let creditCents = 0;
  for (const r of (invRes.data ?? []) as InvRow[]) {
    // Issued only — a draft isn't billed; a void doesn't count (mirrors the
    // account rollup + listProjects).
    if (r.status === "draft" || r.status === "void") continue;
    invoicedCents += Number(r.total_cents ?? 0);
    billedPreTaxCents += Number(r.subtotal_cents ?? 0);
    collectedCents += Number(r.paid_cents ?? 0);
    const bal = Number(r.balance_cents ?? 0);
    openBalanceCents += Math.max(0, bal);
    creditCents += Math.max(0, -bal);
  }

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
    costs,
    fieldOpsLaborCents,
    laborUnratedHours: labor.unratedHours,
    totalCostCents,
    grossMarginCents,
    grossMarginPct,
  };
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
export function marginFrom(
  billedCents: number,
  costCents: number
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
    caveat: null,
    provisional: false,
    overBudget: pct < -100,
  };
}

export function dealMargin(fin: {
  billedPreTaxCents: number;
  contractCents: number;
  hasContract: boolean;
  totalCostCents: number;
  laborUnratedHours: number;
}): DealMargin {
  const core = marginFrom(fin.billedPreTaxCents, fin.totalCostCents);
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

  const caveat =
    fin.laborUnratedHours > 0
      ? `Margin understated — ${fin.laborUnratedHours} crew hour${fin.laborUnratedHours === 1 ? "" : "s"} have no cost rate.`
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
