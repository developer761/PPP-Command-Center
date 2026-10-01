/**
 * PPP's finish reference — the table under "Recommended finishes by area or
 * surface" on the color form.
 *
 * Kate's wording, revised 2026-09-29 ("made some adjustments to the verbiage").
 * Short sentences, an Interior and an Exterior block, no sheen bars and no
 * column headings — the shape she sent, word for word.
 *
 * ONE ROW DECIDES BEHAVIOR, not just copy: Eggshell reads "Walls; bathroom
 * ceilings". That is the form's auto-fill for a bathroom ceiling too — see
 * recommended-finish.ts — because a table telling the customer one thing while
 * the dropdown above it defaults to another is the disagreement this whole
 * section was meant to end.
 *
 * The finish NAMES are the same strings the finish dropdowns offer — they come
 * from PPP's product data, not from here — so a customer reading "Satin" here
 * finds "Satin" in the picker. `finish-guide.test.ts` keeps that true.
 */

/**
 * Which blocks of the table this job should see (Kate 2026-10-01: "hide
 * interior finish options for exterior-only projects and vice-versa").
 *
 * Extracted from the component because the rule is the interesting part and a
 * component in this repo cannot be rendered by the suite (node env, no DOM) —
 * the same reason applyToAllTargets lives outside its component. It also means
 * the exterior-only case is provable without hunting for an exterior work
 * order to look at.
 *
 * A job with NO signal either way gets both blocks. That is the same fallback
 * filterMaterialTypesForWorkOrder takes, and the reason is that guessing wrong
 * here hides the half of the table the customer needed.
 */
export function finishGuideScope(hasInterior: boolean, hasExterior: boolean): {
  showInterior: boolean;
  showExterior: boolean;
} {
  return {
    showInterior: hasInterior || !hasExterior,
    showExterior: hasExterior || !hasInterior,
  };
}

export type FinishGuideRow = {
  /** The finish, exactly as the picker spells it. */
  finish: string;
  /** Where it goes. */
  where: string;
  /** What it looks like and how it behaves. */
  description: string;
  /**
   * A specific product PPP recommends for this finish, rendered under the
   * description as "Recommended Product: …" (Katie, 2026-10-01).
   *
   * Optional, and the label lives in the component rather than in the string,
   * so the next row to get one reads the same way without anybody retyping it.
   */
  product?: string;
};

/** The one-line explanation above both tables. */
export const FINISH_GUIDE_INTRO =
  "More shine means more durable and easier to clean. Less shine hides flaws better.";

export const INTERIOR_CAPTION = "Least shine to most";
export const EXTERIOR_CAPTION = "Two of these names you won't see indoors";

export const INTERIOR_FINISHES: readonly FinishGuideRow[] = [
  { finish: "Flat", where: "Ceilings in most rooms", description: "No shine. Hides flaws best. Hardest to clean." },
  { finish: "Matte", where: "Interior walls", description: "Barely any shine. Hides flaws; tougher than flat." },
  { finish: "Eggshell", where: "Walls; bathroom ceilings", description: "Slight shine. Hides most flaws. Cleans easily." },
  // Katie, 2026-10-01. Two small departures from her text, both flagged to
  // Karan: she wrote "suites smooth surfaces" (kept as "suits", the word she
  // meant) and "Wipes Clean" mid-sentence (kept lowercase, so the row matches
  // the sentence case of every other row in the table).
  {
    finish: "Satin",
    where: "Bathrooms, kitchens, cabinets",
    description: "Noticeable shine. Wipes clean; suits smooth surfaces.",
    // Katie's wording, 2026-10-01 (second pass): the surfaces lead, the
    // reason is parenthetical, and the product lands last.
    product: "Recommended product for walls and ceilings (resists mold and mildew): Kitchen & Bath",
  },
  { finish: "Semi-Gloss", where: "Trim, doors, cabinets", description: "Shiny and easy to clean. Highlights trim detail." },
  // Gloss removed 2026-10-01 (Kate, "remove Gloss to simplify options") and
  // withdrawn from the picker in the same breath — see RETIRED_FINISHES in
  // material-types.ts. The table and the dropdown have to shrink together, or
  // this section starts recommending a sheen the customer cannot select.
];

export const EXTERIOR_FINISHES: readonly FinishGuideRow[] = [
  { finish: "Flat", where: "Stucco", description: "No shine. The usual choice for stucco." },
  { finish: "Low Lustre", where: "Exterior siding", description: "Low shine. The usual choice for siding." },
  { finish: "Soft Gloss", where: "Exterior trim, soffits, doors", description: "More shine. Makes trim stand out from siding." },
];
