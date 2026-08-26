/**
 * Turn project rows into the per-job lines shown under the Overview totals.
 *
 * Brendan 2026-08-26: "under 'this month' it should say things specific to the
 * deals — this one is billed 5k out of 25k, the work order hasn't been sent."
 *
 * Pure so the ordering and the flag choice can be tested. Which fact gets
 * surfaced is the whole value of the strip: one line per job, so picking the
 * wrong fact means the row is wasted.
 */

export type JobFlightInput = {
  oppId: string;
  name: string;
  accountName: string;
  billedCents: number;
  contractCents: number;
  /** No live work order exists on this job at all. */
  workOrderMissing: boolean;
  /** A work order exists but has never gone to the crew. */
  workOrderUnsent: boolean;
  /** GC owes money on issued invoices. */
  outstandingCents: number;
  /** Billed beyond the contract sum. */
  overBilledCents: number;
};

export type JobInFlight = {
  oppId: string;
  name: string;
  accountName: string;
  billedCents: number;
  contractCents: number;
  flag: string | null;
};

/**
 * The one thing worth saying about this job.
 *
 * Ordered by what actually costs something, most expensive first: money billed
 * that shouldn't have been, then a crew that can't start, then money owed, then
 * work earned and not yet invoiced. A job with nothing outstanding says nothing
 * — a flag on every row is wallpaper, and wallpaper is what trains people to
 * stop reading the row that matters.
 */
export function jobFlag(j: JobFlightInput): string | null {
  if (j.overBilledCents > 0) return "billed over contract";
  if (j.workOrderMissing) return "no work order";
  if (j.workOrderUnsent) return "work order not sent";
  if (j.outstandingCents > 0) return "awaiting payment";
  const leftToBill = j.contractCents - j.billedCents;
  if (j.contractCents > 0 && leftToBill > 0 && j.billedCents === 0) return "nothing billed yet";
  return null;
}

/**
 * Flagged jobs first, then the least-billed — the ones with the most still to
 * come. NOT by contract size: a $2k job whose work order never went out is
 * blocking a crew this morning, and a $200k job billed in full is not.
 */
export function rankJobsInFlight(rows: JobFlightInput[], limit = 6): JobInFlight[] {
  const withFlags = rows.map((r) => ({ ...r, flag: jobFlag(r) }));
  const pctBilled = (r: JobFlightInput) =>
    r.contractCents > 0 ? r.billedCents / r.contractCents : 1;
  return withFlags
    .sort((a, b) => {
      const flagged = Number(!!b.flag) - Number(!!a.flag);
      if (flagged !== 0) return flagged;
      const byProgress = pctBilled(a) - pctBilled(b);
      if (byProgress !== 0) return byProgress;
      // Deterministic tail so the strip doesn't reshuffle between loads.
      return a.oppId.localeCompare(b.oppId);
    })
    .slice(0, limit)
    .map((r) => ({
      oppId: r.oppId,
      name: r.name,
      accountName: r.accountName,
      billedCents: r.billedCents,
      contractCents: r.contractCents,
      flag: r.flag,
    }));
}
