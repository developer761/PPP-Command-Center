/**
 * Split one employee's payroll cost across the jobs they worked.
 *
 * Katie, 2026-09-24, describing what Mary does by hand every week:
 *
 *   "Mary takes the actual company liability which is their payroll + payroll
 *    taxes (ex: JJ gets paid 500 but gusto actually takes out $520 from the
 *    bank, $20 is the payroll tax). Mary looks at the attendance report with
 *    the % split and calculates how much of their weekly payroll is attributed
 *    to each job based on the hours they worked there.
 *
 *    Ex: Job 1 is 20 hours and Job 2 is 10 hours and Job 3 is 10 hours
 *    She would calculate 520 * 50%, 520 * 25% and 520 * 25%
 *
 *    The calculated value is the Payout for that work for that job."
 *
 * That last sentence is the whole design. The output is a PAYOUT — the same
 * record the platform already keeps for every sub — so nothing downstream has
 * to change: job costs, the Labor payments view, the P&L and the Salesforce
 * reconcile all read it already. What changes is that the number is computed
 * instead of typed.
 *
 * WHY THIS IS NOT A RATE CARD. The figure being split is what Gusto actually
 * took out of the bank, so the burden is already inside it. There is no
 * hourly rate to maintain, nothing to keep in step with a raise, and no
 * base-wage-versus-true-cost question to get wrong.
 *
 * ── THE PENNY ───────────────────────────────────────────────────────────────
 *
 * Percentages do not divide evenly. $520 across three equal jobs is $173.33
 * three times, which is $519.99 — a cent of payroll that left the bank and
 * landed on no job. Over a year of weekly runs that is a slow, unexplainable
 * drift between the ledger and the bank.
 *
 * So the split uses largest-remainder: every job gets the floor of its share,
 * and the leftover pennies go one each to the jobs with the biggest fractional
 * part. The result ALWAYS sums to the liability exactly, and the cent lands on
 * the job with the strongest claim to it rather than the first one in the list.
 */

export type JobHours = {
  /** Opportunity id — what a payout is filed against. */
  opportunityId: string;
  /** Hours this employee worked on this job in the period. */
  hours: number;
};

export type JobAllocation = JobHours & {
  amountCents: number;
  /** Share of the period's hours, for the row Mary reads back. */
  pct: number;
};

/**
 * Split `liabilityCents` across `jobs` in proportion to hours.
 *
 * Returns an empty list when there are no hours — a week where somebody was
 * paid but worked no job (all PTO, say) has nothing to attribute, and
 * inventing a job for it would be worse than leaving it for a person.
 */
export function allocatePayrollToJobs(
  liabilityCents: number,
  jobs: JobHours[],
): JobAllocation[] {
  const cents = Math.round(liabilityCents);
  const live = jobs.filter((j) => Number(j.hours) > 0);
  const totalHours = live.reduce((n, j) => n + Number(j.hours), 0);
  if (cents <= 0 || live.length === 0 || totalHours <= 0) return [];

  // Floor each share, then hand the remaining pennies to the largest remainders.
  const exact = live.map((j) => (cents * Number(j.hours)) / totalHours);
  const floors = exact.map((x) => Math.floor(x));
  let left = cents - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = live.map((j, i) => ({
    opportunityId: j.opportunityId,
    hours: Number(j.hours),
    amountCents: floors[i],
    pct: (Number(j.hours) / totalHours) * 100,
  }));
  for (const { i } of order) {
    if (left <= 0) break;
    out[i].amountCents += 1;
    left -= 1;
  }
  return out;
}

/** Does a split account for every cent? The invariant, stated so a caller can
 *  assert it rather than trust it. */
export function allocationSumsTo(
  allocations: JobAllocation[],
  liabilityCents: number,
): boolean {
  return (
    allocations.reduce((n, a) => n + a.amountCents, 0) === Math.round(liabilityCents)
  );
}
