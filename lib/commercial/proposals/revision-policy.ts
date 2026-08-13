/**
 * When may a proposal be revised?
 *
 * Karan 2026-08-13, from Stephanie's review: *"do not automatically create a
 * revision every time the proposal is accessed until after the proposal is
 * sent."* Kim works on the original until the GC has seen it; a revision
 * exists because the GC asked for a change, not because someone opened a page.
 *
 * Pulled out of the /proposal/new route so the rule can be tested. The route
 * mutates on GET, which means a bookmark, a browser-back or a hand-typed
 * ?bump= would otherwise mint an R2 on an untouched draft and split the work
 * across two rows with nobody able to say which is live.
 */

export type RevisableProposal = {
  sent_at?: string | null;
  status?: string | null;
};

/**
 * Statuses that mean the proposal left the building. `sent` is the obvious
 * one; the rest are terminal states a proposal can only reach by having gone
 * out first, and each is included deliberately:
 *
 *  - won / lost      — the GC responded, so they saw it
 *  - superseded      — an earlier revision, already replaced
 *  - expired         — a sent proposal that timed out
 */
const WENT_OUT_STATUSES = new Set(["sent", "won", "lost", "superseded", "expired"]);

/** True once the GC has seen it — the point a revision starts making sense. */
export function proposalWentOut(p: RevisableProposal | null | undefined): boolean {
  if (!p) return false;
  // `sent_at` is the fact; status is the label. Either alone is enough, because
  // a proposal emailed and then dragged back to draft has still been seen.
  if (p.sent_at) return true;
  return WENT_OUT_STATUSES.has(p.status ?? "");
}

/** Whether a "make a revision" request should be honoured. */
export function mayCreateRevision(parent: RevisableProposal | null | undefined): boolean {
  return proposalWentOut(parent);
}
