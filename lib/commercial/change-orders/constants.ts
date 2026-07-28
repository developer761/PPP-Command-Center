/**
 * Change Order constants (Phase G). Client-safe — no server imports — so the
 * opportunity detail UI can render status pills, format CO numbers, and label
 * signed amounts without pulling in the service-role db layer.
 */

export const CHANGE_ORDER_STATUSES = ["pending", "approved", "declined"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

/** Semantic tone per status — matches the platform's emerald/amber/rose set. */
export const CHANGE_ORDER_STATUS_META: Record<
  ChangeOrderStatus,
  { label: string; tone: "amber" | "emerald" | "rose" }
> = {
  pending: { label: "Pending", tone: "amber" },
  approved: { label: "Approved", tone: "emerald" },
  declined: { label: "Declined", tone: "rose" },
};

/**
 * Display a CO number as CO-001. co_number is the per-opportunity sequence
 * assigned at insert.
 */
export function formatChangeOrderNumber(coNumber: number): string {
  return `CO-${String(coNumber).padStart(3, "0")}`;
}

/**
 * A CO amount is SIGNED: positive = added scope, negative = deduct/credit.
 * Returns "add" | "deduct" for wording + tone decisions in the UI.
 */
export function changeOrderKind(amountCents: number): "add" | "deduct" {
  return amountCents < 0 ? "deduct" : "add";
}
