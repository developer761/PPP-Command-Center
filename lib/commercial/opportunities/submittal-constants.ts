/**
 * Submittal-feature constants — enum types + status DAG.
 *
 * Mirror of constants.ts pattern for opportunity status: a single source of
 * truth for valid values + transitions, used by both the DB CHECK
 * constraints (migration 041) and the lib-layer guards. UI components
 * import the labels via a separate helper to avoid bundling server-only
 * libs into client components.
 */

// ─── Status ───────────────────────────────────────────────────────

export const SUBMITTAL_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "approved_as_noted",
  "revise_and_resubmit",
  "rejected",
  "closed",
  "voided",
] as const;

export type SubmittalStatus = typeof SUBMITTAL_STATUSES[number];

/** Statuses where the submittal can no longer be edited (items locked). */
export const TERMINAL_SUBMITTAL_STATUSES: ReadonlySet<SubmittalStatus> = new Set([
  "approved",
  "approved_as_noted",
  "rejected",
  "closed",
  "voided",
]);

export function isTerminalSubmittalStatus(s: string | null | undefined): boolean {
  return !!s && TERMINAL_SUBMITTAL_STATUSES.has(s as SubmittalStatus);
}

/**
 * Allowed status transitions. Mirror of ALLOWED_TRANSITIONS in
 * opportunities/constants.ts. Enforced server-side in
 * `lib/commercial/opportunities/submittals.ts:changeSubmittalStatus`.
 *
 * draft → submitted → under_review → (4 response branches) → closed
 * any non-closed → voided (sent in error)
 * revise_and_resubmit / rejected → closed (revision created as new row)
 */
export const ALLOWED_SUBMITTAL_TRANSITIONS: Record<SubmittalStatus, ReadonlyArray<SubmittalStatus>> = {
  draft: ["submitted", "voided"],
  submitted: ["under_review", "voided"],
  under_review: [
    "approved",
    "approved_as_noted",
    "revise_and_resubmit",
    "rejected",
    "voided",
  ],
  approved: ["closed"],
  approved_as_noted: ["closed"],
  revise_and_resubmit: ["closed"],
  rejected: ["closed"],
  closed: [],   // terminal
  voided: [],   // terminal
};

// ─── Transmitted-as (the "THESE ARE TRANSMITTED" radio on the cover) ───

export const TRANSMITTED_AS_OPTIONS = [
  "for_approval",
  "for_your_use",
  "as_requested",
  "for_review",
  "for_bids",
  "prints_returned",
] as const;

export type TransmittedAs = typeof TRANSMITTED_AS_OPTIONS[number];

// ─── Response (what the GC sent back) ────────────────────────────────

export const SUBMITTAL_RESPONSES = [
  "approved",
  "approved_as_noted",
  "returned_for_corrections",
  "resubmit",
  "submit_for_distribution",
  "return_corrected_prints",
] as const;

export type SubmittalResponse = typeof SUBMITTAL_RESPONSES[number];

// ─── Included kinds (the "WE ARE SENDING YOU" checkboxes on the cover) ───

export const INCLUDED_KINDS = [
  "shop_drawings",
  "prints",
  "plans",
  "samples",
  "specifications",
  "submittals",
  "copy_of_letter",
  "change_order",
  "contracts",
] as const;

export type IncludedKind = typeof INCLUDED_KINDS[number];

// ─── Finish types (paint vs stain vs sealer etc.) ────────────────────

export const FINISH_TYPES = [
  "paint",
  "wood_stain",
  "primer",
  "sealer",
  "specialty",
] as const;

export type FinishType = typeof FINISH_TYPES[number];

// ─── Display labels (used in both server + client components) ────────

export function submittalStatusLabel(s: SubmittalStatus | string): string {
  switch (s) {
    case "draft": return "Draft";
    case "submitted": return "Submitted";
    case "under_review": return "Under Review";
    case "approved": return "Approved";
    case "approved_as_noted": return "Approved as Noted";
    case "revise_and_resubmit": return "Revise & Resubmit";
    case "rejected": return "Rejected";
    case "closed": return "Closed";
    case "voided": return "Voided";
    default: return s;
  }
}

export function transmittedAsLabel(t: TransmittedAs | string): string {
  switch (t) {
    case "for_approval": return "For approval";
    case "for_your_use": return "For your use";
    case "as_requested": return "As requested";
    case "for_review": return "For review and comment";
    case "for_bids": return "For bids due";
    case "prints_returned": return "Prints returned after loan to us";
    default: return t;
  }
}

export function submittalResponseLabel(r: SubmittalResponse | string): string {
  switch (r) {
    case "approved": return "Approved as submitted";
    case "approved_as_noted": return "Approved as noted";
    case "returned_for_corrections": return "Returned for corrections";
    case "resubmit": return "Resubmit copies for approval";
    case "submit_for_distribution": return "Submit copies for distribution";
    case "return_corrected_prints": return "Return corrected prints";
    default: return r;
  }
}

export function includedKindLabel(k: IncludedKind | string): string {
  switch (k) {
    case "shop_drawings": return "Shop drawings";
    case "prints": return "Prints";
    case "plans": return "Plans";
    case "samples": return "Samples";
    case "specifications": return "Specifications";
    case "submittals": return "Submittals";
    case "copy_of_letter": return "Copy of letter";
    case "change_order": return "Change order";
    case "contracts": return "Contracts";
    default: return k;
  }
}

export function finishTypeLabel(t: FinishType | string): string {
  switch (t) {
    case "paint": return "Paint";
    case "wood_stain": return "Wood stain";
    case "primer": return "Primer";
    case "sealer": return "Sealer";
    case "specialty": return "Specialty";
    default: return t;
  }
}

// ─── Status pill color tone (mirrors opportunity status pill helpers) ─

export function submittalStatusTone(s: SubmittalStatus | string):
  "neutral" | "sky" | "amber" | "emerald" | "rose" | "charcoal" {
  switch (s) {
    case "draft": return "neutral";
    case "submitted": return "sky";
    case "under_review": return "sky";
    case "approved": return "emerald";
    case "approved_as_noted": return "emerald";
    case "revise_and_resubmit": return "amber";
    case "rejected": return "rose";
    case "closed": return "charcoal";
    // Voided uses ROSE (not charcoal) — sent-in-error needs to read
    // visually distinct from "successfully closed". Lines up with the
    // PDF VOIDED watermark + the void-action button tone. Audit UI H1
    // (2026-06-30).
    case "voided": return "rose";
    default: return "neutral";
  }
}
