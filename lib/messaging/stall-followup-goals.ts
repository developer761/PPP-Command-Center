/**
 * What each of A44's three follow-ups is FOR.
 *
 * ── KATE'S ANSWER, 2026-10-05, VERBATIM ─────────────────────────────────
 *
 *   "The three stalled follow-ups won't be exact verbiage, but the goals
 *    would be the following. We might adjust once were in the testing phase,
 *    but this is a good starting point
 *
 *    Following up on the previous message
 *
 *    Asking if they have time to connect today re their project [summarized
 *    scope if known from inquiry]
 *
 *    Asking if they're still interested in receiving a free quote for their
 *    project [summarized scope if known from inquiry]. The bot could
 *    reference what we were trying to gather before they went silent"
 *
 * ── WHY GOALS AND NOT TEMPLATES ─────────────────────────────────────────
 *
 * Every other customer-facing sentence in this system comes from a template,
 * because a template cannot quote a price or invent an appointment. These
 * three do not, and that is deliberate on both sides:
 *
 *   Kate asked for goals and said the wording will move during testing.
 *   Karan chose an agent turn over three fixed strings precisely so a
 *   follow-up can mention what the conversation was actually about — a fixed
 *   string cannot, so follow-up #2 to somebody who gave us their address
 *   reads identically to #2 to somebody who gave us nothing. That is the
 *   Hatch behaviour being replaced and the first of the three structural
 *   failures on the spec's front page.
 *
 * The safety property is unchanged: this text goes into the PROMPT, and
 * whatever the model chooses still renders through the same intents, the same
 * validator and the same gate. Nothing here can reach a customer unmediated.
 *
 * ── THE ESCALATION IS THE POINT ─────────────────────────────────────────
 *
 * The three are not the same message three times. They climb: a nudge, then
 * a concrete ask for today, then a last check on whether they want the quote
 * at all. Kate's third explicitly licenses naming the thing we were trying to
 * collect, which is the only one that does.
 *
 * Pure. Returns a line for the prompt; the caller assembles it.
 */

/** 1, 2 or 3. A44 has exactly three and then hands back to the call centre. */
export type FollowUpStep = 1 | 2 | 3;

export const FOLLOW_UP_COUNT = 3;

export function isFollowUpStep(n: number | null | undefined): n is FollowUpStep {
  return n === 1 || n === 2 || n === 3;
}

/**
 * The scope, said the way Kate writes it: "[summarized scope if known from
 * inquiry]" — so it is named when we hold it and silently dropped when we do
 * not, rather than rendering an empty bracket at somebody.
 */
function theirProject(scope: string | null | undefined): string {
  const s = (scope ?? "").trim();
  return s ? `their ${s} project` : "their project";
}

/**
 * The goal for this step, as an instruction to the model.
 *
 * Deliberately says what to ACHIEVE and not what to write. The wording is
 * Kate's to settle during testing, and a sentence pinned here would quietly
 * become the wording whatever she decides later.
 */
export function stallFollowUpGoal(
  step: FollowUpStep,
  scope: string | null | undefined,
): string {
  const project = theirProject(scope);
  switch (step) {
    case 1:
      // The lightest touch. Nothing new to say, so say nothing new.
      return `Follow up on your previous message about ${project}. `
        + `Nothing has changed since it, so add no new information and make no new offer.`;
    case 2:
      // The only one with a concrete ask in it.
      return `Ask whether they have time to connect TODAY about ${project}.`;
    case 3:
      // The last one before the lead goes back to the phone team, and the
      // only one Kate licenses to name the outstanding thing.
      return `Ask whether they are still interested in a free quote for ${project}. `
        + `You may refer to what we were trying to collect when they went quiet, `
        + `so it is clear what is outstanding.`;
  }
}
