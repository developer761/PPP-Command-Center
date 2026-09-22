/**
 * Kate's per-turn findings, as a format this system reads.
 *
 * She grades conversation by conversation and writes one line per thing worth
 * saying about a turn. Two shapes, because the format has moved on:
 *
 *   2026-09-11   T8 [A11 | Redundant Ask/mild] asked for the address again
 *                -> SHOULD HAVE: confirmed the one on file
 *
 *   2026-09-22   T4 [A3 | critical] Address and contact were held in full and
 *                NEVER confirmed with the customer before the close.
 *                -> SHOULD HAVE: asked for the fields it did not hold
 *
 * The older one carries a NAME and a severity separated by a slash. The newer
 * one carries the severity on its own. A parser written for the first reads
 * "critical" as the rule's name and files the severity as null — which is
 * exactly what happened: findings already in the table show `[A11 | null]`
 * where a severity was plainly written.
 *
 * ── WHY THIS IS IN lib AND NOT IN A SCRIPT ──────────────────────────────
 *
 * It was in scripts/import-kate-batch.mjs, where nothing tests it. That is how
 * the severity bug survived: the import printed a confident count of findings
 * and every one of them was missing a field nobody checked. This is the join
 * between Kate's grading and the rules the bot is told, so it is worth a test
 * per shape rather than a regex nobody can run.
 *
 * Pure.
 */

export type FindingKind = "fell_short" | "did_well";
export type FindingSeverity = "mild" | "medium" | "critical";

export type ParsedFinding = {
  /** Her "T4" — which turn of the transcript this is about. */
  turnOrdinal: number;
  /** Her rule code: A1 … A44. */
  code: string;
  severity: FindingSeverity | null;
  /** The rule's short name, when the older format carried one. */
  name: string | null;
  what: string;
  /** Her "-> SHOULD HAVE:". The most valuable field in the sheet — a
   *  correction teaches, where a complaint only labels. */
  shouldHave: string | null;
  /** Null when the line does not settle it. See kindOf. */
  kind: FindingKind | null;
};

const SEVERITY: Record<string, FindingSeverity> = {
  mild: "mild", medium: "medium", critical: "critical", crit: "critical",
  minor: "mild", major: "critical",
};

/**
 * Read the bracket: `[A3 | critical]`, `[A11 | Redundant Ask/mild]`, `[A6]`.
 *
 * The rule is: whatever sits after the pipe is a name, a severity, or a name
 * and a severity separated by a slash. A lone word that IS a severity is a
 * severity — that is the whole difference between the two formats, and
 * guessing it the other way silently drops the field.
 */
export function parseBracket(inner: string): { code: string; name: string | null; severity: FindingSeverity | null } | null {
  const m = /^\s*(A\d+)\s*(?:\|\s*(.*?))?\s*$/.exec(inner);
  if (!m) return null;
  const code = m[1].toUpperCase();
  const rest = (m[2] ?? "").trim();
  if (!rest) return { code, name: null, severity: null };

  // "Redundant Ask/mild" — name and severity.
  const slash = rest.lastIndexOf("/");
  if (slash >= 0) {
    const maybeSev = SEVERITY[rest.slice(slash + 1).trim().toLowerCase()];
    if (maybeSev) {
      const name = rest.slice(0, slash).trim();
      return { code, name: name || null, severity: maybeSev };
    }
  }

  // "critical" on its own — the newer shape.
  const asSeverity = SEVERITY[rest.toLowerCase()];
  if (asSeverity) return { code, name: null, severity: asSeverity };

  // A name with no severity. Severity lives on the FINDING rather than the
  // code (migration 200), so a missing one is a real null, not a default.
  return { code, name: rest, severity: null };
}

/**
 * Which column this came from, when the line says.
 *
 * A finding carrying a correction is certainly a shortfall — nobody writes
 * "should have" about something that went right. Anything else is ambiguous
 * and stays null rather than being filed under a guess: marking a good turn
 * as a failure teaches the bot to avoid the thing it got right, which is worse
 * than not importing it at all.
 */
export function kindOf(shouldHave: string | null, hint?: FindingKind | null): FindingKind | null {
  if (hint) return hint;
  return shouldHave ? "fell_short" : null;
}

const LINE = /T(\d+)\s*\[([^\]]*)\]\s*([\s\S]*?)(?=T\d+\s*\[\s*A\d+|$)/g;

/**
 * Every finding in a block of her text.
 *
 * `hint` says which column the block came from, when the caller knows — a CSV
 * export keeps that boundary where a flattened PDF does not.
 */
export function parseFindings(segment: string, hint?: FindingKind | null): ParsedFinding[] {
  const out: ParsedFinding[] = [];
  LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINE.exec(segment)) !== null) {
    const bracket = parseBracket(m[2]);
    if (!bracket) continue;

    const [what, shouldHaveRaw] = m[3].split(/->\s*SHOULD HAVE:\s*/i);
    const trimmed = (what ?? "").trim();
    if (!trimmed) continue;
    const shouldHave = shouldHaveRaw?.trim() || null;

    out.push({
      turnOrdinal: Number(m[1]),
      code: bracket.code,
      severity: bracket.severity,
      name: bracket.name,
      what: trimmed.slice(0, 2000),
      shouldHave: shouldHave ? shouldHave.slice(0, 2000) : null,
      kind: kindOf(shouldHave, hint),
    });
  }
  return out;
}
