/**
 * What changed about a rule, when Kate re-issues her sheet.
 *
 * She asked for a change history so that six months from now "why did X
 * improve" has an answer other than somebody's memory. The only way that
 * history exists in six months is if nobody has to remember to write it — so
 * the import diffs what it is about to write against what is already there,
 * and the log is a by-product of the work.
 *
 * ONE ENTRY PER FIELD THAT MOVED. "A22 severity went mild -> critical on
 * 2026-10-04" can be lined up against a change in that rule's breach count.
 * "A22 was edited" cannot.
 *
 * Pure.
 */
import type { ClassARule } from "./class-a-rules";

/** The fields worth recording. Everything else is bookkeeping. */
export const TRACKED = [
  "statement", "rule_card", "corrective_action", "severity",
  "status", "binds", "phrasing_only", "short_name",
] as const;

export type TrackedField = (typeof TRACKED)[number] | "added";

export type RuleChange = {
  code: string;
  field: TrackedField;
  before: string | null;
  after: string | null;
  changeType: string | null;
};

/** The shape as it sits in the database, snake_cased. */
export type StoredRule = {
  code: string;
  statement?: string | null;
  rule_card?: string | null;
  corrective_action?: string | null;
  severity?: string | null;
  status?: string | null;
  binds?: boolean | null;
  phrasing_only?: boolean | null;
  short_name?: string | null;
};

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  const t = String(v).trim();
  return t ? t : null;
};

/**
 * Whitespace is not a change.
 *
 * A sheet re-exported from Google Sheets differs from the last one in line
 * endings and trailing spaces on rows nobody touched. Recording those would
 * bury the real edits under a hundred that say nothing — and the first time
 * that happens, the history stops being read.
 */
export function sameText(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (text(v) ?? "").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/** What the incoming rule changes about the stored one. */
export function diffRule(
  before: StoredRule | null,
  after: ClassARule & { shortName?: string | null },
  /**
   * Fields whose COLUMN was missing from the sheet.
   *
   * Their values are parser defaults, not decisions, so comparing them
   * reports edits nobody made. The 23 September sheet dropped binds and
   * phrasing_only, and without this the import wrote twelve "Binds the bot:
   * no -> yes" rows for rules Kate had not touched. A change log carrying
   * twelve invented entries beside six real ones is a change log nobody
   * trusts, which is the failure this whole file exists to avoid.
   */
  absent: ReadonlySet<string> = new Set()
): RuleChange[] {
  // A rule appearing for the first time is not 44 changes; it is one fact.
  // Recording every field on a first import would make the very first history
  // page unreadable and say nothing anybody did not already know.
  if (!before) {
    return [{
      code: after.code,
      field: "added",
      before: null,
      after: after.statement,
      changeType: after.changeType ?? null,
    }];
  }

  const incoming: Record<string, unknown> = {
    statement: after.statement,
    rule_card: after.ruleCard,
    corrective_action: after.correctiveAction,
    severity: after.severity,
    status: after.status,
    binds: after.binds,
    phrasing_only: after.phrasingOnly,
    short_name: after.shortName ?? null,
  };

  /** camelCase names, as the parser reports them, for the snake_case fields
   *  this walks. */
  const PARSER_NAME: Record<string, string> = {
    rule_card: "ruleCard", corrective_action: "correctiveAction",
    phrasing_only: "phrasingOnly", short_name: "shortName",
  };

  const out: RuleChange[] = [];
  for (const field of TRACKED) {
    if (absent.has(field) || absent.has(PARSER_NAME[field] ?? field)) continue;
    const was = (before as Record<string, unknown>)[field];
    const now = incoming[field];
    // short_name is only ever filled in from the older code table, and a
    // sheet that does not carry it must not be read as deleting it.
    if (field === "short_name" && now === null && text(was) !== null) continue;
    if (sameText(was, now)) continue;
    out.push({
      code: after.code,
      field,
      before: text(was),
      after: text(now),
      changeType: after.changeType ?? null,
    });
  }
  return out;
}

/** Plain words for a change, for the screen and for a reviewer. */
export function describeChange(c: RuleChange): string {
  if (c.field === "added") return "Added";
  const label: Record<string, string> = {
    statement: "The rule",
    rule_card: "The detail",
    corrective_action: "What good looks like",
    severity: "Severity",
    status: "Status",
    binds: "Binds the bot",
    phrasing_only: "Phrasing only",
    short_name: "Short name",
  };
  const name = label[c.field] ?? c.field;
  // Short values read better inline; a rewritten rule card does not.
  const short = (c.before?.length ?? 0) < 40 && (c.after?.length ?? 0) < 40;
  if (short) return `${name}: ${c.before ?? "—"} → ${c.after ?? "—"}`;
  return `${name} rewritten`;
}
