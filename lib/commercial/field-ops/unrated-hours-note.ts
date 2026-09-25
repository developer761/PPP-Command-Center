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
 */

/** Where the cost for these hours actually comes from. */
export const PAYROLL_HREF = "/commercial/accounting?view=payroll";

/**
 * One sentence, for a banner or a caption.
 *
 * `hours` is the unrated total. Callers already know it is > 0; this does not
 * guess, and returns null for zero so a caller cannot render an empty warning.
 */
export function unratedHoursNote(hours: number): string | null {
  if (!(hours > 0)) return null;
  const h = Number(hours).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${h}h of crew time has no cost against it yet, so margin reads high. It gets its cost when that week is posted in Payroll.`;
}

/** The short form, for a KPI sub-label where there is no room for a sentence. */
export function unratedHoursShort(hours: number): string | null {
  if (!(hours > 0)) return null;
  const h = Number(hours).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${h}h not costed yet — waiting on payroll`;
}
