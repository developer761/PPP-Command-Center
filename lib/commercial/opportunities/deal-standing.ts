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

import { formatCentsCompact } from "@/lib/commercial/invoices/format";

/**
 * Compact money, for the figures on this block.
 *
 * NOT written here. `formatCentsCompact` has existed since Phase 3 and is
 * strictly better than the local money() this module used to carry: it guards
 * NaN, has M and B tiers, and puts the minus sign before the $ — the local one
 * rendered a negative as "$-5k". Re-exported so the two components reading it
 * don't have to know where it lives.
 */
export { formatCentsCompact as money };


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
  /**
   * The newest proposal revision's status, or null when none exists yet.
   *
   * Brendan 2026-08-26 listed "proposal send" alongside the money as the facts
   * he wanted at a glance — and the block used to return NOTHING at all until
   * the job was won, which is exactly the stretch where the only thing worth
   * saying is where the proposal has got to.
   */
  proposalStatus?: string | null;
};

export type StandingLine = {
  label: string;
  value: string;
  /** 'warn' earns amber — something is waiting on us. */
  tone: "plain" | "warn";
};



/** Percent of the contract billed, or null when there is no contract to compare
 *  against — a brand-new job must not read as "0% billed" when the number it
 *  would be billing against does not exist yet. */
export function billedPct(i: Pick<DealStandingInput, "billedCents" | "contractCents">): number | null {
  if (i.contractCents <= 0) return null;
  return Math.round((i.billedCents / i.contractCents) * 100);
}

/** How a proposal's raw status reads to a person, and whether we are the holdup. */
function proposalLine(status: string | null | undefined): StandingLine | null {
  if (status == null) {
    // Plain, not warn. Without the deal's stage there is no way to tell a
    // brand-new lead (where no proposal is perfectly normal) from a job sat in
    // Estimating with nothing written. Amber on every fresh opportunity would
    // be exactly the pipeline noise the delivery lines are held back to avoid.
    return { label: "Proposal", value: "Not started", tone: "plain" };
  }
  switch (status) {
    case "draft":
      return { label: "Proposal", value: "Draft — not sent", tone: "warn" };
    case "pending_approval":
      return { label: "Proposal", value: "Waiting on an approver", tone: "warn" };
    case "approved":
      // Approved but still sitting here is the one people miss: the work is
      // done and nobody has pressed send.
      return { label: "Proposal", value: "Approved, not sent", tone: "warn" };
    case "sent":
      return { label: "Proposal", value: "With the GC", tone: "plain" };
    case "won":
      return { label: "Proposal", value: "Won", tone: "plain" };
    case "lost":
      return { label: "Proposal", value: "Lost", tone: "plain" };
    default:
      return null;
  }
}

export function dealStandingLines(i: DealStandingInput): StandingLine[] {
  const out: StandingLine[] = [];

  // Before the win there is no contract, so the money lines below have nothing
  // to say. The proposal does.
  if (!i.isWon) {
    const p = proposalLine(i.proposalStatus);
    return p ? [p] : [];
  }

  // The work order first: it is the one that blocks people rather than money.
  if (i.workOrderSent === null) {
    out.push({ label: "Work order", value: "Not written", tone: "warn" });
  } else if (i.workOrderSent === false) {
    out.push({ label: "Work order", value: "Written, not sent", tone: "warn" });
  } else {
    out.push({ label: "Work order", value: "Sent to the crew", tone: "plain" });
  }

  if (i.outstandingCents > 0) {
    out.push({ label: "GC owes", value: formatCentsCompact(i.outstandingCents), tone: "warn" });
  }

  if (i.retainageCents > 0) {
    // Not "owed" — it is held by agreement. Shown because it is the money that
    // gets forgotten at close-out.
    out.push({ label: "Retainage held", value: formatCentsCompact(i.retainageCents), tone: "plain" });
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
    out.push({ label: "Left to bill", value: formatCentsCompact(left), tone: "plain" });
  } else if (i.contractCents > 0 && left < 0) {
    out.push({ label: "Billed over contract", value: formatCentsCompact(-left), tone: "warn" });
  }

  return out;
}
