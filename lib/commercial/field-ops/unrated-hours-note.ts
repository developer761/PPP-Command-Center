/**
 * What to say about crew hours that carry no cost yet — in ONE place.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Nine surfaces said a version of "Nh have no cost rate set. Set rates on the
 * Crew page." That was right while Tomco's crew were subcontractors priced
 * from a rate card. It became actively harmful the day they went W-2.
 *
 * A W-2 employee here has NO cost rate ON PURPOSE. Their cost is the company's
 * real Gusto liability — wages plus payroll taxes — split across the jobs they
 * worked when Mary posts the week in Accounting → Payroll. Setting a rate as
 * well would price the same hours twice: once from the rate card and again
 * from the payout. That is the exact double-count the payroll build spent the
 * day preventing, and nine screens were telling Brendan and Alex to go and
 * cause it.
 *
 * So the advice now points at the thing that actually supplies the cost. The
 * hours are not misconfigured — they are simply waiting for payroll.
 *
 * ── AND WHY IT TAKES COVERAGE, NOT AN HOUR COUNT (2026-10-16) ──────────────
 *
 * "Waiting for payroll" was then asserted of every unrated hour on the book,
 * which was false on 99.7% of them. Measured against production on 2026-10-16:
 * 14,637 hours read unrated across 81 deals, and 14,589 of them — on 79 of the
 * 81 — already carried `labor` / `employee_labor` purchases naming the same
 * nine people, $510,469.42 of them. LMJ Cipla read "Margin reads high — 1063
 * of the crew hours on this job are not costed yet" while carrying $37,416.22
 * of labor for exactly those people. Greg: 250 unrated hours against
 * $12,295.01 booked, $49.18/h. The hours ARE costed. Only 2 deals / 48h were
 * genuinely uncosted.
 *
 * That sentence does not merely mislead, it recommends the harm: the reader's
 * response to "this is not costed yet" is to go and cost it, which is the
 * double-charge. So the hour count alone is no longer accepted. A caller must
 * hand over what it found out about payouts, and the hours it names are the
 * ones NO payout covers.
 */

/**
 * The evidence that decides whether the sentence is true.
 *
 * Build it with `unratedCoverageFrom` (name-matched, per person) or
 * `uncostedHoursByOpp` (deal-level, for aggregate surfaces) in
 * `lib/commercial/projects/financials.ts` — both reuse `findDoubleCounted`'s
 * matching rules rather than re-deciding what "the same person" means.
 */
export type UnratedPayoutCoverage = {
  /** Unrated crew hours that NO labor payout on the job covers. The only
   *  hours of which "not costed yet" is a true statement. */
  uncostedHours: number;
  /** Σ labor already paid out on the job to the people whose hours read
   *  unrated. Carried so a surface can say "already paid" rather than go
   *  silent. */
  coveredByPayoutCents: number;
};

/** Nothing is covered — every unrated hour really is waiting on payroll. Use
 *  ONLY where the payouts have actually been checked and there are none. */
export function noPayoutCoverage(unratedHours: number): UnratedPayoutCoverage {
  return { uncostedHours: unratedHours > 0 ? unratedHours : 0, coveredByPayoutCents: 0 };
}

/** Where the cost for these hours actually comes from. */
export const PAYROLL_HREF = "/commercial/accounting?view=payroll";

const fmtHours = (hours: number): string =>
  Number(hours).toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * One sentence, for a banner or a caption — or null when there is nothing
 * honest to say.
 *
 * Null covers both "no unrated hours" and the far commoner "the unrated hours
 * are already paid for". A caller cannot render an empty warning, and cannot
 * render a false one either.
 */
export function unratedHoursNote(coverage: UnratedPayoutCoverage): string | null {
  if (!(coverage.uncostedHours > 0)) return null;
  return `${fmtHours(coverage.uncostedHours)}h of crew time has no cost against it yet, so margin reads high. It gets its cost when that week is posted in Payroll.`;
}

/** The short form, for a KPI sub-label where there is no room for a sentence. */
export function unratedHoursShort(coverage: UnratedPayoutCoverage): string | null {
  if (!(coverage.uncostedHours > 0)) return null;
  return `${fmtHours(coverage.uncostedHours)}h not costed yet — waiting on payroll`;
}
