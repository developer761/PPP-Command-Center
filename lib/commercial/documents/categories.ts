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
  // Phase F.4 (2026-07-14): Alex clicks Send in the Proposal Builder →
  // the customer-view PDF snapshots as a Document with this category so
  // it lives alongside plans/permits/etc. Favorited on create so it
  // pins to the top of the Files tab.
  "proposal",
  // Phase D (2026-08): per-tool document buckets so each delivery tool's docs
  // (uploaded +, later, auto-collected PDFs) group under it in the deal's
  // Project sub-tab AND roll up to the deal Documents tab.
  "change_order",      // signed change orders + their backup
  "aia_billing",       // G702/G703 applications + exports
  "submittal",         // transmittals + shop drawings / product data
  "closeout",          // closeout package: as-builts, O&M, waivers, warranty
  "work_order",        // R2: crew work order (scope + room-finish schedule PDF)
  "lien_waiver",       // partial/final lien waivers — stored (never generated)
  // Phase 2 (2026-08): the cost + attachment spine.
  "receipt",           // material/labor/sub purchase receipts (job cost backup)
  "invoice_attachment",// arbitrary files attached to a specific invoice
  // Compliance we PROVIDE to the GC (Stephanie 2026-08-13): "COI's, W-9,
  // Master Service Agreement, Vendor On Boarding, Safety/OSHA is all for if we
  // were hiring a subcontractor. In this instance where we are creating a
  // proposal, technically we are the subcontractor. All this information
  // should be in the opportunity for when we provide it to the GC."
  //
  // This is the other half of a change Brendan already made: he retired those
  // same categories from the ACCOUNT on 2026-08-12 ("the only thing for the
  // account level really would be prequal questionnaire"). They agree — the
  // account stopped collecting them, and the job now carries them.
  //
  // Per-job COI already existed above as `insurance`.
  "w9",                // our W-9, sent to the GC's AP department
  "master_agreement",  // MSA / subcontract agreement signed with this GC
  "safety",            // site safety plan, OSHA certs, toolbox talks
  "prequal",           // prequal questionnaire completed FOR this job
  "other",             // fallback
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export function documentCategoryLabel(cat: DocumentCategory | string): string {
  switch (cat) {
    case "bid_set": return "Bid Set (Plans + Specs)";
    case "rfi": return "RFI";
    case "meeting_minutes": return "Meeting Minutes";
    case "permit": return "Permit";
    case "insurance": return "Certificate of Insurance (COI)";
    case "contract": return "Contract";
    case "site_photo": return "Site Photo";
    case "correspondence": return "Correspondence";
    case "proposal": return "Proposal";
    case "change_order": return "Change Order";
    case "aia_billing": return "AIA Billing";
    case "submittal": return "Submittal";
    case "closeout": return "Closeout";
    case "work_order": return "Work Order";
    case "lien_waiver": return "Lien Waiver";
    case "receipt": return "Receipt";
    case "invoice_attachment": return "Invoice Attachment";
    case "w9": return "W-9";
    case "master_agreement": return "Master Service Agreement";
    case "safety": return "Safety / OSHA";
    case "prequal": return "Prequal Questionnaire";
    case "other": return "Other";
    default: return cat;
  }
}

export function isValidDocumentCategory(cat: string): cat is DocumentCategory {
  return (DOCUMENT_CATEGORIES as readonly string[]).includes(cat);
}
