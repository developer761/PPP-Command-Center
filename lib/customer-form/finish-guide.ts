/**
 * PPP's "Finish Quick Reference" — the table the color form shows under
 * "Recommended finishes by area or surface".
 *
 * Kate, 2026-09-29: "this is the original table — I just want it to be simple
 * like this, and it's much more compact." So this is the quick-reference block
 * from the back of the finishes guide rather than the long Interior/Exterior
 * version: three columns, seven rows, no sheen scale.
 *
 * Copy is PPP's own, word for word.
 *
 * The finish NAMES are the same strings the finish dropdowns offer — they come
 * from PPP's product data, not from here — so a customer reading "Satin" in
 * this table finds "Satin" in the picker. `finish-guide.test.ts` keeps that
 * true.
 */

export type FinishGuideRow = {
  /** The finish, exactly as the picker spells it. */
  finish: string;
  /** "Typical Use". */
  typicalUse: string;
  /** "General Characteristics". */
  characteristics: string;
};

export const FINISH_QUICK_REFERENCE: readonly FinishGuideRow[] = [
  {
    finish: "Flat",
    typicalUse: "Main-area ceilings",
    characteristics: "Very low sheen; helps hide minor surface imperfections.",
  },
  {
    finish: "Matte",
    typicalUse: "Interior walls",
    characteristics: "Low sheen; soft, understated appearance.",
  },
  {
    finish: "Eggshell",
    typicalUse: "Interior walls",
    characteristics: "Low-to-moderate sheen; common balance of appearance and cleanability.",
  },
  {
    finish: "Satin",
    typicalUse: "Bathrooms; trim",
    characteristics: "Moderate sheen; durable and easier to clean.",
  },
  {
    finish: "Semi-Gloss",
    typicalUse: "Trim, doors, baseboards, crown",
    characteristics: "Higher sheen; durable, washable and the PPP-preferred trim option.",
  },
  {
    finish: "Low Lustre",
    typicalUse: "Exterior siding",
    characteristics: "Subtle exterior sheen; PPP's typical siding recommendation.",
  },
  {
    finish: "Soft Gloss",
    typicalUse: "Exterior trim & soffits",
    characteristics: "Higher exterior sheen; typically used to highlight and protect trim details.",
  },
];
