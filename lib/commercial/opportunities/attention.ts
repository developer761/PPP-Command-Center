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

import { columnKeyForOpp } from "./kanban-columns";

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
  /** Signed off internally but not yet in front of the GC. */
  approvedNotSentCount?: number;
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
export type NextStep = {
  /** The ACTION, in the words of the thing you are about to do. */
  label: string;
  /** Where that action actually happens. */
  href: string;
  /** One line of why, for the places that have room. */
  why?: string;
};

/**
 * The one thing to do next on this job.
 *
 * Karan 2026-08-12: *"there is like a Start Project button when an opp is won
 * which is great, we need more of that so people know what to do / where to go
 * easily for their next step"* — and then, precisely: *"it should be like 'mark
 * it as approved' and then it brings you to the proposal for mark as approved."*
 *
 * Two rules follow from that, and they are what make this different from a
 * status dropdown:
 *
 *  1. It names the ACTION, not the state. "Mark it approved", not "Move to
 *     Pending Approval". Nobody thinks in states; they think in the next thing
 *     on their list.
 *  2. It goes WHERE THE ACTION HAPPENS. Approving lives on the proposal, so the
 *     button opens the proposal. A button that sets a field without taking you
 *     to the work leaves you to find the work yourself.
 *
 * It reads the PROPOSAL, not just the deal — which is the whole reason it can
 * say "mark it approved" at all. And it stays quiet where the engine already
 * acts: building a proposal moves the deal on its own, so there is no button
 * for it.
 */
export function nextStep(
  i: Pick<
    AttentionInput,
    "oppId" | "status" | "subStatus" | "proposalCount" | "sentProposalCount" | "approvedNotSentCount"
  > & {
    /** Latest proposal's id + status, so the button can point AT it. */
    proposal?: { id: string; status: string } | null;
    accountId?: string | null;
  }
): NextStep | null {
  const { status, subStatus, oppId } = i;
  const p = i.proposal ?? null;
  const proposalHref =
    p && i.accountId
      ? `/commercial/accounts/${i.accountId}/deals/${oppId}/proposal/${p.id}?back=${encodeURIComponent(`/commercial/opportunities/${oppId}?tab=proposals`)}`
      : `/commercial/opportunities/${oppId}?tab=proposals`;

  // ── Delivery ────────────────────────────────────────────────────────────
  if (status === "pre_sale_closed" && subStatus === "won") {
    return {
      label: "Start the job",
      // `?to=` is the param the page actually reads. It was `?action=change-status`,
      // which NOTHING handles — the button navigated and the page looked
      // unchanged, so it read as broken because it was. The anchor lands you on
      // the card, and `to` pre-picks the one sensible next stage.
      href: `/commercial/opportunities/${oppId}?tab=info&to=pre_construction#change-status`,
      why: "Move it into pre-construction so the crew can be scheduled.",
    };
  }
  if (status === "pre_construction") {
    return {
      label: "Write the work order",
      href: `/commercial/opportunities/${oppId}?tab=project&sub=work-order`,
      why: "The crew needs the scope before they mobilise.",
    };
  }
  if (status === "in_progress") {
    return {
      label: "Bill the work",
      href: `/commercial/opportunities/${oppId}?tab=invoices`,
      why: "Invoice what's complete so far.",
    };
  }
  if (status === "billing") {
    return {
      label: "Close it out",
      href: `/commercial/opportunities/${oppId}?tab=project&sub=closeout`,
      why: "Warranty, O&M and waivers.",
    };
  }
  if (status === "post_sale_closed") return null;
  if (status === "pre_sale_closed") return null; // lost — nothing ahead

  // ── Pre-sale ────────────────────────────────────────────────────────────
  //
  // AUDIT 2026-08-12 (Karan: "if I manually move a status back and forth this
  // button stays there, which is misleading"). These branches read ONLY the
  // proposal, so a deal a person had dragged to Sent still said "Send it for
  // approval" because the proposal was never taken out of draft. The one
  // instruction on screen contradicted the stage printed directly above it.
  //
  // The deal and its proposal are two clocks, and they legitimately disagree:
  // `proposalTrailsDeal` exists precisely because a deal stays ahead of a
  // proposal that was revised, and the platform is forward-only everywhere
  // else. So take whichever is FURTHER ALONG. A person who moved the deal to
  // Sent meant it; the draft proposal is the lagging artifact, not the truth.
  const DEAL_STAGE_ORDER = ["qualifying", "rfp", "estimating", "pending_approval", "sent"];
  const PROPOSAL_IMPLIES: Record<string, string> = {
    draft: "estimating",
    pending_approval: "pending_approval",
    approved: "pending_approval",
    sent: "sent",
  };
  const rankOf = (k: string) => DEAL_STAGE_ORDER.indexOf(k);
  const dealStage = columnKeyForOpp(status, subStatus ?? null);
  const proposalStage =
    (p?.status ? PROPOSAL_IMPLIES[p.status] : undefined) ??
    (i.sentProposalCount > 0 ? "sent" : (i.approvedNotSentCount ?? 0) > 0 ? "pending_approval" : undefined);
  const here =
    proposalStage && rankOf(proposalStage) > rankOf(dealStage) ? proposalStage : dealStage;

  // Out with the GC — the only thing left is the answer. Checked first because
  // it is the state a manual move most often lands on, and the state where a
  // proposal-driven label was most wrong.
  if (here === "sent") {
    return {
      label: "Mark won or lost",
      // No `to=` here on purpose: won vs lost is the user's answer to give, and
      // pre-picking either one is how a mis-click books a loss as a win.
      href: `/commercial/opportunities/${oppId}?tab=info#change-status`,
      why: "It's with them — record the answer when it comes.",
    };
  }

  if (i.proposalCount === 0) {
    return {
      label: "Build a proposal",
      href: `/commercial/opportunities/${oppId}?tab=proposals`,
      why: "Nothing is priced yet.",
    };
  }

  // Approved and sitting here is its own step, and it outranks the stage:
  // the deal being parked at Pending Approval doesn't change the fact that a
  // signed-off proposal hasn't gone out.
  if (p?.status === "approved" || (i.approvedNotSentCount ?? 0) > 0) {
    return {
      label: "Send it to the GC",
      href: proposalHref,
      why: "Approved and still sitting here — they can't answer what they don't have.",
    };
  }

  if (here === "pending_approval" || p?.status === "pending_approval") {
    return {
      label: "Mark it approved",
      href: proposalHref,
      why: "Waiting on internal sign-off before it can go out.",
    };
  }

  if (p?.status === "draft") {
    return {
      label: "Send it for approval",
      href: proposalHref,
      why: "It's priced — get it signed off internally.",
    };
  }

  return null;
}

/** @deprecated Use `nextStep`, which names the action and points at it. Kept
 *  so the path bar's CTA keeps its shape until every caller has moved. */
export function manualNextStep(
  i: Pick<AttentionInput, "oppId" | "status" | "subStatus" | "proposalCount" | "sentProposalCount" | "approvedNotSentCount">
): { label: string; href: string } | null {
  const s = nextStep(i);
  return s ? { label: s.label, href: s.href } : null;
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

  // ── Approved, and still sitting here ────────────────────────────────────
  //
  // Karan 2026-08-12: "I approved the proposal and it didn't close status and
  // ask me closed won or lost." Approval is INTERNAL — Brendan signing off
  // before it goes out — so it correctly closes nothing. What was missing is
  // the step in between: nobody told you it was ready to send. An approved
  // proposal that never goes out is the most expensive kind of stall, because
  // every hour of pricing is already spent.
  //
  // AUDIT 2026-08-12, same class as the next-step button: these two rules read
  // only the PROPOSAL, so they disagreed with a deal a person had moved by
  // hand. `dealIsOut` is the deal's own claim that the GC has it.
  const dealIsOut = columnKeyForOpp(i.status, i.subStatus ?? null) === "sent";

  // Suppressed once the deal says Sent. Somebody moved it there deliberately —
  // a GC often gets the PDF by email or in person before anyone updates the
  // proposal record — and a warning insisting "the GC hasn't seen it yet" over
  // the top of their own stage change is exactly the contradiction Karan
  // flagged. The warning is for a proposal nobody has acted on, not for
  // bookkeeping that lags reality.
  if (!won && !dealIsOut && (i.approvedNotSentCount ?? 0) > 0) {
    out.push({
      key: "approved_not_sent",
      title: "Approved and not sent",
      consequence: "The GC hasn't seen it yet, so nothing can come back — won or lost.",
      href: `/commercial/opportunities/${i.oppId}?tab=proposals`,
      tone: "warn",
    });
  }

  // Pre-sale: a sent proposal with nothing scheduled after it is how bids go
  // quiet. Info, not warn — it is a nudge, not a defect.
  // The mirror image, and it was a FALSE NEGATIVE: a deal moved to Sent by
  // hand, with the proposal record never marked sent, had no follow-up nudge
  // at all — the bid most likely to be forgotten was the one the platform said
  // nothing about.
  if (!won && (i.sentProposalCount > 0 || dealIsOut) && !i.followUpAt) {
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

/**
 * The status moves a PERSON actually needs to make.
 *
 * Karan 2026-08-12: "shouldnt the opportunity move forward on its own?" — it
 * does. The picker predates the auto-advance engine, back when a human drove
 * every transition, so it offered all eight statuses and needed a banner
 * warning that half of them were "valid but unusual". A control that has to
 * apologise for its own options is offering the wrong options.
 *
 * The engine owns every move an artifact implies: building a proposal moves a
 * deal to Estimating, sending it moves it to Proposal, marking it won closes
 * it. What it cannot see is anything that happens off-system — a GC saying yes
 * on the phone, a decision not to bid, a crew actually arriving on site.
 *
 * So this returns the short list of moves with no artifact behind them. The
 * full set stays available behind a disclosure for the rare correction, which
 * is where the "unusual" warning belongs — on the exception, not the default.
 */
export function sensibleNextStatuses(status: string, sub: string | null): string[] {
  switch (status) {
    case "qualifying":
      // Qualifying -> RFP is a real human move: a bid package landing is an
      // email, not something the system sees. Brendan 2026-08-12: "The first
      // stage in an opp should be RFP."
      //
      // AUDIT 2026-08-12: this returned "qualifying" for a deal already AT
      // qualifying, and the picker prepends the current status — so the
      // dropdown listed Qualifying twice. Forward moves only; the caller adds
      // the current one.
      return sub === "rfp" ? ["estimating", "pre_sale_closed"] : ["pre_sale_closed"];
    case "estimating":
      // Forward is driven by the proposal. What a person knows and the system
      // cannot is that we're out — declined, or beaten before we quoted.
      return ["pre_sale_closed"];
    case "proposal":
      // The verbal yes/no. This is the single most common manual move there is.
      return ["pre_sale_closed"];
    case "pre_sale_closed":
      // Won → the work starts. Lost → nothing ahead; reopening is a correction
      // and belongs behind the disclosure.
      return sub === "won" ? ["pre_construction"] : [];
    case "pre_construction":
      return ["in_progress"];
    case "in_progress":
      return ["billing"];
    case "billing":
      return ["post_sale_closed"];
    default:
      return [];
  }
}

/**
 * "Under contract" — awarded and not yet closed out.
 *
 * ONE definition, because there were briefly two. The dashboard's money tiles
 * (Under contract, Left to bill, Outstanding) count `listProjects`, which is
 * won-not-started + pre-construction + in-progress + billing, excluding
 * completed. The list they linked to filtered by the post-contract *kanban
 * lane*, which drops won-not-started and adds completed — so the tile counted
 * jobs the list omitted and the list showed jobs the tile omitted.
 *
 * Caught by the parallel session's audit of step 10, and it is precisely the
 * number-and-destination mismatch that step claimed to be removing. Both sides
 * call this now.
 *
 * Keep in step with `listProjects` in lib/commercial/projects/db.ts.
 */
export function isUnderContract(status: string, sub: string | null): boolean {
  if (status === "pre_sale_closed") return sub === "won";
  return status === "pre_construction" || status === "in_progress" || status === "billing";
}
