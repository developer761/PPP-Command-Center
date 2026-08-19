/**
 * The customer's colour picks, exactly as they entered them (R4.9 / R4.10).
 *
 * Salesforce can only hold four surfaces per line item — Walls, Ceiling, Trim,
 * Floor — plus ONE shared `ColorOther__c`. Everything else on the Surfaces
 * picklist (Cabinets, Door, Window, Closet, Shelves, Accent Wall) has to share
 * that single slot. So the moment a room has two of them, the Salesforce record
 * is lossy by construction:
 *
 *   WO 00306643 · Bathroom — Walls;Ceiling;Cabinets;Door
 *     ColorOther__c = null, both colours pushed into ColorNotes__c as text.
 *     Reading SF back gave "Cabinets —" and "Door —": blank.
 *
 *   WO 00308360 · Kitchen — Walls;Cabinets;Door
 *     Customer SKIPPED Cabinets and picked Super White for the Door.
 *     ColorOther__c = Super White. Reading SF back painted BOTH orphans
 *     Super White — including the one the customer opted out of.
 *
 * Neither is recoverable from Salesforce, so we stop trying. The Command Center
 * already retains the submitted payload verbatim in
 * `customer_form_tokens.submitted_payload`, and it carries every surface with
 * its own colour, finish and skip flag. That is the source of truth for display
 * and for ordering; the Salesforce write stays exactly as it is (Kate: "push
 * the information into Salesforce, but keep it stored in the Command Center
 * exactly as it was entered").
 *
 * Salesforce remains the fallback for line items nobody used the form on — a
 * rep typing colours straight into Salesforce still renders correctly.
 */

export type RetainedPick = {
  /** The label the customer saw: "Walls", "Cabinets", "Door". */
  surface: string;
  colorId: string | null;
  colorName: string | null;
  colorCode: string | null;
  finish: string | null;
  /** Customer chose "Don't paint this surface". */
  skipped: boolean;
};

/** The shape stored in customer_form_tokens.submitted_payload. */
type SubmittedPayloadLike = {
  lineItems?: Array<{
    id?: string;
    surfaces?: Array<{
      surface?: string;
      colorId?: string | null;
      colorName?: string | null;
      colorCode?: string | null;
      finish?: string | null;
      skipped?: boolean;
    }>;
  }>;
};

/**
 * Index a submitted payload by work-order-line-item id.
 *
 * Defensive throughout: this JSON was written by an older build of the form and
 * will be read by every future one. A malformed entry is dropped, never allowed
 * to throw — the alternative is a work-order page that 500s because one
 * historical submission had a null where a string was expected.
 */
export function retainedPicksByLine(
  payload: unknown
): Map<string, RetainedPick[]> {
  const out = new Map<string, RetainedPick[]>();
  const p = payload as SubmittedPayloadLike | null | undefined;
  if (!p || typeof p !== "object" || !Array.isArray(p.lineItems)) return out;
  for (const li of p.lineItems) {
    const id = typeof li?.id === "string" ? li.id : null;
    if (!id || !Array.isArray(li.surfaces)) continue;
    const picks: RetainedPick[] = [];
    for (const s of li.surfaces) {
      const surface = typeof s?.surface === "string" ? s.surface.trim() : "";
      if (!surface) continue;
      picks.push({
        surface,
        colorId: typeof s.colorId === "string" ? s.colorId : null,
        colorName: typeof s.colorName === "string" ? s.colorName : null,
        colorCode: typeof s.colorCode === "string" ? s.colorCode : null,
        finish: typeof s.finish === "string" ? s.finish : null,
        skipped: s.skipped === true,
      });
    }
    // An empty array is meaningful — it means "the form was submitted for this
    // line and nothing was picked" — but only record it when the line was
    // actually present, so callers can distinguish it from "no submission".
    out.set(id, picks);
  }
  return out;
}

/**
 * Has the customer answered for this surface at all?
 *
 * A retained pick with no colour and no skip is an unanswered surface, which
 * must NOT suppress the Salesforce fallback — otherwise a rep who filled a
 * colour in directly after a partial customer submission would see it vanish.
 */
export function pickIsAnswered(p: RetainedPick): boolean {
  return p.skipped || !!p.colorId;
}
