/**
 * The same payout, recorded once by a person here and once by the importer from
 * Salesforce — a day apart.
 *
 * WHY THIS EXISTS
 *
 * On 2026-10-14 Mary found duplicate labor payouts in the Command Center and
 * started deleting them. There were 35 pairs, $21,494.99 double-counted. The
 * day before, the Tomco reconciliation had been declared clean at "COST 1:1".
 *
 * Both statements were true, and that is the whole lesson. The reconciliation
 * sums only the rows carrying a `commercial_import_map` row, because its
 * question is "does what we imported still agree with Salesforce?". A duplicate
 * made of ONE mapped row and ONE unmapped row is invisible to it: the mapped
 * side still ties to the cent, so the check reports 1:1 while the job's own
 * cost page — which sums every live row — is over by the amount of the twin.
 *
 * Two surfaces, asked the same question, giving different answers, with the
 * arithmetic correct on both sides. Only a reader holding both at once can see
 * it, which is why it needs its own check rather than a sharper eye.
 *
 * THE TWO SIGNALS, and why ONE of them is not enough
 *
 * 1. PROXIMITY IN TIME. The pairs sat exactly one day apart — entered here on
 *    09-22 / 09-24 / 10-07, imported from Salesforce on 09-23 / 10-06 — because
 *    the two systems date the same payroll week differently. Matching on the
 *    exact day, which the earlier de-dupe scripts did, could not see any of them.
 *
 * 2. CROSS-PROVENANCE. One side mapped, one side not. This is what makes it a
 *    dual-run collision rather than a real second payment.
 *
 * Dropping the date window entirely and keying on (job, payee, amount) alone
 * reports 107 pairs and $83,531.51 against the same data. Almost all of it is
 * false: a sub on a fixed weekly rate earns the SAME amount every week, so four
 * $1,987.22 rows for Greg across four different weeks are four real paychecks.
 * The amount is worthless as an identity for money that repeats on purpose —
 * wages, retainers, fixed draws. The window is what separates a duplicate from
 * a paycheck, and it is load-bearing, not a refinement.
 *
 * Same-provenance pairs are reported SEPARATELY and never treated as findings.
 * Two Salesforce rows for $400 on the same job on the same day may be one
 * payout entered twice over there or two genuine ones, and no key can tell.
 * That is a question for a person.
 */

/** A money row from any of the tables this applies to. */
export type NearMissRow = {
  id: string;
  /** What the row hangs off — an opportunity, or an invoice's opportunity. */
  groupKey: string;
  /** Who was paid, or what was bought: vendor, worker, cheque payee. */
  payee: string | null;
  amountCents: number;
  /** When the money moved, NOT when the row was written. */
  occurredAt: string | null;
  /** True when a `commercial_import_map` row points at this id. */
  imported: boolean;
};

export type NearMissPair = {
  a: NearMissRow;
  b: NearMissRow;
  daysApart: number;
  /** One side imported from Salesforce and one entered here. */
  crossProvenance: boolean;
};

export type NearMissResult = {
  /** The dual-run collisions. These are findings. */
  cross: NearMissPair[];
  /** Ambiguous by construction — for a human, never for a script. */
  same: NearMissPair[];
  /** Double-counted cents across `cross` only. */
  crossCents: number;
  /** How many rows were examined, so a green result cannot mean "saw nothing". */
  scanned: number;
};

/**
 * Two days apart still catches a week dated Monday here and Tuesday there,
 * plus a weekend. Three was measured against the real pairs (max gap: 1 day)
 * and leaves room without reaching into the next week's payout.
 */
export const NEAR_MISS_WINDOW_DAYS = 3;

/**
 * The payee, reduced to the part two systems agree on.
 *
 * Lower-casing and trimming is not enough. A $2,400 labor payout survived the
 * 2026-10-14 cleanup of 35 duplicates because Salesforce holds the sub as
 * **"Peter-Profinish"** and the app as **"Peter - Profinish"** — the same person
 * in two spellings, so the two rows landed in different buckets and the pair was
 * invisible. The root cause is a duplicate *employee* record feeding two vendor
 * names, but the detector should not depend on that being tidy.
 *
 * Collapsing everything that is not a letter or a digit makes those identical.
 * Checked against the real book before adopting it: cross-provenance pairs went
 * from 3 to 4 and the fourth is genuine, so it costs nothing in false positives.
 *
 * It does NOT merge different payees — "Home Depot" and "HomeDepot2" stay
 * distinct, and the amount plus the date window still have to agree.
 */
function normalisePayee(payee: string | null): string {
  return (payee ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb) / 86_400_000;
}

/**
 * Pairs of rows that are the same money recorded twice.
 *
 * Greedy and first-fit on purpose: three rows at one amount within the window
 * yield one pair and one leftover, not three pairs. Over-reporting a triple as
 * three duplicates would overstate the money at stake, and the leftover still
 * shows up on the next run once the pair is resolved.
 */
export function findNearMissDuplicates(
  rows: NearMissRow[],
  { windowDays = NEAR_MISS_WINDOW_DAYS }: { windowDays?: number } = {},
): NearMissResult {
  const buckets = new Map<string, NearMissRow[]>();
  for (const r of rows) {
    const k = `${r.groupKey}|${normalisePayee(r.payee)}|${r.amountCents}`;
    const bucket = buckets.get(k);
    if (bucket) bucket.push(r);
    else buckets.set(k, [r]);
  }

  const cross: NearMissPair[] = [];
  const same: NearMissPair[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // Stable order so the same pair is reported the same way every run.
    const ordered = [...bucket].sort(
      (x, y) =>
        String(x.occurredAt ?? "").localeCompare(String(y.occurredAt ?? "")) ||
        x.id.localeCompare(y.id),
    );
    const used = new Set<number>();
    for (let i = 0; i < ordered.length; i += 1) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < ordered.length; j += 1) {
        if (used.has(j)) continue;
        const gap = daysBetween(ordered[i].occurredAt, ordered[j].occurredAt);
        if (gap === null || gap > windowDays) continue;
        used.add(i);
        used.add(j);
        const crossProvenance = ordered[i].imported !== ordered[j].imported;
        const pair: NearMissPair = {
          a: ordered[i],
          b: ordered[j],
          daysApart: gap,
          crossProvenance,
        };
        (crossProvenance ? cross : same).push(pair);
        break;
      }
    }
  }

  return {
    cross,
    same,
    crossCents: cross.reduce((n, p) => n + Math.abs(p.a.amountCents), 0),
    scanned: rows.length,
  };
}

/**
 * Which row of a confirmed pair to remove.
 *
 * ALWAYS the unmapped one. The imported row carries the `commercial_import_map`
 * row that ties the two systems together; Mary deleted six of those by hand and
 * took COST reconciliation from 1:1 to four jobs short by $3,638.80. Deleting
 * the copy that was entered here removes the double-count and moves the
 * reconciliation by exactly $0.
 */
export function rowToRemove(pair: NearMissPair): NearMissRow | null {
  if (!pair.crossProvenance) return null;
  return pair.a.imported ? pair.b : pair.a;
}
