/**
 * Things missing on a job that someone should know about.
 *
 * Salesforce hard-stops on these — *"Payment Terms have not been added.
 * Complete prior to Approving and Syncing this Quote."* We deliberately don't
 * (`feedback_never_reject_only_warn`), and the reason is concrete rather than
 * stylistic: a GC verbally awards a job on Friday and the paperwork lands
 * Tuesday. A system that refuses to record the win until Tuesday produces a
 * wrong win date, which is the exact bug class removed earlier this month.
 *
 * So these inform and let you through. The trade is that informing is only
 * acceptable if it PERSISTS — a warning that can be dismissed and forgotten is
 * worse than no warning, because people learn the row is decorative. Each one
 * stays on the record until the underlying thing is actually fixed, and each
 * says what it blocks, not just what is absent.
 *
 * Pure — no I/O — so the rules are testable without a database.
 */

export type Attention = {
  key: string;
  /** What's missing, in the user's words. */
  title: string;
  /** What it actually affects. "Missing X" alone gives nobody a reason to act. */
  consequence: string;
  /** Where to go and fix it. */
  href?: string;
  tone: "warn" | "info";
};

export type AttentionInput = {
  oppId: string;
  status: string;
  subStatus: string | null;
  /** From the project row (migration 131). null = genuinely not set. */
  contractBaseCents: number | null | undefined;
  hasProject: boolean;
  followUpAt: string | null | undefined;
  proposalCount: number;
  sentProposalCount: number;
  hasWorkOrder: boolean;
  hasBilling: boolean;
  /** ET calendar dates. Drive the grace periods below. */
  decidedAt?: string | null;
  todayIso?: string;
};

/** Whole ET calendar days between two YYYY-MM-DD dates. */
function daysSince(fromIso: string | null | undefined, todayIso: string | undefined): number | null {
  if (!fromIso || !todayIso) return null;
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * How long a job gets before a missing thing counts as a problem.
 *
 * Karan 2026-08-12: without these, every won job wears a warning from the
 * moment it is awarded — a work order does not exist five minutes after a GC
 * says yes. A row that is always on is wallpaper, and wallpaper is what trains
 * people to ignore the row that actually costs money (the contract value).
 *
 * A job with no recorded win date gets NO grace: we cannot tell whether it was
 * won today or in March, and the safe reading of an unknown is to surface it.
 */
const GRACE_DAYS = { work_order: 7, contract_value: 3 } as const;

const WON_OR_DELIVERING = new Set([
  "pre_construction",
  "in_progress",
  "billing",
  "post_sale_closed",
]);

function isWonLike(status: string, sub: string | null): boolean {
  return (status === "pre_sale_closed" && sub === "won") || WON_OR_DELIVERING.has(status);
}

/**
 * The one manual step a person can take that no artifact implies.
 *
 * The CTA on the status path is an OVERRIDE, not the primary way to move.
 * Status advances on its own when a proposal is built, sent or won
 * (`auto-advance`, 2026-08-11); offering a "mark this complete" button at every
 * stage would hand a person a second way to fight the engine over the same
 * transition, and the engine would win on the next page load.
 *
 * So this returns a step only where the engine is structurally blind:
 *   - nothing has been quoted yet, so no artifact exists to imply anything
 *   - the customer said yes out loud, which leaves no trace to read
 *   - the job is won and someone has to decide the work has actually started
 */
export function manualNextStep(
  i: Pick<AttentionInput, "oppId" | "status" | "subStatus" | "proposalCount" | "sentProposalCount">
): { label: string; href: string } | null {
  const { status, subStatus, oppId } = i;
  if (status === "pre_sale_closed" && subStatus === "won") {
    return { label: "Start the job", href: `/commercial/opportunities/${oppId}?action=change-status` };
  }
  if (status === "pre_sale_closed") return null; // lost — nothing ahead
  if (WON_OR_DELIVERING.has(status)) return null; // the engine owns delivery
  if (i.proposalCount === 0) {
    return { label: "Build a proposal", href: `/commercial/opportunities/${oppId}?tab=proposals` };
  }
  if (i.sentProposalCount > 0) {
    // Sent and waiting. A verbal yes leaves nothing for the engine to read, so
    // this is the one pre-sale move that genuinely needs a person.
    return { label: "Mark won or lost", href: `/commercial/opportunities/${oppId}?action=change-status` };
  }
  return null;
}

export function attentionFor(i: AttentionInput): Attention[] {
  const out: Attention[] = [];
  const won = isWonLike(i.status, i.subStatus);
  const lost = i.status === "pre_sale_closed" && i.subStatus === "lost";
  // A lost deal has no work ahead of it; every item below is about delivering a
  // job. Warning about a missing work order on a job we didn't get is noise,
  // and noise is what teaches people to ignore the row.
  if (lost) return out;

  if (won && !i.hasProject) {
    out.push({
      key: "no_project",
      title: "This job has no project record",
      consequence:
        "Its invoices, change orders and costs have nothing to hang off. Changing the status again will create it.",
      tone: "warn",
    });
  }

  // The money one. NOT the same as zero — zero is a number someone chose.
  const wonDaysAgo = daysSince(i.decidedAt, i.todayIso);
  const past = (grace: number) => wonDaysAgo == null || wonDaysAgo >= grace;

  if (won && i.hasProject && (i.contractBaseCents == null || i.contractBaseCents <= 0) && past(GRACE_DAYS.contract_value)) {
    out.push({
      key: "no_contract_value",
      title: "Contract value isn't set",
      consequence:
        "Margin, amount left to bill and the AIA cover sheet have nothing to work from, and this job counts as $0 in every total until it is.",
      href: `/commercial/opportunities/${i.oppId}?tab=project&sub=aia`,
      tone: "warn",
    });
  }

  if (won && !i.hasWorkOrder && past(GRACE_DAYS.work_order)) {
    out.push({
      key: "no_work_order",
      title: "No work order yet",
      consequence: "The crew has nothing describing the scope, and nothing reaches the schedule.",
      href: `/commercial/opportunities/${i.oppId}?tab=project&sub=work-order`,
      tone: "warn",
    });
  }

  if (i.status === "billing" && !i.hasBilling) {
    out.push({
      key: "billing_nothing_billed",
      title: "This job is in Billing but nothing has been billed",
      consequence: "No invoice and no payment application exist, so none of it is showing up in AR.",
      href: `/commercial/opportunities/${i.oppId}?tab=invoices`,
      tone: "warn",
    });
  }

  // Pre-sale: a sent proposal with nothing scheduled after it is how bids go
  // quiet. Info, not warn — it is a nudge, not a defect.
  if (!won && i.sentProposalCount > 0 && !i.followUpAt) {
    out.push({
      key: "no_follow_up",
      title: "No follow-up scheduled",
      consequence: "A proposal is out with nothing booked to chase it.",
      href: `/commercial/opportunities/${i.oppId}?tab=overview&sub=info`,
      tone: "info",
    });
  }

  // A deal at Proposal with no proposal used to warn here. Removed 2026-08-12:
  // the auto-advance engine moves a deal to Proposal BECAUSE one was sent, so
  // the only way to reach this state is a manual drag — and the person who just
  // dragged it does not need telling what they did a second ago.

  return out;
}
