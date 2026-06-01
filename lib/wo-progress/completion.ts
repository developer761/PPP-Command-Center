/**
 * Derive the Job Complete stage from a Salesforce Work Order's Status.
 * PPP uses these status strings to mean "the job is done":
 *   - "Complete Paid in Full"
 *   - "Paid in Full"
 *   - Any value containing "complete" or "paid in full"
 *
 * Cancelled / voided / abandoned WOs are NOT complete — they just aren't
 * active. Returns null for those so the progress bar shows it as
 * unfinished rather than "✓ done."
 *
 * The timestamp returned is the WO's CloseDate (which PPP populates when the
 * WO is closed out). Callers can swap to LastModifiedDate if CloseDate is
 * null but status indicates complete.
 */

export type CompletionInput = {
  status: string | null;
  closeDate: string | null;
};

/** True when the WO status indicates a SUCCESSFUL completion (paid + closed),
 *  not a cancellation/void/abandonment. */
export function isJobComplete(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  if (s.includes("cancel") || s.includes("void") || s.includes("abandon")) return false;
  return s.includes("complete") || s.includes("paid in full");
}

/** Stamps the jobCompletedAt timestamp from CloseDate when the status
 *  indicates the WO is complete. Falls back to null when not complete or
 *  when the close date isn't populated yet. */
export function getJobCompletedAt(wo: CompletionInput): string | null {
  if (!isJobComplete(wo.status)) return null;
  return wo.closeDate ?? null;
}
