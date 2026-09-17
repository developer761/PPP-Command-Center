/**
 * "Are we making money?" — the whole company, one set of figures.
 *
 * Karan 2026-09-17, on what the recurring report to Alex should carry: the AR
 * sheet, and an overview like "Are we making money?" — net profit, margin,
 * gross revenue, job costs.
 *
 * THIS EXISTS SO THERE IS ONE ANSWER. The dashboard already derived these four
 * inline, and the honest way to add them to an email was not to copy that
 * arithmetic into the email. Two places computing "margin" is how the platform
 * ends up telling Alex 62% on screen and 58% in his inbox on the same morning,
 * and this repo has already been through that once with the Win/Loss report —
 * three separate comments in `win-loss/reports.ts` are about surfaces that
 * drifted apart on what counted as a win.
 *
 * Pure: it takes the rows the caller has already loaded and does the sums, so
 * the rules are testable without a database and there is no second query to
 * fall out of step.
 */

export type PnlInputs = {
  /** Every project row in scope — the WHOLE portfolio, closed jobs included. */
  projects: { billedContractCents: number; fieldOpsLaborCents: number; laborUnratedHours: number }[];
  /** Σ of every purchase, from the cost breakdown. Crew labor is NOT in here. */
  purchaseCostCents: number;
};

export type CompanyPnl = {
  /** Pre-tax billed, lifetime. The top line. */
  grossRevenueCents: number;
  /** Purchases + crew labor. */
  totalCostCents: number;
  /** The crew half of the cost, worth showing because it is computed, not paid. */
  crewLaborCents: number;
  netProfitCents: number;
  /** Null when nothing has been billed — a margin on zero revenue is not 0%,
   *  it is a question nobody has asked yet. */
  marginPct: number | null;
  /** Hours logged against no cost rate. They understate cost, so they overstate
   *  every figure above — surfaced rather than silently folded in. */
  unratedHours: number;
};

export function companyPnl({ projects, purchaseCostCents }: PnlInputs): CompanyPnl {
  // Each project row already carries its own labor, so summing the rows keeps
  // the portfolio total identical to Σ per-deal P&L (deal ⊂ portfolio).
  const crewLaborCents = projects.reduce((n, p) => n + p.fieldOpsLaborCents, 0);
  const grossRevenueCents = projects.reduce((n, p) => n + p.billedContractCents, 0);
  const totalCostCents = purchaseCostCents + crewLaborCents;
  const netProfitCents = grossRevenueCents - totalCostCents;
  return {
    grossRevenueCents,
    totalCostCents,
    crewLaborCents,
    netProfitCents,
    marginPct: grossRevenueCents > 0 ? Math.round((netProfitCents / grossRevenueCents) * 100) : null,
    unratedHours: projects.reduce((n, p) => n + p.laborUnratedHours, 0),
  };
}

/** The word Alex reads instead of squinting at the number. */
export function marginVerdict(marginPct: number | null): string {
  if (marginPct === null) return "no revenue yet";
  if (marginPct < 0) return "losing money";
  if (marginPct < 15) return "thin";
  return "healthy";
}
