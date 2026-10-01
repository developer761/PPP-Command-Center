/**
 * Whose finish is allowed to be sitting in the box before the customer answers.
 *
 * Alex asked for one thing on 2026-10-01 — "doesn't want the finish to
 * auto-populate for customers" — and it took two passes, because the finish
 * arrives from THREE independent places and the first fix only closed one:
 *
 *   1. the form choosing one when a color is picked (handleColorPick)
 *   2. Salesforce's saved Finish on the WorkOrderLineItem (sfSeedForSurface)
 *   3. a previous submitted payload for the work order
 *
 * (2) is the one a customer actually meets, because most work orders already
 * carry a finish, and Kate came back with "Finish still auto-populates for
 * customers" while (1) was already fixed. It does not matter to a customer
 * which of our systems chose it; it is an answer they did not give.
 *
 * (3) splits in two. The customer's own previous submission on THEIR OWN token
 * is theirs and comes back on a re-edit — that is what re-editing means. A
 * payload from a different token on the same work order (a staff internal
 * entry, reached through the getLatestSubmittedPayload fallback) is somebody
 * else's answer wearing the customer's dropdown, and is treated like
 * Salesforce's.
 *
 * Staff entry keeps every shortcut: an AM entering a whole house by phone is
 * the case Alex was not talking about.
 *
 * Lives here rather than inline in the component so the rule can be tested —
 * a component in this repo cannot be rendered by the suite (node env, no DOM),
 * which is exactly why the first miss went unnoticed by a green suite.
 */
export type FinishSeedPolicy = {
  /** Pre-fill the finish Salesforce already holds for the surface. */
  fromSalesforce: boolean;
  /** Pre-fill the finish from a submitted payload. */
  fromPriorSubmission: boolean;
  /** Fill a finish when the customer picks a color. */
  onColorPick: boolean;
};

export function finishSeedPolicy(input: {
  /** Preview or internal entry — a PPP person, not the customer. */
  isStaffEntry: boolean;
  /** The prior payload belongs to THIS token, i.e. the customer's own answer. */
  hasOwnSubmission: boolean;
}): FinishSeedPolicy {
  if (input.isStaffEntry) {
    return { fromSalesforce: true, fromPriorSubmission: true, onColorPick: true };
  }
  return {
    fromSalesforce: false,
    fromPriorSubmission: input.hasOwnSubmission,
    onColorPick: false,
  };
}
