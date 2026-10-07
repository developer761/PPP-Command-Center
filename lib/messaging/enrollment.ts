/**
 * Deciding which campaign a lead belongs in, and when one should stop.
 *
 * Pure. The caller supplies the workflows and the record; this says yes or no
 * and, importantly, WHY — a lead that silently did not enter a campaign is
 * indistinguishable from one the system never saw, and that is the single
 * hardest thing to debug in a system like this.
 */
import { matchesAll, matchesAny, firstFailing, firstMatching, describeRule, readField, type Rule, type LeadRecord } from "./rules";

export type Workflow = {
  id: string;
  name: string;
  workspaceId: string;
  campaignId: string;
  entryRules: Rule[];
  exitRules: Rule[];
  isActive: boolean;
};

export type EnrolDecision =
  | { enrol: true; workflow: Workflow }
  | { enrol: false; reason: string };

/**
 * The first active workflow whose entry rules all pass.
 *
 * FIRST, not best. Two workflows matching one lead means the audiences
 * overlap, which is a configuration mistake rather than a choice to make at
 * runtime — and picking one silently would hide it. The overlap is reported so
 * somebody can fix the filters.
 */
export function chooseWorkflow(
  workflows: Workflow[], record: LeadRecord, now: Date
): EnrolDecision & { alsoMatched?: string[] } {
  const active = workflows.filter((w) => w.isActive);
  if (active.length === 0) return { enrol: false, reason: "no active workflow covers this workspace" };

  const matched = active.filter((w) => matchesAll(w.entryRules, record, now));
  if (matched.length === 0) {
    // Say which rule turned it away, using the workflow that got furthest.
    const best = active
      .map((w) => ({ w, failing: firstFailing(w.entryRules, record, now) }))
      .find((x) => x.failing);
    return {
      enrol: false,
      reason: best?.failing
        ? `did not match ${best.w.name}: ${describeRule(best.failing)}`
        : "matched no workflow",
    };
  }

  return {
    enrol: true,
    workflow: matched[0],
    alsoMatched: matched.slice(1).map((w) => w.name),
  };
}

export type ExitDecision =
  | { exit: true; reason: string; outcome: ConversationOutcome }
  | { exit: false };

/**
 * How a conversation that stops chasing should be RECORDED.
 *
 * Every exit wrote `outcome: "success"`. The seeded exit set is "Stop chasing
 * — booked, qualified or opted out", and two of its five rules are not
 * successes by anybody's reading:
 *
 *   Status = Unqualified          the office looked and said no
 *   SMS_Opt_In__c = Opt-Out       they asked us to stop
 *
 * Both were filed as bookings. That is the headline number Kate judges the bot
 * by, wrong in the most flattering direction, which is the worst way for a
 * number to be wrong — a bot that drives people to opt out would have looked
 * like a bot that books.
 *
 * Read from the RECORD rather than from the rule that matched, because what
 * happened to the lead is a fact about the lead; a workspace that rewords its
 * rules does not change what "Unqualified" means.
 *
 * Anything this does not recognise stays `success`, which is the previous
 * behaviour: the four other seeded rules — converted, an appointment booked,
 * the opportunity assigned, qualified — all genuinely are one.
 */
export type ConversationOutcome = "success" | "lost";

export function outcomeForExit(record: LeadRecord): ConversationOutcome {
  const status = String(readField(record, "Status") ?? "").trim().toLowerCase();
  if (status === "unqualified") return "lost";
  const optIn = String(readField(record, "SMS_Opt_In__c") ?? "").trim().toLowerCase();
  if (optIn === "opt-out") return "lost";
  return "success";
}

/** Any exit rule matching means stop, and the reason is recorded on the row. */
export function shouldExit(workflow: Workflow, record: LeadRecord, now: Date): ExitDecision {
  if (!matchesAny(workflow.exitRules, record, now)) return { exit: false };
  const rule = firstMatching(workflow.exitRules, record, now);
  return {
    exit: true,
    reason: rule ? describeRule(rule) : "an exit rule matched",
    outcome: outcomeForExit(record),
  };
}
