"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Past orders strip — renders the supplier_orders history for a WO with
 * inline status transition buttons (Mark Acknowledged / Mark Delivered /
 * Cancel) wired to /api/admin/supplier-order/status.
 *
 * Fetches on mount + on `refreshKey` change so the parent can trigger a
 * reload after a new order is sent (close the modal, bump refreshKey,
 * this list re-fetches).
 *
 * Renders nothing when there are no past orders — keeps the materials
 * page clean for fresh WOs that haven't been ordered yet.
 */

type OrderRow = {
  id: string;
  supplier_account_id: string;
  supplier_name: string;
  po_number: string;
  status: "draft" | "sent" | "acknowledged" | "delivered" | "cancelled" | "failed";
  fulfillment_method: "delivery" | "pickup";
  sent_to_email: string | null;
  sent_at: string | null;
  acknowledged_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

type Props = {
  workOrderId: string;
  /** Bump to force a refresh — parent uses this after a successful send
   *  to repopulate the list with the new row. */
  refreshKey?: number;
};

export default function WoPastOrders({ workOrderId, refreshKey = 0 }: Props) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState<string | null>(null); // order id mid-transition
  /** Inline error per row — surfaces transition failures non-modally so the
   *  user can see what went wrong without a blocking alert(). Auto-clears
   *  after 6s; or admin clicks dismiss. */
  const [rowError, setRowError] = useState<{ orderId: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/supplier-order/by-wo?workOrderId=${encodeURIComponent(workOrderId)}`);
      const data = await res.json();
      if (res.ok && data.ok) {
        setOrders((data.orders as OrderRow[]) ?? []);
      }
    } catch (err) {
      console.warn("[wo-past-orders] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [workOrderId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const transition = async (
    orderId: string,
    nextStatus: "acknowledged" | "delivered" | "cancelled"
  ) => {
    setTransitioning(orderId);
    setRowError(null);
    // No more optimistic update — previously we flipped the row's status
    // immediately, then rolled back on server error via reload, which
    // produced a visible "Mark Delivered" → ⟲ → "Sent" flash on slow
    // networks. Spinner-only state during the round-trip is calmer; the
    // status flips ONCE when the server confirms.
    try {
      const res = await fetch("/api/admin/supplier-order/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierOrderId: orderId, status: nextStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.message ?? data.error ?? `HTTP ${res.status}`;
        setRowError({ orderId, message: msg });
        // Auto-clear after 6s so the strip doesn't stay stuck on an error
        setTimeout(() => setRowError((prev) => prev?.orderId === orderId ? null : prev), 6000);
      } else {
        // Server confirmed — apply the local update ONCE. Previously we did
        // an optimistic update before the request, which caused a visible
        // "Mark Delivered" → ⟲ → "Sent" flash on error rollback. Spinner-only
        // during the round-trip + single flip on success is calmer.
        setOrders((prev) =>
          prev.map((o) =>
            o.id === orderId
              ? {
                  ...o,
                  status: nextStatus,
                  acknowledged_at: nextStatus === "acknowledged" ? new Date().toISOString() : o.acknowledged_at,
                  delivered_at: nextStatus === "delivered" ? new Date().toISOString() : o.delivered_at,
                  cancelled_at: nextStatus === "cancelled" ? new Date().toISOString() : o.cancelled_at,
                }
              : o
          )
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRowError({ orderId, message: msg });
      setTimeout(() => setRowError((prev) => prev?.orderId === orderId ? null : prev), 6000);
    } finally {
      setTransitioning(null);
    }
  };

  if (loading && orders.length === 0) {
    return null; // Don't show a loading flash for an empty section
  }
  if (orders.length === 0) {
    return null;
  }

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-ppp-charcoal">Past supplier orders</h3>
        <span className="text-[11px] text-ppp-charcoal-500">{orders.length}</span>
      </div>
      <ul className="divide-y divide-ppp-charcoal-100">
        {orders.map((o) => {
          const isOpen = transitioning === o.id;
          return (
            <li key={o.id} className="px-5 py-3">
              {rowError?.orderId === o.id && (
                <div className="mb-2 bg-ppp-orange-50 border border-ppp-orange-100 rounded px-3 py-2 text-[11px] text-ppp-orange-700 flex items-start justify-between gap-2">
                  <span>⚠ Couldn&apos;t update status: {rowError.message}</span>
                  <button
                    type="button"
                    onClick={() => setRowError(null)}
                    className="shrink-0 underline hover:text-ppp-orange-900"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="text-sm font-semibold text-ppp-charcoal truncate max-w-[16rem]" title={o.supplier_name}>
                      {o.supplier_name}
                    </span>
                    <StatusPill status={o.status} />
                    <span className="font-mono text-[10px] text-ppp-charcoal-500">{o.po_number}</span>
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex flex-wrap gap-x-2">
                    {o.sent_at && <span>Sent {formatDateShort(o.sent_at)}</span>}
                    {o.sent_to_email && <span>to {o.sent_to_email}</span>}
                    <span>· {o.fulfillment_method === "pickup" ? "Pickup" : "Delivery"}</span>
                    {o.acknowledged_at && <span>· Ack {formatDateShort(o.acknowledged_at)}</span>}
                    {o.delivered_at && <span>· Delivered {formatDateShort(o.delivered_at)}</span>}
                    {o.failure_reason && (
                      <span className="text-ppp-orange-700">· {o.failure_reason.slice(0, 80)}</span>
                    )}
                  </div>
                </div>
                {/* Status transition buttons — only show valid next steps */}
                {/* Mobile: action buttons wrap to their own row to keep each
                    ≥40px tall (px-3 + py-2 = ~36px target). Desktop keeps
                    the inline compact look. */}
                <div className="flex flex-wrap items-center gap-1.5 shrink-0 mt-2 sm:mt-0">
                  {(o.status === "sent") && (
                    <button
                      type="button"
                      onClick={() => transition(o.id, "acknowledged")}
                      disabled={isOpen}
                      className="px-3 py-2 sm:py-1 text-xs sm:text-[11px] rounded border border-ppp-blue-100 bg-ppp-blue-50 text-ppp-blue-700 hover:bg-ppp-blue-100 active:bg-ppp-blue-200 disabled:opacity-50 transition-colors font-medium touch-manipulation"
                      title="Supplier confirmed the order"
                    >
                      Mark acknowledged
                    </button>
                  )}
                  {(o.status === "sent" || o.status === "acknowledged") && (
                    <button
                      type="button"
                      onClick={() => transition(o.id, "delivered")}
                      disabled={isOpen}
                      className="px-3 py-2 sm:py-1 text-xs sm:text-[11px] rounded border border-ppp-green-100 bg-ppp-green-50 text-ppp-green-700 hover:bg-ppp-green-100 active:bg-ppp-green-200 disabled:opacity-50 transition-colors font-medium touch-manipulation"
                      title="Materials arrived"
                    >
                      Mark delivered
                    </button>
                  )}
                  {(o.status === "sent" || o.status === "acknowledged" || o.status === "draft") && (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Cancel order ${o.po_number}? This can't be undone.`)) {
                          transition(o.id, "cancelled");
                        }
                      }}
                      disabled={isOpen}
                      className="px-3 py-2 sm:py-1 text-xs sm:text-[11px] rounded border border-ppp-charcoal-100 text-ppp-charcoal-500 hover:bg-ppp-orange-50 hover:text-ppp-orange-700 hover:border-ppp-orange-100 active:bg-ppp-orange-100 disabled:opacity-50 transition-colors font-medium touch-manipulation"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ─── Helpers ─── */

function StatusPill({ status }: { status: OrderRow["status"] }) {
  const config: Record<OrderRow["status"], { label: string; cls: string }> = {
    draft:        { label: "Draft",        cls: "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100" },
    sent:         { label: "Sent",         cls: "bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100" },
    acknowledged: { label: "Acknowledged", cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100" },
    delivered:    { label: "✓ Delivered",  cls: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100" },
    cancelled:    { label: "Cancelled",    cls: "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100 line-through" },
    failed:       { label: "⚠ Failed",     cls: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100" },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${c.cls}`}>
      {c.label}
    </span>
  );
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}
