/**
 * Which rooms "Apply to all areas" touches.
 *
 * The default is FILL-EMPTY-ONLY (Katie 2026-05-29): a color the customer
 * already chose for another room is never replaced by a click somewhere else.
 *
 * `overwrite` is the customer saying otherwise (Kate 2026-09-18: "add an
 * 'overwrite anyway' option in case customers change their mind and need to
 * update multiple rooms/areas"). It replaces colors already chosen — but never
 * a SKIP.
 *
 * That limit is DELIBERATE and confirmed (Karan, 2026-09-19: "I would keep it
 * where applying to all areas does not override a 'skip this surface'"). Do
 * not widen it without asking him again. "Don't paint this surface" is an
 * answer, not an absence of one — the same reading the order builder, the
 * vendor email and the Salesforce writeback all take — and a sweep started in
 * another room is the last place it should be reversed from. The only way to
 * un-skip is the "Add color instead" button on that surface, where the person
 * doing it can see what they are undoing.
 *
 * Extracted from the component because the rule is the interesting part and a
 * component in this repo cannot be rendered by the test suite (node env, no
 * DOM). The counts it returns are also what the on-screen message says, so the
 * message cannot drift from what actually happened.
 */

export type ApplyTargetLine = {
  id: string;
  /** Surfaces this line item actually has in scope. */
  surfaces: string[];
};

export type ApplyTargetPick = {
  colorId: string | null;
  skipped?: boolean;
};

export type ApplyTargets = {
  /** In scope, not skipped, no color yet — filled on a normal apply. */
  fill: string[];
  /** In scope, not skipped, holding a DIFFERENT color. Only an overwrite
   *  touches these; a room already using this very color is in neither list,
   *  because there is nothing to change. */
  differing: string[];
};

export function applyToAllTargets(input: {
  lineItems: ReadonlyArray<ApplyTargetLine>;
  /** Current picks, by line id then surface. */
  picks: Record<string, { picks: Record<string, ApplyTargetPick | undefined> } | undefined>;
  sourceLineId: string;
  surface: string;
  colorId: string;
}): ApplyTargets {
  const fill: string[] = [];
  const differing: string[] = [];
  for (const li of input.lineItems) {
    if (li.id === input.sourceLineId) continue;
    if (!li.surfaces.includes(input.surface)) continue;
    const cur = input.picks[li.id]?.picks[input.surface];
    // `!cur` is a surface the form never rendered a control for — not a
    // target, or the sweep would invent a pick for something out of scope.
    if (!cur) continue;
    if (cur.skipped) continue;
    if (!cur.colorId) fill.push(li.id);
    else if (cur.colorId !== input.colorId) differing.push(li.id);
  }
  return { fill, differing };
}

/**
 * Which finish a room should get when a color is applied INTO it.
 *
 * "Apply to all areas" carries the source row's finish along so each filled
 * surface lands complete. That was harmless while every room recommended the
 * same sheen. Once PPP's guide made the bathroom different (Satin on the
 * walls, 2026-09-22), applying a bathroom's color to the rest of the house
 * started carrying SATIN into every bedroom — a finish nobody chose, on rooms
 * the guide says should be Eggshell.
 *
 * So it turns on WHOSE answer the source finish is:
 *
 *   · the customer picked something themselves → it travels with the color,
 *     because it is a decision and applying it everywhere is what they asked
 *     for;
 *   · it is only what WE suggested for the source room → each target room gets
 *     its OWN suggestion instead.
 *
 * The target's product still decides: a finish it is not sold in is never
 * returned, and where the target has no suggestion at all the source's finish
 * is better than an empty box.
 */
export function finishForTarget(input: {
  /** What the source row currently holds. */
  sourceFinish: string | null;
  /** What PPP would have suggested for the SOURCE room + surface. */
  sourceSuggestion: string;
  /** What PPP suggests for the TARGET room + surface. */
  targetSuggestion: string;
  /** Finishes the target line's product is actually sold in. */
  targetSells: readonly string[];
}): string {
  const { sourceFinish, sourceSuggestion, targetSuggestion, targetSells } = input;
  const sourceIsSellable = !!sourceFinish && targetSells.includes(sourceFinish);
  const chosenByAPerson = !!sourceFinish && sourceFinish !== sourceSuggestion;
  if (chosenByAPerson && sourceIsSellable) return sourceFinish!;
  // Our own suggestion — re-ask per room. Falling back to the source's finish
  // keeps a surface from landing blank when the target has no suggestion.
  return targetSuggestion || (sourceIsSellable ? sourceFinish! : "");
}
