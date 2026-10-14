import "server-only";

import { rankCandidates, type RankedCandidate, type SfCandidate, type SoldDeal } from "./tomco-pairing";

/**
 * Automatic, except where a person genuinely has to look.
 *
 * Karan 2026-10-14: *"this system writeback needs to be 1000 percent accurate
 * … and automatic as well."* Those pull against each other only if you assume
 * every deal is ambiguous. Almost none are.
 *
 * WHY MOST OF IT IS SAFE TO AUTOMATE
 *
 * The duplicate risk had exactly one cause: Tomco's estimates were typed into
 * Salesforce by hand AND into the Command Center, so a job existed twice before
 * it was sold. Katie stopped that on 2026-10-14 — *"I told her to stop building
 * anything in SF"* — which means a deal created after that date has nothing in
 * Salesforce to collide with. It cannot have a twin, so writing it unattended
 * is not a gamble.
 *
 * What remains is a CLOSED BACKLOG: the open Tomco estimates that already
 * existed. Each one either sells (and needs pairing) or dies. The list only
 * shrinks. So the hold queue empties over the next few months and never refills.
 *
 * THE ASYMMETRY THAT SETS THE THRESHOLD
 *
 * Holding a deal that was actually new costs somebody one click. Auto-inserting
 * a deal that already existed puts a second copy of a real sale into the number
 * Katie is using to run the company, and nothing downstream would flag it —
 * both records look legitimate. Those are not comparable, so the threshold is
 * deliberately low and the tie always goes to asking.
 */

/** Katie told Mary to stop creating Tomco records in Salesforce on this date. */
export const SF_ENTRY_STOPPED = "2026-10-14";

/**
 * Any open Salesforce estimate scoring at or above this makes us stop and ask.
 *
 * 40 is below a single signal firing alone — the account match is worth 50 — so
 * in practice ANY open estimate on the same GC holds the deal. That is
 * intentional: a GC with two live jobs is exactly the case where a machine
 * picking wrong is most expensive and a person deciding is easiest.
 */
export const HOLD_SCORE = 40;

export type WriteBackPlan =
  | {
      action: "update";
      /** The Salesforce record this deal is already linked to. */
      sfId: string;
      why: string;
    }
  | {
      action: "insert";
      why: string;
    }
  | {
      action: "hold";
      why: string;
      /** What a person has to choose between, best first. */
      candidates: RankedCandidate[];
    };

export type DecideInput = {
  deal: SoldDeal;
  /** Set when `commercial_import_map` already links this deal. */
  pairedSfId: string | null;
  /** Open (IsClosed = false) Tomco opportunities. */
  openCandidates: SfCandidate[];
  /** `commercial_opportunities.created_at`, for the cutover test. */
  dealCreatedAt: string | null;
  /** Overridable so a test can pin it; never passed in production. */
  cutover?: string;
};

/**
 * What should the write-back do with this sold deal — and never guess.
 *
 * Pure, so the rule can be read and tested without a Salesforce connection.
 * Returns a plan and a reason in words; the caller executes, the queue displays.
 */
export function decideWriteBack(input: DecideInput): WriteBackPlan {
  const cutover = input.cutover ?? SF_ENTRY_STOPPED;

  /*
   * 1. ALREADY LINKED → update, always.
   *
   * The link was either made by the importer (the deal came out of Salesforce)
   * or by a person on the pairing screen. Either way the ambiguity is spent and
   * there is nothing left to decide. This covers 94 of the 98 sold deals today.
   */
  if (input.pairedSfId) {
    return {
      action: "update",
      sfId: input.pairedSfId,
      why: "Already linked to a Salesforce opportunity — updating it.",
    };
  }

  const ranked = rankCandidates(input.deal, input.openCandidates);
  const contenders = ranked.filter((c) => c.score >= HOLD_SCORE && !c.alreadyPaired);

  /*
   * 2. CREATED AFTER THE CUTOVER → insert, even if something scores.
   *
   * Nobody has been able to create a Tomco record in Salesforce since this
   * date, so a deal raised here afterwards has no twin by construction. A high
   * score against an OLD estimate is then a coincidence of name and amount, not
   * evidence — and holding on it would queue up work that can never resolve,
   * which is how a review queue stops being read.
   *
   * The date is the guard, and it is checked against when the deal was CREATED,
   * not when it sold: a deal raised in September and sold in November could
   * still have been entered in Salesforce back in September.
   */
  const createdAfterCutover =
    !!input.dealCreatedAt && input.dealCreatedAt.slice(0, 10) > cutover;
  if (createdAfterCutover) {
    return {
      action: "insert",
      why:
        contenders.length > 0
          ? `Created after ${cutover}, when Salesforce entry stopped, so it cannot have a twin there — the ${contenders.length} similar record(s) predate it.`
          : `Created after ${cutover}, when Salesforce entry stopped. Nothing to collide with.`,
    };
  }

  /*
   * 3. SOMETHING PLAUSIBLE EXISTS → hold.
   *
   * This is the Cummins and PCCI case. Both scored high, both were real twins,
   * and auto-inserting either would have double-counted a live sale.
   */
  if (contenders.length > 0) {
    return {
      action: "hold",
      why:
        contenders.length === 1
          ? `One open Salesforce estimate looks like this job — ${contenders[0].reasons.join(", ")}. Someone has to confirm.`
          : `${contenders.length} open Salesforce estimates could be this job. Someone has to choose.`,
      candidates: ranked.slice(0, 8),
    };
  }

  /*
   * 4. NOTHING LOOKS LIKE IT → insert.
   *
   * Thermo Fisher and Flagstar: no open estimate on the account, no amount
   * agreement, no shared words. The ranker ran and found nothing, which is a
   * different and much safer statement than never having looked.
   */
  return {
    action: "insert",
    why:
      input.openCandidates.length === 0
        ? "No open Tomco estimates in Salesforce at all."
        : `Checked all ${input.openCandidates.length} open Salesforce estimates; none scores near this job.`,
  };
}

/**
 * A one-line summary for the run log and the queue.
 *
 * Deliberately says what WILL happen rather than what the code decided —
 * somebody reading a nightly report should not have to know the word "insert".
 */
export function describePlan(deal: SoldDeal, plan: WriteBackPlan): string {
  const name = deal.title.slice(0, 48);
  if (plan.action === "update") return `${name} — updating Salesforce`;
  if (plan.action === "insert") return `${name} — adding to Salesforce`;
  return `${name} — HELD for review: ${plan.why}`;
}
