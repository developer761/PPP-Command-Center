import type { RetainedPick } from "@/lib/customer-form/retained-picks";

/**
 * Which source names the color for one surface of one room — and which one
 * merely disagrees.
 *
 * THE CUSTOMER'S PICK WINS (Karan, 2026-09-18: "the customer wins for color").
 *
 * Rooms & Colors used to let Salesforce win for the four standard surfaces, so
 * that a rep correcting a color in Salesforce after the customer submitted was
 * not masked. But the ORDER and the VENDOR EMAIL have always read the
 * customer's payload first — so the rep's correction showed on the screen
 * while the vendor was sent the customer's original, and nothing anywhere said
 * the two disagreed. A screen describing paint nobody is going to buy is worse
 * than a screen that shows the order.
 *
 * The correction is not discarded: when Salesforce names a different color,
 * `salesforceColorId` carries it so the chip can say so. Shown, not used.
 *
 * Why this lives in lib/ rather than inside the component: the rule it encodes
 * had a test that read `components/materials-view.tsx` as TEXT and asserted on
 * the source of the function below. That test could only ever pin the shape of
 * the code, never its answer — and when the rule was reversed it failed for the
 * wrong reason, saying nothing about whether the new rule worked.
 */
export type ColorSource = "skipped" | "customer" | "notes" | "salesforce" | "none";

export type SurfaceAnswer = {
  source: ColorSource;
  /** Set when the answer came from the customer or Salesforce. */
  colorId: string | null;
  /** Set when the answer came from the customer or from Color Notes — the
   *  color may no longer be in the catalog, and this is all we have. */
  colorName: string | null;
  colorCode: string | null;
  finish: string | null;
  /** Salesforce's color, when it names a DIFFERENT one than the answer above.
   *  A rep's later correction, or a stale record after a failed writeback. */
  salesforceColorId: string | null;
};

export function resolveSurfaceColor(input: {
  /** The customer's own pick for this surface, kept verbatim (R4.9/R4.10). */
  retained?: RetainedPick | null;
  /** Parsed out of ColorNotes__c — submissions from before the payload was
   *  retained have nowhere else to keep an orphan surface's color. */
  fromNotes?: { colorName: string; colorCode: string | null; finish: string | null } | null;
  /** What this surface's Salesforce field holds. */
  salesforceColorId?: string | null;
  salesforceFinish?: string | null;
}): SurfaceAnswer {
  const { retained, fromNotes } = input;
  const sfId = input.salesforceColorId ?? null;
  const sfFinish = input.salesforceFinish ?? null;

  // A skip is an ANSWER, and Salesforce has no way to record one — a blank
  // field there is indistinguishable from "nobody has picked yet". This is
  // what painted Super White onto the Kitchen cabinets the customer had
  // explicitly opted out of (WO 00308360).
  if (retained?.skipped) {
    return { source: "skipped", colorId: null, colorName: null, colorCode: null, finish: null, salesforceColorId: null };
  }

  if (retained && retained.colorId) {
    return {
      source: "customer",
      colorId: retained.colorId,
      colorName: retained.colorName,
      colorCode: retained.colorCode,
      finish: retained.finish,
      salesforceColorId: sfId && sfId !== retained.colorId ? sfId : null,
    };
  }

  if (fromNotes) {
    return {
      source: "notes",
      colorId: null,
      colorName: fromNotes.colorName,
      colorCode: fromNotes.colorCode,
      finish: fromNotes.finish,
      salesforceColorId: sfId,
    };
  }

  // Nobody used the form on this line — a rep typing colors straight into
  // Salesforce still renders, which is the majority of older work orders.
  if (sfId) {
    return { source: "salesforce", colorId: sfId, colorName: null, colorCode: null, finish: sfFinish, salesforceColorId: null };
  }

  return { source: "none", colorId: null, colorName: null, colorCode: null, finish: sfFinish, salesforceColorId: null };
}
