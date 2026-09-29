/**
 * "Choosing Your Paint Finish" — PPP's finish table, as the customer reads it.
 *
 * Kate, 2026-09-29: instead of suggesting a finish on every surface, the color
 * form carries one collapsible section, "Recommended finishes by area or
 * surface", holding the table from her mockup. Her doc's own title and
 * subtitle are deliberately left out — the section has its own heading on the
 * page.
 *
 * Copy is Mac's, reproduced word for word, with one change: the trim row's
 * "crown mou1ding" is spelled the American way, molding (Karan, 2026-09-29).
 *
 * The finish NAMES are the same strings the finish dropdowns offer — they come
 * from PPP's product data, not from here — so a customer reading "Satin" in
 * this table finds "Satin" in the picker. `finish-guide-matches-picker.test.ts`
 * is what keeps that true.
 */

export type FinishGuideRow = {
  /** The finish, exactly as the picker spells it. */
  finish: string;
  /** Where it sits on the light-reflected scale, 1 (least) to 7 (most). Drives
   *  the little bar; it is a RANKING, not a measurement of gloss units. */
  sheen: number;
  /** "What it looks like" — omitted on the exterior rows, which pair a place
   *  with a reason instead. */
  looksLike?: string;
  /** The bolded lead on an exterior row: the surface it belongs on. */
  place?: string;
  /** "Where it usually goes". */
  where: string;
};

/** Interior — ordered from least light reflected to most. */
export const INTERIOR_FINISHES: readonly FinishGuideRow[] = [
  { finish: "Flat", sheen: 1, looksLike: "No shine at any angle.", where: "Ceilings in living rooms, bedrooms and hallways." },
  { finish: "Matte", sheen: 2, looksLike: "Very low sheen, a little more depth.", where: "Walls in main living areas." },
  { finish: "Eggshell", sheen: 3, looksLike: "A gentle softness to the light.", where: "Walls in main living areas — most common." },
  { finish: "Pearl", sheen: 4, looksLike: "A quiet glow.", where: "Busier rooms and hallways." },
  {
    finish: "Satin", sheen: 5, looksLike: "Smooth and slightly reflective.",
    where: "Bathrooms and kitchens — rooms that run damp and get cleaned often. Sometimes trim.",
  },
  { finish: "Semi-Gloss", sheen: 6, looksLike: "Crisp and clearly reflective.", where: "Trim, doors, baseboards and crown molding." },
  { finish: "Gloss", sheen: 7, looksLike: "Hard and near-mirror.", where: "A feature door or standout millwork." },
];

/** Exterior — two of these names are never seen indoors. */
export const EXTERIOR_FINISHES: readonly FinishGuideRow[] = [
  { finish: "Flat", sheen: 1, place: "Stucco.", where: "Keeps a heavily textured surface reading evenly rather than catching shine." },
  { finish: "Low Lustre", sheen: 3, place: "Siding.", where: "A soft sheen that keeps a large surface even rather than shiny." },
  {
    finish: "Soft Gloss", sheen: 6, place: "Trim, soffits, doors and detailed millwork.",
    where: "More reflective; sets trim apart from the siding.",
  },
];

/** The most light any row claims — the denominator for the sheen bar, so
 *  adding a finish at the top of the scale cannot silently overflow it. */
export const SHEEN_MAX = 7;
