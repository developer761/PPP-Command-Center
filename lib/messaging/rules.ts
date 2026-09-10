/**
 * Entry and exit rules, evaluated.
 *
 * These are Kate's "Audience" and "Lead Remove Rules Template" from Hatch,
 * stored as rows instead of prose. Her real CA LA setup:
 *
 *   ENTRY   Record Type in (Web Inquiry, Phone Inquiry)
 *           Lead Source not in (Angi, Thumbtack, ...)
 *           Created Date = today
 *           Service Territory in (...)
 *
 *   EXIT    IsConverted is true
 *           Status in (Qualified, Unqualified)
 *           SMS_Opt_In__c equals Opt-Out
 *           Opportunity.AppointmentDate__c is not blank
 *           Opportunity.StageName equals Opportunity Assigned
 *
 * ALL RULES MUST PASS. An audience is a conjunction — "web inquiries, from
 * these territories, created today" is one filter, not four. Exit is the same
 * shape but read the other way: any single exit rule set that matches means
 * stop, which is why exit sets are kept small and specific.
 *
 * Pure. No database, no clock except the one passed in.
 */

export type RuleOperator =
  | "equals" | "not_equals" | "in" | "not_in" | "contains" | "not_contains"
  | "is_blank" | "is_not_blank" | "is_true" | "is_false"
  | "on_date" | "within_days";

export type Rule = {
  field: string;
  operator: RuleOperator;
  values: unknown[];
};

/** A Salesforce-shaped record: flat, with dotted paths for related objects. */
export type LeadRecord = Record<string, unknown>;

/**
 * Read a field, including dotted paths like Opportunity.StageName.
 *
 * Tries the literal key first. Salesforce payloads sometimes arrive already
 * flattened with the dot in the key name, and treating that as a miss would
 * silently fail every rule about an Opportunity.
 */
export function readField(record: LeadRecord, field: string): unknown {
  if (field in record) return record[field];
  let cur: unknown = record;
  for (const part of field.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Blank means blank: missing, null, empty, or whitespace. */
export function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** Salesforce truthiness, including the strings its exports use. */
function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = norm(v);
  return s === "true" || s === "1" || s === "yes";
}

function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function evaluateRule(rule: Rule, record: LeadRecord, now: Date): boolean {
  const raw = readField(record, rule.field);
  const values = rule.values ?? [];

  switch (rule.operator) {
    case "is_blank":     return isBlank(raw);
    case "is_not_blank": return !isBlank(raw);
    case "is_true":      return asBool(raw);
    case "is_false":     return !asBool(raw);

    // Case-insensitive, because "Web Inquiry" and "web inquiry" are the same
    // record type and nobody typing a filter should have to know which one
    // Salesforce will send.
    case "equals":       return norm(raw) === norm(values[0]);
    case "not_equals":   return norm(raw) !== norm(values[0]);

    // A MISSING field is not in the list, so not_in passes. That is the whole
    // point of Kate's "Lead Source not in (Angi, Thumbtack)": a lead with no
    // source recorded is not an Angi lead and belongs in the campaign.
    case "in":           return values.some((v) => norm(v) === norm(raw));
    case "not_in":       return !values.some((v) => norm(v) === norm(raw));

    case "contains":     return norm(raw).includes(norm(values[0]));
    case "not_contains": return !norm(raw).includes(norm(values[0]));

    case "on_date": {
      const d = asDate(raw);
      if (!d) return false;
      // "today" is the value Kate's filters actually use.
      const target = norm(values[0]) === "today" ? now : asDate(values[0]);
      return !!target && sameDay(d, target);
    }

    case "within_days": {
      const d = asDate(raw);
      if (!d) return false;
      const days = Number(values[0]);
      if (!Number.isFinite(days)) return false;
      const ms = now.getTime() - d.getTime();
      // Future dates count as within: a lead created a minute from now by a
      // clock that is slightly off is not older than the window.
      return ms <= days * 86_400_000;
    }
  }
}

/** Every rule must pass. An empty set matches nothing, deliberately — see below. */
export function matchesAll(rules: Rule[], record: LeadRecord, now: Date): boolean {
  // An audience with no rules would enrol EVERY lead in the system, which is
  // never what an empty form meant. Refusing to match is the safe reading.
  if (rules.length === 0) return false;
  return rules.every((r) => evaluateRule(r, record, now));
}

/** Any rule matching means leave. Exit is read the other way from entry. */
export function matchesAny(rules: Rule[], record: LeadRecord, now: Date): boolean {
  if (rules.length === 0) return false;
  return rules.some((r) => evaluateRule(r, record, now));
}

/** Which rule stopped it, for a screen that has to explain itself. */
export function firstFailing(rules: Rule[], record: LeadRecord, now: Date): Rule | null {
  return rules.find((r) => !evaluateRule(r, record, now)) ?? null;
}

/** Which exit rule fired, for the same reason. */
export function firstMatching(rules: Rule[], record: LeadRecord, now: Date): Rule | null {
  return rules.find((r) => evaluateRule(r, record, now)) ?? null;
}

/** A rule in words, for a screen and for the cancellation reason on a row. */
export function describeRule(rule: Rule): string {
  const list = (rule.values ?? []).map((v) => String(v)).join(", ");
  switch (rule.operator) {
    case "is_blank":     return `${rule.field} is blank`;
    case "is_not_blank": return `${rule.field} is not blank`;
    case "is_true":      return `${rule.field} is true`;
    case "is_false":     return `${rule.field} is false`;
    case "equals":       return `${rule.field} is ${list}`;
    case "not_equals":   return `${rule.field} is not ${list}`;
    case "in":           return `${rule.field} is one of ${list}`;
    case "not_in":       return `${rule.field} is not one of ${list}`;
    case "contains":     return `${rule.field} contains ${list}`;
    case "not_contains": return `${rule.field} does not contain ${list}`;
    case "on_date":      return `${rule.field} is ${list}`;
    case "within_days":  return `${rule.field} is within ${list} days`;
  }
}
