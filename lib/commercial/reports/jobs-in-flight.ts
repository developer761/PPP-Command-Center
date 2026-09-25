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

/** The flag order from `jobFlag`, as a rank. Lower sorts first. */
const FLAG_RANK: Record<string, number> = {
  "billed over contract": 0,
  "no work order": 1,
  "work order not sent": 2,
  "awaiting payment": 3,
  "nothing billed yet": 4,
};

/**
 * Flagged jobs first, WORST FLAG FIRST, then the least-billed.
 *
 * `jobFlag` above ranks the flags deliberately — "Ordered by what actually
 * costs something, most expensive first" — and that ordering decided which
 * flag a row shows. It did not reach the row ORDER, which sorted only on
 * "has a flag at all" and then on least-billed percent.
 *
 * So a 0%-billed job outranked every other flag by construction. On the live
 * dashboard all six rows read "nothing billed yet" — the LOWEST-priority flag
 * — on jobs worth $950, $1.5k, $3k, $3.1k, $16k and $40k, while AIREF
 * Building #1 sat off the list entirely with $113,129.18 awaiting payment.
 * Six trivia rows pushing out the largest collectable on the board, on the
 * page Alex opens every morning.
 *
 * Still NOT by contract size: a $2k job whose work order never went out is
 * blocking a crew this morning and a $200k job billed in full is not. Size
 * only breaks ties inside a flag, so the worst thing on the board comes first
 * and, among equally bad things, the one with the most money on it.
 */
export function rankJobsInFlight(rows: JobFlightInput[], limit = 6): JobInFlight[] {
  const withFlags = rows.map((r) => ({ ...r, flag: jobFlag(r) }));
  const pctBilled = (r: JobFlightInput) =>
    r.contractCents > 0 ? r.billedCents / r.contractCents : 1;
  return withFlags
    .sort((a, b) => {
      const flagged = Number(!!b.flag) - Number(!!a.flag);
      if (flagged !== 0) return flagged;
      // Worst flag first. Unknown flags sort after the known ones rather than
      // jumping the queue on a typo.
      const byFlag =
        (a.flag ? FLAG_RANK[a.flag] ?? 98 : 99) - (b.flag ? FLAG_RANK[b.flag] ?? 98 : 99);
      if (byFlag !== 0) return byFlag;
      // Inside one flag, the most money at stake. "Awaiting payment" means the
      // biggest unpaid bill; everywhere else the biggest contract.
      const atStake = (r: JobFlightInput) =>
        r.outstandingCents > 0 ? r.outstandingCents : r.contractCents;
      const byMoney = atStake(b) - atStake(a);
      if (byMoney !== 0) return byMoney;
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
