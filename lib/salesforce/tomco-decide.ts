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

/**
 * Worth putting in front of a person at all.
 *
 * The ranker gives 10 points for closing within 90 days, which on its own is a
 * coincidence rather than a resemblance — nearly every open estimate earns it.
 * Showing those padded each queue item with absurdities: a $5,150 job was
 * offered `AVR-Lot C` at $385,882.22 and `127 S. Fourth St.` at $35,287.60,
 * five of eight entries being noise.
 *
 * That works directly against accuracy. A list full of obvious non-answers
 * teaches a reader to skim, and skimming is how the wrong "same job" gets
 * clicked — the exact mistake this screen exists to prevent. So 18 is the
 * floor: one real signal (an amount within 20%, or shared words) beyond the
 * date. Everything below it is counted, not listed.
 */
export const SHOW_SCORE = 18;

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
      /** Open estimates that were checked and resemble nothing. Counted rather
       *  than listed — "we looked at 43" is reassuring, seeing 43 is not. */
      othersChecked: number;
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
  /*
   * 🔴 THE CUTOVER DOES NOT OVERRIDE A CONTENDER.
   *
   * This branch used to return `insert` even with high-scoring contenders, on
   * the reasoning that a deal raised here after Salesforce entry stopped cannot
   * have a twin over there. That premise is false for one real population, and
   * it is the population this whole feature is about: the 43 open Salesforce
   * estimates. Any of those not yet in the Command Center has to be entered
   * here AFTER the cutover in order to be sold — so a genuine twin, created in
   * Salesforce weeks before the cutover, pairs with a Command Center deal
   * created after it.
   *
   * Concretely: Mary typed a $212,400 job into Salesforce on 2026-10-01. The
   * estimator raises the same job here on 2026-10-20, because this is the
   * system of record now. It sells. The ranker scores the Salesforce estimate
   * 95 — same account, amount to the cent, words in common — and the old code
   * inserted anyway, with a `why` that asserted the match predated the deal as
   * if that settled it. Two Closed Won copies of one $212,400 sale, both
   * looking legitimate.
   *
   * The asymmetry in this file's own docblock decides it: a wrong hold costs
   * one click, a wrong insert costs a double-counted sale that nothing
   * downstream flags. So the cutover only licenses an insert when there is
   * nothing plausible to collide with — which is still the overwhelming
   * majority of cases, and the ones it does not cover fall through to the hold
   * directly below.
   */
  if (createdAfterCutover && contenders.length === 0) {
    return {
      action: "insert",
      why: `Created after ${cutover}, when Salesforce entry stopped. Nothing open over there resembles it.`,
    };
  }

  /*
   * 3. SOMETHING PLAUSIBLE EXISTS → hold.
   *
   * This is the Cummins and PCCI case. Both scored high, both were real twins,
   * and auto-inserting either would have double-counted a live sale.
   */
  if (contenders.length > 0) {
    const worthShowing = ranked.filter((c) => c.score >= SHOW_SCORE).slice(0, 8);
    return {
      action: "hold",
      why:
        contenders.length === 1
          ? `One open Salesforce estimate looks like this job — ${contenders[0].reasons.join(", ")}. Someone has to confirm.`
          : `${contenders.length} open Salesforce estimates could be this job. Someone has to choose.`,
      candidates: worthShowing,
      othersChecked: Math.max(0, input.openCandidates.length - worthShowing.length),
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
