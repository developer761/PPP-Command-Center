/**
 * Surface → Salesforce field mapping for the customer color form.
 *
 * Source of truth: Kate's 2026-07-09 "Command Center → Salesforce:
 * color/finish writeback spec" (~/Desktop/karan-mapping-outline.md). Kept as a
 * standalone module (not inline in the submit route) so the rules are unit-
 * testable and the route handler stays readable.
 *
 * Rules:
 *  §1 Standard surfaces (Walls, Ceiling, Trim, Floor) each have their own
 *     dedicated ColorX__c + FinishX__c fields on the WorkOrderLineItem.
 *  §1 Orphan surfaces (Cabinets, Accent Wall, Door, Window, Closet, Shelves)
 *     have NO dedicated field and route to the shared Other fields.
 *  §2 Per WOLI: exactly 1 orphan → color+finish to ColorOther__c/FinishOther__c;
 *     2+ orphans → all orphan picks to ColorNotes__c text, Other left blank.
 *  §3 Finish label → SF picklist value (Semi-Gloss → "Semigloss"); choices
 *     with no SF value (High-Gloss, legacy combined) → null. Never guess.
 */

/**
 * Standard surfaces have their own dedicated SF color + finish fields.
 * Keyed by the lowercased surface label from Surfaces__c.
 */
export const STANDARD_SURFACE_FIELDS: Record<string, { color: string; finish: string }> = {
  walls: { color: "ColorWall__c", finish: "FinishWall__c" },
  wall: { color: "ColorWall__c", finish: "FinishWall__c" },
  ceiling: { color: "ColorCeiling__c", finish: "FinishCeiling__c" },
  trim: { color: "ColorTrim__c", finish: "FinishTrim__c" },
  floor: { color: "ColorFloor__c", finish: "FinishFloor__c" },
};

/**
 * Orphan surfaces have NO dedicated SF color/finish field — they route to the
 * shared ColorOther__c / FinishOther__c (1 orphan) or ColorNotes__c (2+).
 * Keyed by lowercased Surfaces__c label, plus a few defensive singulars and a
 * literal "other" (which naturally lands in the Other field when it's alone).
 */
export const ORPHAN_SURFACES = new Set([
  "cabinets",
  "cabinet",
  "accent wall",
  "door",
  "window",
  "closet",
  "shelves",
  "shelf",
  "other",
]);

/** How a submitted surface routes to Salesforce. */
export type SurfaceKind =
  | { kind: "standard"; color: string; finish: string }
  | { kind: "orphan" }
  | { kind: "unknown" };

/** Classify a raw surface label (case/space-insensitive) for routing. */
export function classifySurface(surface: string): SurfaceKind {
  const key = surface.toLowerCase().trim();
  const std = STANDARD_SURFACE_FIELDS[key];
  if (std) return { kind: "standard", color: std.color, finish: std.finish };
  if (ORPHAN_SURFACES.has(key)) return { kind: "orphan" };
  return { kind: "unknown" };
}

/**
 * Map a customer-picked finish label (FINISH_OPTIONS in customer-form-view) to
 * its Salesforce picklist value (§3):
 *   - Semi-Gloss → "Semigloss" (SF stores it as one word)
 *   - High-Gloss → no SF picklist value → null (never guess a finish)
 *   - legacy combined labels (Flat / Matte, Gloss / High-Gloss) → null
 * Returns null for anything without a clean SF match so the caller leaves the
 * finish field empty rather than writing an invalid picklist value.
 */
export function normalizeFinishToSf(finish: string | null | undefined): string | null {
  if (!finish || typeof finish !== "string") return null;
  switch (finish.trim().toLowerCase()) {
    case "eggshell":
      return "Eggshell";
    case "satin":
      return "Satin";
    case "flat":
      return "Flat";
    case "matte":
      return "Matte";
    case "gloss":
      return "Gloss";
    case "semi-gloss":
      return "Semigloss";
    // High-Gloss + legacy combined labels have no SF picklist value.
    default:
      return null;
  }
}

/**
 * Reverse of normalizeFinishToSf: map a Salesforce finish picklist value back
 * to the form's FINISH_OPTIONS label so a SF-seeded finish (#14) matches a
 * dropdown <option>. Critically, SF stores Semi-Gloss as the one-word
 * "Semigloss" — seeding that verbatim left the <select> unmatched AND made
 * submit reject it as an invalid finish. Returns null for any value that has
 * no matching form option (so we seed a valid option or nothing at all).
 */
export function denormalizeFinishFromSf(sfFinish: string | null | undefined): string | null {
  if (!sfFinish || typeof sfFinish !== "string") return null;
  switch (sfFinish.trim().toLowerCase()) {
    case "flat":
      return "Flat";
    case "matte":
      return "Matte";
    case "eggshell":
      return "Eggshell";
    case "satin":
      return "Satin";
    case "semigloss":
    case "semi-gloss":
      return "Semi-Gloss";
    case "gloss":
      return "Gloss";
    case "high-gloss":
    case "highgloss":
      return "High-Gloss";
    default:
      return null;
  }
}
