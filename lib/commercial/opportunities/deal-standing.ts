/**
 * "Where this job stands" — the deal-specific facts on the Activity rail.
 *
 * Brendan 2026-08-26: "under 'this month' it should say things specific to the
 * deal — like this one is billed 5k out of 25k, or the work order hasn't been
 * sent."
 *
 * The rail above this is a chronology: what happened, in the order it happened.
 * It is genuinely useful and it answers the wrong question. Reading "Proposal
 * R2 sent · Closed → Pre-Construction" tells you the history and leaves you to
 * work out the present state yourself — how much of the contract is billed,
 * whether the crew has its scope, whether the GC owes us. Those are the facts
 * somebody opens a job to check, and they were not on the page at all.
 *
 * Pure, so the choice of what to show can be tested. Selection matters more
 * than formatting here: a block that prints a line for everything is a wall
 * nobody reads, and one that stays silent on an unsent work order costs a crew
 * a morning.
 */

export type DealStandingInput = {
  /** Pre-tax billed against the contract. */
  billedCents: number;
  /** Contract to date — base plus approved change orders. */
  contractCents: number;
  /** Invoiced minus collected: what the GC still owes. */
  outstandingCents: number;
  /** Retainage held on the latest payment application. */
  retainageCents: number;
  /** null = no live work order; false = exists, never sent; true = sent. */
  workOrderSent: boolean | null;
  /** Approved change orders not yet reflected in a billing. */
  pendingCoCount: number;
  /** Is this a won / in-delivery job? Pre-sale bids have no contract yet. */
  isWon: boolean;
};

export type StandingLine = {
  label: string;
  value: string;
  /** 'warn' earns amber — something is waiting on us. */
  tone: "plain" | "warn";
};

export function money(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1000) {
    // Round FIRST, then decide whether a decimal is worth printing. Testing
    // `k % 1 === 0` on the raw value printed "$5.0k" for $5,004 — the trailing
    // ".0" says "we measured to a tenth" about a number that rounds clean.
    const oneDp = (d / 1000).toFixed(1);
    return `$${oneDp.endsWith(".0") ? oneDp.slice(0, -2) : oneDp}k`;
  }
  return `$${Math.round(d).toLocaleString("en-US")}`;
}

/** Percent of the contract billed, or null when there is no contract to compare
 *  against — a brand-new job must not read as "0% billed" when the number it
 *  would be billing against does not exist yet. */
export function billedPct(i: Pick<DealStandingInput, "billedCents" | "contractCents">): number | null {
  if (i.contractCents <= 0) return null;
  return Math.round((i.billedCents / i.contractCents) * 100);
}

export function dealStandingLines(i: DealStandingInput): StandingLine[] {
  const out: StandingLine[] = [];
  if (!i.isWon) return out;

  // The work order first: it is the one that blocks people rather than money.
  if (i.workOrderSent === null) {
    out.push({ label: "Work order", value: "Not written", tone: "warn" });
  } else if (i.workOrderSent === false) {
    out.push({ label: "Work order", value: "Written, not sent", tone: "warn" });
  } else {
    out.push({ label: "Work order", value: "Sent to the crew", tone: "plain" });
  }

  if (i.outstandingCents > 0) {
    out.push({ label: "GC owes", value: money(i.outstandingCents), tone: "warn" });
  }

  if (i.retainageCents > 0) {
    // Not "owed" — it is held by agreement. Shown because it is the money that
    // gets forgotten at close-out.
    out.push({ label: "Retainage held", value: money(i.retainageCents), tone: "plain" });
  }

  if (i.pendingCoCount > 0) {
    out.push({
      label: "Change orders",
      value: `${i.pendingCoCount} awaiting a decision`,
      tone: "warn",
    });
  }

  const left = i.contractCents - i.billedCents;
  if (i.contractCents > 0 && left > 0) {
    out.push({ label: "Left to bill", value: money(left), tone: "plain" });
  } else if (i.contractCents > 0 && left < 0) {
    out.push({ label: "Billed over contract", value: money(-left), tone: "warn" });
  }

  return out;
}
