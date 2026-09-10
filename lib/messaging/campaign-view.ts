/**
 * A campaign, described the way a person would describe it.
 *
 * WHAT HATCH MAKES PPP DO, and what this is trying not to. In Hatch an
 * audience and a workflow are separate objects and a workflow connects to one
 * audience, which is why PPP runs three near-identical campaigns per region.
 * A campaign is tied to one workspace, so the same sequence is duplicated
 * across twenty-seven of them and every wording change is twenty-seven edits.
 * Kate cannot answer "what is live right now" without clicking through all of
 * them.
 *
 * So the shape here is one campaign, many workspaces, one sequence — and this
 * module turns that into something readable: the audience as a sentence, the
 * steps as a timeline, and the problems as warnings BEFORE anybody publishes.
 *
 * Pure.
 */
import type { Rule } from "./rules";
import type { CampaignStep } from "./campaign-schedule";
import { unresolvedFields, isKnownMergeField } from "./merge-fields";

/* ─────────────────────────── the audience ─────────────────────────── */

const FIELD_WORDS: Record<string, string> = {
  RecordType: "record type",
  LeadSource: "lead source",
  CreatedDate: "created",
  Status: "status",
  IsConverted: "converted",
  SMS_Opt_In__c: "SMS opt-in",
  Email_Opt_In__c: "email opt-in",
  "Opportunity.AppointmentDate__c": "appointment date",
  "Opportunity.StageName": "opportunity stage",
  ServiceTerritory: "service territory",
};

const word = (field: string) => FIELD_WORDS[field] ?? field;

/** "a, b or c" — the reading a filter list actually has. */
function orList(values: unknown[]): string {
  const v = values.map((x) => String(x));
  if (v.length <= 1) return v[0] ?? "";
  return `${v.slice(0, -1).join(", ")} or ${v[v.length - 1]}`;
}

/**
 * One rule, as a clause a person would say out loud.
 *
 * Deliberately not describeRule, which is for a log line and reads like one.
 * "LeadSource is not one of Angi, Thumbtack" is accurate and nobody speaks it.
 */
export function clauseFor(rule: Rule): string {
  const v = rule.values ?? [];
  switch (rule.operator) {
    case "in":           return `the ${word(rule.field)} is ${orList(v)}`;
    case "not_in":       return `the ${word(rule.field)} is not ${orList(v)}`;
    case "equals":       return `the ${word(rule.field)} is ${v[0]}`;
    case "not_equals":   return `the ${word(rule.field)} is not ${v[0]}`;
    case "on_date":      return String(v[0]).toLowerCase() === "today"
                                ? `it was ${word(rule.field)} today`
                                : `it was ${word(rule.field)} on ${v[0]}`;
    case "within_days":  return `it was ${word(rule.field)} in the last ${v[0]} days`;
    case "is_true":      return `it is ${word(rule.field)}`;
    case "is_false":     return `it is not ${word(rule.field)}`;
    case "is_blank":     return `there is no ${word(rule.field)}`;
    case "is_not_blank": return `there is an ${word(rule.field)}`;
    case "contains":     return `the ${word(rule.field)} mentions ${v[0]}`;
    case "not_contains": return `the ${word(rule.field)} does not mention ${v[0]}`;
  }
}

/** Entry rules are ALL of these; exit rules are ANY of them. */
export function describeAudience(rules: Rule[], kind: "entry" | "exit"): string {
  if (rules.length === 0) {
    return kind === "entry"
      ? "Nobody. An audience with no rules matches nothing, which is deliberate."
      : "Nothing stops it, so it runs to the end of the sequence.";
  }
  const clauses = rules.map(clauseFor);
  if (clauses.length === 1) return `${clauses[0][0].toUpperCase()}${clauses[0].slice(1)}.`;

  const joiner = kind === "entry" ? " and " : " or ";
  const body = `${clauses.slice(0, -1).join(", ")}${joiner}${clauses[clauses.length - 1]}`;
  return `${body[0].toUpperCase()}${body.slice(1)}.`;
}

/* ─────────────────────────── the timeline ─────────────────────────── */

const clock12 = (t: string | null): string => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const hour = ((h + 11) % 12) + 1;
  return m ? `${hour}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}` : `${hour}${h < 12 ? "am" : "pm"}`;
};

const humanMinutes = (mins: number): string => {
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  if (mins < 1440) { const h = Math.round(mins / 60); return `${h} hour${h === 1 ? "" : "s"}`; }
  const d = Math.round(mins / 1440);
  return `${d} day${d === 1 ? "" : "s"}`;
};

/** When this step goes, said the way somebody would ask about it. */
export function timingOf(step: CampaignStep): string {
  switch (step.scheduleMode) {
    case "at_launch":        return "Straight away";
    case "delay_after_last": return `${humanMinutes(step.delayMinutes ?? 0)} later`;
    case "absolute_on_day": {
      const day = step.dayOffset ?? 0;
      const when = clock12(step.timeOfDay);
      if (day === 0) return `Same day at ${when}`;
      if (day === 1) return `Next day at ${when}`;
      return `Day ${day} at ${when}`;
    }
  }
}

/* ─────────────────────────── the warnings ─────────────────────────── */

export type CampaignWarning = {
  severity: "blocking" | "worth_checking";
  ordinal: number | null;
  message: string;
};

/**
 * Everything wrong with a campaign, before anybody turns it on.
 *
 * The point is that Hatch has no equivalent: PPP finds out a message was
 * broken when a customer receives it. A placeholder nobody defined is the one
 * that already nearly shipped — the opener said "Call us at
 * {{workspace_phone}}" and nothing filled it.
 */
export function campaignWarnings(steps: CampaignStep[], opts: {
  workspaceCount: number;
  /** Hours the workspaces actually send in, for spotting a step that will sit. */
  sendWindow?: { startHour: number; endHour: number };
} ): CampaignWarning[] {
  const out: CampaignWarning[] = [];

  if (steps.length === 0) {
    out.push({ severity: "blocking", ordinal: null, message: "There are no messages in this campaign yet." });
    return out;
  }
  if (opts.workspaceCount === 0) {
    out.push({ severity: "blocking", ordinal: null, message: "No workspace uses this campaign, so nobody would ever receive it." });
  }

  for (const s of steps) {
    // Only fields NOBODY fills. {{workspace_phone}} in the stored body is
    // correct and deliberate — it is filled per workspace at send time — and
    // flagging it as broken made a healthy campaign unpublishable.
    const unknown = [...new Set(unresolvedFields(s.body))].filter((f) => !isKnownMergeField(f));
    if (unknown.length) {
      out.push({
        severity: "blocking", ordinal: s.ordinal,
        message: `Uses ${unknown.map((f) => `{{${f}}}`).join(", ")}, which nothing fills in. The send gate refuses messages with a blank left in them, so this would never go out.`,
      });
    }
    if (s.channel === "email" && !s.subject?.trim()) {
      out.push({ severity: "blocking", ordinal: s.ordinal, message: "An email with no subject line." });
    }
    if (s.channel === "sms" && s.body.length > 480) {
      out.push({
        severity: "worth_checking", ordinal: s.ordinal,
        message: `${s.body.length} characters — about ${Math.ceil(s.body.length / 160)} texts, and charged as that many.`,
      });
    }
    if (s.scheduleMode === "absolute_on_day" && opts.sendWindow && s.timeOfDay) {
      const hour = Number(s.timeOfDay.split(":")[0]);
      if (hour < opts.sendWindow.startHour || hour >= opts.sendWindow.endHour) {
        out.push({
          severity: "worth_checking", ordinal: s.ordinal,
          message: `Set for ${clock12(s.timeOfDay)}, outside sending hours. The gate will hold it until they reopen.`,
        });
      }
    }
  }

  const firstSms = steps.find((s) => s.channel === "sms");
  if (firstSms && !/\b(reply|text|send)\s+(stop|end|quit|cancel|unsubscribe)\b|\bopt[- ]?out\b/i.test(firstSms.body)) {
    out.push({
      severity: "worth_checking", ordinal: firstSms.ordinal,
      message: "Does not say how to opt out. The gate adds it automatically, so it will be a little longer than it looks here.",
    });
  }

  return out;
}
