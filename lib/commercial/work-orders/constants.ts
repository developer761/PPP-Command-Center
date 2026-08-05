/**
 * Work Order constants (R2, post-contract). Client-safe: no server imports, so
 * the UI + status logic can be unit-tested without a DB.
 *
 * A Work Order is the crew's marching-orders sheet — scope pulled from the
 * accepted proposal + the Room Finish Schedule. The row states are draft / sent
 * / voided; the cross-account queue also shows "not created" when no live row
 * exists for an opportunity.
 */

export const WORK_ORDER_STATUSES = ["draft", "sent", "voided"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/** Includes the synthetic "not_created" used only by the cross-account index
 *  (there's no row for it). */
export type WorkOrderQueueState = WorkOrderStatus | "not_created";

export const WORK_ORDER_STATUS_META: Record<
  WorkOrderQueueState,
  { label: string; tone: "charcoal" | "ppp-blue" | "emerald" | "rose" }
> = {
  not_created: { label: "Not created", tone: "charcoal" },
  draft: { label: "Draft", tone: "charcoal" },
  sent: { label: "Sent to Field Ops", tone: "emerald" },
  voided: { label: "Voided", tone: "rose" },
};

/** DAG. draft → sent; any non-terminal → voided. A sent WO can be re-opened to
 *  draft (to regenerate after a change), mirroring how proposals/closeouts allow
 *  a controlled step back. */
export const ALLOWED_WORK_ORDER_TRANSITIONS: Record<
  WorkOrderStatus,
  ReadonlyArray<WorkOrderStatus>
> = {
  draft: ["sent", "voided"],
  sent: ["draft", "voided"],
  voided: [], // terminal
};

/** Only a draft is freely editable (notes / assignment / scheduled date). Once
 *  sent, the WO is frozen behind its snapshot PDF — re-open to draft to change
 *  it, which invalidates the sent state. */
export function isWorkOrderEditable(status: WorkOrderStatus): boolean {
  return status === "draft";
}
