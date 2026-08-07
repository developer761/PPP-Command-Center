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
