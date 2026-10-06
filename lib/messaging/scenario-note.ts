/**
 * A rater's three boxes as one labelled note.
 *
 * Deliberately NOT in simulator.ts. That file is "use server", and such a
 * module may export only async functions — a single sync export silently drops
 * every export in the production build, which tsc cannot see and which broke
 * this app once already. It was written there first and `npm run build` caught
 * it, which is the whole reason that check exists.
 *
 * ── WHY THIS COMPOSES INSTEAD OF STORING THREE FIELDS ───────────────────
 *
 * `sms_scenario_turns` has one text column, `verdict_note`. Giving the three
 * boxes columns of their own means a migration, and this repo has no migration
 * runner — the SQL is hand-run against production, which is Karan's call.
 * Losing a rater's words while that is decided is the worse option, and the
 * labels keep the parts separable if the columns do arrive later.
 */

/** What a graded turn carries from the panel. All optional: a turn can be
 *  marked without a word written, and often is. */
export type RaterNote = {
  /** The older single box, before the three existed. */
  verdictNote?: string;
  didWell?: string;
  shortfall?: string;
  shouldHave?: string;
};

/**
 * Null when nothing was typed, so an ungraded turn stays empty rather than
 * storing a set of headings with nothing under them.
 */
export function composeNote(t: RaterNote): string | null {
  const parts = [
    t.didWell?.trim() && `Got right: ${t.didWell.trim()}`,
    t.shortfall?.trim() && `Fell short: ${t.shortfall.trim()}`,
    t.shouldHave?.trim() && `Should have: ${t.shouldHave.trim()}`,
    t.verdictNote?.trim(),
  ].filter(Boolean) as string[];
  return parts.length ? parts.join("\n") : null;
}
