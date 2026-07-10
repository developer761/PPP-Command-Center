/**
 * Phase C · Documents — category enum.
 *
 * Free-form label attached to each document on upload. "other" is the
 * fallback so the picker never blocks upload on classification anxiety.
 *
 * Categories are shared across parent types (opportunity + project).
 * If Phase H surfaces need a project-only category (e.g. "warranty"),
 * add it here; the DB column is TEXT so no migration needed.
 */

export const DOCUMENT_CATEGORIES = [
  "bid_set",           // plans + specs bundle from the GC
  "rfi",               // requests for information
  "meeting_minutes",   // kickoff / pre-con / OAC recap
  "permit",            // site + trade permits
  "insurance",         // per-job COI (distinct from account-level insurance)
  "contract",          // signed contracts, change orders
  "site_photo",        // pre-existing conditions, progress, punch
  "correspondence",    // letters, emails saved as PDF
  "other",             // fallback
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export function documentCategoryLabel(cat: DocumentCategory | string): string {
  switch (cat) {
    case "bid_set": return "Bid Set (Plans + Specs)";
    case "rfi": return "RFI";
    case "meeting_minutes": return "Meeting Minutes";
    case "permit": return "Permit";
    case "insurance": return "Insurance (per-job)";
    case "contract": return "Contract";
    case "site_photo": return "Site Photo";
    case "correspondence": return "Correspondence";
    case "other": return "Other";
    default: return cat;
  }
}

export function isValidDocumentCategory(cat: string): cat is DocumentCategory {
  return (DOCUMENT_CATEGORIES as readonly string[]).includes(cat);
}
