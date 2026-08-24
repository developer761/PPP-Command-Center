/**
 * Turn a work order's supplier_orders rows into progress stages (R5.5).
 *
 * Cancelling an order used to change nothing a reader could see: the work order
 * still said "ordered" on the Materials list, still came back under the Ordered
 * filter, and its progress bar stayed advanced. Both progress loaders derived
 * every stage from ALL rows without ever looking at `status`.
 *
 * A cancelled order is not an order. It stops contributing to the live stages —
 * so a work order whose only order was cancelled reads as "not ordered yet",
 * which is the truth and is also what makes it findable again.
 *
 * It does NOT disappear. It stays in `perSupplier` so the timeline still shows
 * what happened, and `supplierCancelledAt` is exposed so the UI can say so and
 * the status filter can find it. The vendor was emailed a real order; erasing
 * that from the record would be worse than the bug.
 *
 * Shared by both loaders on purpose. Round 3 #02/#03 was two progress loaders
 * drifting apart, and this is the same shape of logic in the same two places.
 */

export type OrderStageRow = {
  supplier_account_id: string;
  supplier_name: string;
  status: string | null;
  created_at: string | null;
  sent_at: string | null;
  acknowledged_at: string | null;
  delivered_at: string | null;
  cancelled_at?: string | null;
};

export type OrderStages = {
  supplierDraftedAt: string | null;
  supplierSentAt: string | null;
  supplierAcknowledgedAt: string | null;
  materialsDeliveredAt: string | null;
  /** Set only when EVERY order on the work order is cancelled — i.e. the job is
   *  genuinely back to needing one. A WO with a cancelled order and a live one
   *  is still ordered, and showing it as cancelled would be a lie. */
  supplierCancelledAt: string | null;
  perSupplier: Array<{
    supplierAccountId: string;
    supplierName: string;
    draftedAt: string | null;
    sentAt: string | null;
    acknowledgedAt: string | null;
    deliveredAt: string | null;
    cancelledAt: string | null;
  }>;
};

const min = (v: Array<string | null>): string | null => {
  const x = v.filter((s): s is string => !!s).sort();
  return x[0] ?? null;
};
const max = (v: Array<string | null>): string | null => {
  const x = v.filter((s): s is string => !!s).sort();
  return x[x.length - 1] ?? null;
};

export function isCancelledOrder(r: Pick<OrderStageRow, "status" | "cancelled_at">): boolean {
  // Trust either signal. `status` is what the cancel route sets, but a row
  // stamped `cancelled_at` with a stale status is still a cancelled order, and
  // reading only one of them is how this stays half-fixed.
  return r.status === "cancelled" || !!r.cancelled_at;
}

export function deriveOrderStages(rows: OrderStageRow[]): OrderStages {
  const live = rows.filter((r) => !isCancelledOrder(r));
  const cancelled = rows.filter((r) => isCancelledOrder(r));

  // ack/delivered require EVERY live order to carry the stamp — one supplier
  // still outstanding keeps the stage waiting.
  const allAcked = live.length > 0 && live.every((r) => r.acknowledged_at);
  const allDelivered = live.length > 0 && live.every((r) => r.delivered_at);

  return {
    supplierDraftedAt: min(live.map((r) => r.created_at)),
    supplierSentAt: min(live.map((r) => r.sent_at)),
    supplierAcknowledgedAt: allAcked ? max(live.map((r) => r.acknowledged_at)) : null,
    materialsDeliveredAt: allDelivered ? max(live.map((r) => r.delivered_at)) : null,
    supplierCancelledAt:
      cancelled.length > 0 && live.length === 0
        ? max(cancelled.map((r) => r.cancelled_at ?? r.created_at))
        : null,
    perSupplier: rows.map((r) => ({
      supplierAccountId: r.supplier_account_id,
      supplierName: r.supplier_name,
      draftedAt: r.created_at,
      sentAt: r.sent_at,
      acknowledgedAt: r.acknowledged_at,
      deliveredAt: r.delivered_at,
      cancelledAt: isCancelledOrder(r) ? r.cancelled_at ?? r.created_at : null,
    })),
  };
}

/** The columns both loaders must select for the above to work. */
export const ORDER_STAGE_COLUMNS =
  "work_order_id, supplier_account_id, supplier_name, status, created_at, sent_at, acknowledged_at, delivered_at, cancelled_at";
