import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { WoProgress } from "@/lib/wo-progress/types";
import { getJobCompletedAt } from "@/lib/wo-progress/completion";

/**
 * Builds the canonical progress timeline for one (or many) work orders.
 * Pulls timestamps from:
 *   - customer_form_tokens  (formSentAt / formOpenedAt / formSubmittedAt)
 *   - supplier_orders       (drafted / sent / acknowledged / delivered)
 *   - SF Work Order Status  (jobCompletedAt — when caller passes woMeta)
 *
 * "Per supplier" sub-rows are populated when a WO has 2+ supplier orders
 * so the UI can break down each leg of fulfillment.
 *
 * jobCompletedAt is filled when the caller passes per-WO Status + CloseDate
 * and the Status indicates a successful completion ("Complete Paid in
 * Full", "Paid in Full"). Cancellations/voids/abandonments do NOT count.
 * When the caller doesn't pass meta, jobCompletedAt stays null.
 *
 * Falls back to all-null progress on any DB error so the page still
 * renders the bar in "not started" state.
 */

export type WorkOrderCompletionMeta = { status: string | null; closeDate: string | null };

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

type TokenRow = {
  work_order_id: string;
  work_order_number: string | null;
  sent_at: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  created_at: string;
};

type OrderRow = {
  work_order_id: string;
  supplier_account_id: string;
  supplier_name: string;
  status: string;
  created_at: string;       // draftedAt
  sent_at: string | null;
  acknowledged_at: string | null;
  delivered_at: string | null;
};

/** Pick the most-recent timestamp from a set of rows (most-recent token,
 *  earliest open draft, etc.). Inputs can be null. */
function pickMax(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  let bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const ts = new Date(v).getTime();
    if (isNaN(ts)) continue;
    if (best === null || ts > best) {
      best = ts;
      bestStr = v;
    }
  }
  return bestStr;
}
function pickMin(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  let bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const ts = new Date(v).getTime();
    if (isNaN(ts)) continue;
    if (best === null || ts < best) {
      best = ts;
      bestStr = v;
    }
  }
  return bestStr;
}

/**
 * Returns a Map<workOrderId, WoProgress> for the given WO IDs. One Supabase
 * round-trip for tokens + one for supplier orders. Cheap at PPP scale.
 */
export async function getProgressByWO(
  workOrderIds: string[],
  workOrderMeta?: Map<string, WorkOrderCompletionMeta>,
): Promise<Map<string, WoProgress>> {
  const out = new Map<string, WoProgress>();
  if (workOrderIds.length === 0) return out;

  // Seed empty progress for every WO so callers can rely on the map being
  // dense (UI loops don't need an existence check). When the caller passed
  // per-WO metadata, fill jobCompletedAt up front from SF status.
  for (const id of workOrderIds) {
    const seed = emptyProgress(id);
    const meta = workOrderMeta?.get(id);
    if (meta) seed.jobCompletedAt = getJobCompletedAt(meta);
    out.set(id, seed);
  }

  const sb = adminClient();

  // Pull tokens — most-recent-per-WO wins (admin re-sends create new rows).
  // CRITICAL: skip kind='preview' rows — those are admin-generated test links
  // (the "Preview" button on the JobDetail panel), not real customer sends.
  // Without this filter, a Preview click stamps opened_at on the preview
  // token, the dedupe picks it as "most recent", and the progress timeline
  // lights up "Customer Opened" when no real customer ever clicked anything.
  // Audit 2026-06-07 (Karan caught the false-positive on WO 00303551).
  try {
    const { data: tokenRows, error: tokenErr } = await sb
      .from("customer_form_tokens")
      .select("work_order_id, work_order_number, sent_at, opened_at, submitted_at, created_at, kind")
      .in("work_order_id", workOrderIds)
      .order("created_at", { ascending: false });
    if (tokenErr) throw tokenErr;
    // Kate #13: pick the MOST-ADVANCED token per WO, not just the newest, so a
    // re-sent (blank) form doesn't shadow an earlier SUBMITTED one and stall
    // the progress bar. Kept in lock-step with lib/materials-page-data.ts.
    const tokenRank = (r: TokenRow): number => {
      if (r.submitted_at) return 3;
      if (r.opened_at) return 2;
      return 1;
    };
    const bestByWo = new Map<string, TokenRow>();
    for (const row of (tokenRows ?? []) as (TokenRow & { kind?: string | null })[]) {
      // Preview tokens never count toward customer-facing progress.
      if (row.kind === "preview") continue;
      const cur = bestByWo.get(row.work_order_id);
      if (!cur || tokenRank(row) > tokenRank(cur)) {
        bestByWo.set(row.work_order_id, row);
      }
    }
    for (const row of bestByWo.values()) {
      const existing = out.get(row.work_order_id);
      if (!existing) continue;
      existing.workOrderNumber = row.work_order_number ?? existing.workOrderNumber;
      existing.formSentAt = row.sent_at;
      existing.formOpenedAt = row.opened_at;
      existing.formSubmittedAt = row.submitted_at;
    }
  } catch (err) {
    console.warn("[wo-progress] tokens query failed:", err);
  }

  // Pull supplier orders — aggregate across suppliers per WO.
  try {
    const { data: orderRows, error: orderErr } = await sb
      .from("supplier_orders")
      .select("work_order_id, supplier_account_id, supplier_name, status, created_at, sent_at, acknowledged_at, delivered_at")
      .in("work_order_id", workOrderIds)
      .order("created_at", { ascending: true });
    if (orderErr) throw orderErr;

    // Group orders by WO id
    const byWO = new Map<string, OrderRow[]>();
    for (const r of (orderRows ?? []) as OrderRow[]) {
      if (!byWO.has(r.work_order_id)) byWO.set(r.work_order_id, []);
      byWO.get(r.work_order_id)!.push(r);
    }

    for (const [woId, rows] of byWO) {
      const existing = out.get(woId);
      if (!existing) continue;

      // Stage rules — see WoProgress for definitions
      //   draftedAt      = earliest created_at across orders (first time any
      //                    supplier draft existed)
      //   sentAt         = earliest sent_at (first email went out)
      //   acknowledgedAt = latest acknowledged_at across ALL orders (all
      //                    suppliers confirmed)
      //   deliveredAt    = latest delivered_at across ALL orders (final
      //                    materials arrived)
      existing.supplierDraftedAt = pickMin(rows.map((r) => r.created_at));
      existing.supplierSentAt = pickMin(rows.map((r) => r.sent_at));
      // ack/delivered need ALL suppliers to have the stamp — if any is
      // missing, the stage stays "active" (waiting)
      const allAcked = rows.length > 0 && rows.every((r) => r.acknowledged_at);
      existing.supplierAcknowledgedAt = allAcked ? pickMax(rows.map((r) => r.acknowledged_at)) : null;
      const allDelivered = rows.length > 0 && rows.every((r) => r.delivered_at);
      existing.materialsDeliveredAt = allDelivered ? pickMax(rows.map((r) => r.delivered_at)) : null;

      // Per-supplier breakdown surface
      if (rows.length > 0) {
        existing.perSupplier = rows.map((r) => ({
          supplierAccountId: r.supplier_account_id,
          supplierName: r.supplier_name,
          draftedAt: r.created_at,
          sentAt: r.sent_at,
          acknowledgedAt: r.acknowledged_at,
          deliveredAt: r.delivered_at,
        }));
      }
    }
  } catch (err) {
    console.warn("[wo-progress] supplier_orders query failed:", err);
  }

  return out;
}

function emptyProgress(workOrderId: string): WoProgress {
  return {
    workOrderId,
    workOrderNumber: null,
    formSentAt: null,
    formOpenedAt: null,
    formSubmittedAt: null,
    supplierDraftedAt: null,
    supplierSentAt: null,
    supplierAcknowledgedAt: null,
    materialsDeliveredAt: null,
    jobCompletedAt: null,
  };
}
