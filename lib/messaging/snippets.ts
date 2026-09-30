/**
 * Reusable replies for a person answering a thread. Hatch parity.
 *
 * Hatch gives a rep a named library — "Availability", "Estimate Confirmation
 * - In Person", "Circling Back #1" — and we give them an empty box, so the
 * same four sentences get retyped all day and each retyping is a chance to
 * word it differently.
 *
 * ── WHY THE RULES HERE ARE LIGHTER THAN THE FAQ ONES ────────────────────
 *
 * workspace-faq.ts checks its content hard: no price (A1), no naming another
 * company (A18), nothing location-bound in the shared tier. That is because
 * an FAQ answer is handed to a MODEL, which may repeat it to somebody with no
 * human in between. A wrong one is not caught by anybody.
 *
 * A snippet is read by the person sending it, in a composer, and can be
 * edited before it goes. The reader is the check. So the only thing worth
 * refusing here is what a reader cannot catch by reading — and there is
 * exactly one of those.
 *
 * ── THE ONE THING A READER CANNOT CATCH ─────────────────────────────────
 *
 * A merge field nothing fills. `{{estimator_name}}` looks deliberate in an
 * editor, survives the rep's read because it looks like the system will
 * handle it, and is then REFUSED by the gate — after they have hit send, on a
 * screen that has already moved on. Worse, `fillMergeFields` deliberately
 * leaves an unfillable field in place rather than blanking it, precisely so
 * the gate catches it; so what the rep would see inserted is the raw token.
 *
 * Pure. The caller does the reading and writing.
 */
import { unresolvedFields, isKnownMergeField } from "./merge-fields";

export type Snippet = {
  name: string;
  body: string;
  /** Stored once with `workspace_id IS NULL` and offered in every workspace. */
  shared?: boolean;
};

export type SnippetProblem = { field: "name" | "body"; why: string };

/** Is this snippet safe to offer to somebody answering a customer? */
export function checkSnippet(s: { name: string; body: string }): SnippetProblem[] {
  const problems: SnippetProblem[] = [];
  const name = s.name.trim();
  const body = s.body.trim();

  if (!name) problems.push({ field: "name", why: "it has no name, so nobody could find it" });
  if (!body) problems.push({ field: "body", why: "it is empty" });

  /**
   * The name is rendered as a BUTTON LABEL in the composer, in a wrapping row
   * that sits above the reply box. Nothing capped it — not here, not the
   * database, not the editor — so one long name pushes Send off the screen.
   */
  if (name.length > 60) {
    problems.push({
      field: "name",
      why: `the name is ${name.length} characters. It becomes a button above the reply box, `
        + `so it needs to be short enough to read at a glance`,
    });
  }

  const unknown = [...new Set(unresolvedFields(body))].filter((f) => !isKnownMergeField(f));
  if (unknown.length) {
    problems.push({
      field: "body",
      why: `nothing fills in ${unknown.map((f) => `{{${f}}}`).join(", ")}. The send gate refuses `
        + `a message with a blank left in it, so this would be rejected after somebody had `
        + `already sent it`,
    });
  }

  /**
   * Long enough to be a document rather than a text. Not a hard rule about
   * segments — a rep may genuinely want a long one — but a snippet is a
   * starting point somebody edits, and a wall of text is not.
   */
  if (body.length > 900) {
    problems.push({
      field: "body",
      why: `it is ${body.length} characters. A snippet is a starting point somebody edits, `
        + `and this is long enough to be its own message`,
    });
  }
  return problems;
}

/** Only the ones that are safe, so a broken snippet cannot reach a composer. */
export function usableSnippets<T extends { name: string; body: string }>(
  list: readonly T[]
): { usable: T[]; rejected: { snippet: T; problems: SnippetProblem[] }[] } {
  const usable: T[] = [];
  const rejected: { snippet: T; problems: SnippetProblem[] }[] = [];
  for (const s of list) {
    const problems = checkSnippet(s);
    if (problems.length) rejected.push({ snippet: s, problems });
    else usable.push(s);
  }
  return { usable, rejected };
}

/**
 * A workspace's own snippet beats a shared one of the same name.
 *
 * The same precedence the standing answers use, and the same normalisation —
 * trimmed, lowercased, inner runs collapsed — because the unique index sees
 * "Circling  Back" and "Circling Back" as different strings and would let
 * both exist.
 */
export function resolveSnippets<T extends { name: string; shared?: boolean }>(
  rows: readonly T[]
): T[] {
  const norm = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");
  const byName = new Map<string, T>();
  for (const s of [...rows.filter((r) => !r.shared), ...rows.filter((r) => r.shared)]) {
    const key = norm(s.name);
    if (!byName.has(key)) byName.set(key, s);
  }
  return [...byName.values()];
}
