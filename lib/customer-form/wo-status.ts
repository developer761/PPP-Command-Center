// Types + a pure roll-up only — no data access left in this file since the
// duplicate loader was removed (see the note below).

/**
 * Connects the customer-form pipeline back into the dashboard. For a given
 * set of Work Order IDs, returns the most recent token's lifecycle state per
 * WO so the Materials Ordering page can show:
 *
 *   ✓ Submitted   — customer picked colors, ready for materials order
 *   👁 Opened     — customer clicked the link but hasn't submitted yet
 *   📨 Sent       — email delivered, no open yet
 *   ⏳ Expired    — token past its 30-day window
 *   —             — no form sent for this WO yet
 *
 * One row per WO (the MOST RECENT token, since admin can re-send). The
 * status is derived purely from the customer_form_tokens columns set during
 * the lifecycle (sent_at / opened_at / submitted_at / expires_at).
 */

/** R4.5: the "Colors needed by" date the sender chose (YYYY-MM-DD), so the
 *  work-order page can show what was set instead of leaving them to guess.
 *  Null when the sender left it blank — which is the majority, since 68% of
 *  work orders at Coordination/Scheduling have no start date to default from. */
type WithDeadline = {
  colorDeadline?: string | null;
  /** R4.5: when the LINK actually stops working. Distinct from the deadline —
   *  the sender leaves "Colors needed by" blank on most sends (68% of work
   *  orders at Coordination/Scheduling have no start date to default from), and
   *  the link still expires. Showing only the deadline would have answered
   *  "what date did I set?" with nothing on the majority of jobs. */
  expiresAt?: string | null;
};

export type FormStatus =
  | { status: "none"; woId: string }
  | ({ status: "sent"; woId: string; token: string; sentAt: string | null; formUrl: string } & WithDeadline)
  | ({ status: "opened"; woId: string; token: string; sentAt: string | null; openedAt: string; formUrl: string } & WithDeadline)
  | ({ status: "submitted"; woId: string; token: string; sentAt: string | null; openedAt: string | null; submittedAt: string; formUrl: string } & WithDeadline)
  | ({ status: "expired"; woId: string; token: string; sentAt: string | null; openedAt: string | null; expiredAt: string; formUrl: string } & WithDeadline);



/*
 * `getFormStatusByWO` used to live here — a SECOND loader producing FormStatus,
 * alongside the one in lib/materials-page-data.ts. It had no callers left; it
 * was removed rather than left sitting because a duplicate loader is not inert.
 *
 * Round 3 #02/#03 was exactly this: attribution was added to one of the two
 * progress loaders and not the other, so the page Kate actually tested kept
 * reading "Customer Submitted" while the code looked correct. This file would
 * have been the next instance — it built FormStatus WITHOUT `colorDeadline` or
 * `expiresAt` (R4.5), so reinstating it would silently blank both dates on the
 * work-order page with nothing to grep for.
 *
 * lib/materials-page-data.ts#getMaterialsPageAuxData is the single loader. If a
 * second one is ever genuinely needed, add a parity test alongside
 * __tests__/wo-progress/loader-parity.test.ts first.
 */

/** Roll-up counts across all WOs — used for the page-level summary chip. */
export function summarizeStatuses(statuses: Iterable<FormStatus>): {
  none: number;
  sent: number;
  opened: number;
  submitted: number;
  expired: number;
  total: number;
} {
  const summary = { none: 0, sent: 0, opened: 0, submitted: 0, expired: 0, total: 0 };
  for (const s of statuses) {
    summary[s.status] += 1;
    summary.total += 1;
  }
  return summary;
}
