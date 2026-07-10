/**
 * Phase C · Documents — status DAG.
 *
 * Draft is the default on upload. Users push through pending_review
 * for approval. Rejected can loop back to draft for revision. Once a
 * new version is uploaded (parent_document_id chain), the OLD version
 * is auto-set to superseded — that's a terminal state set only by the
 * version-bump path (users cannot manually flip to superseded).
 *
 *   draft ──▶ pending_review ──▶ approved
 *      ▲               │
 *      │               └──▶ rejected ──▶ draft (loop back)
 *      │
 *   [any of the above, when a new version arrives] ──▶ superseded (terminal)
 */

export const DOCUMENT_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "superseded",
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * User-facing transitions. Superseded is NOT in this map — it's set
 * exclusively by the version-bump path in db.ts.
 */
const ALLOWED_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  draft: ["pending_review"],
  pending_review: ["approved", "rejected"],
  approved: [],
  rejected: ["draft"],
  superseded: [],
};

export function documentStatusLabel(s: DocumentStatus | string): string {
  switch (s) {
    case "draft": return "Draft";
    case "pending_review": return "Pending review";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "superseded": return "Superseded";
    default: return s;
  }
}

export function allowedNextDocumentStatuses(current: DocumentStatus): DocumentStatus[] {
  return ALLOWED_TRANSITIONS[current] ?? [];
}

export function canTransitionDocumentStatus(
  from: DocumentStatus,
  to: DocumentStatus
): boolean {
  return allowedNextDocumentStatuses(from).includes(to);
}

export function isTerminalDocumentStatus(s: DocumentStatus): boolean {
  return s === "approved" || s === "superseded";
}
