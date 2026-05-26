import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { FormStatus } from "@/lib/customer-form/wo-status";
import type { WoProgress } from "@/components/work-order-progress-bar";

/**
 * One-shot loader for the materials page's two auxiliary datasets:
 *   - form status per WO (from customer_form_tokens)
 *   - progress timeline per WO (from customer_form_tokens + supplier_orders)
 *
 * Previously these came from TWO separate Supabase helpers
 * (`getFormStatusByWO` + `getProgressByWO`) running in parallel via
 * Promise.all. They each opened a separate Supabase client + each made
 * their own queries (2-3 round-trips total). Speed-audit identified this
 * as ~300-600ms of avoidable latency on every materials page load.
 *
 * Consolidated path: one Supabase client + one query per source object
 * (tokens, orders) — 2 round-trips total instead of 3+. Builds both
 * output Maps from the same fetched rows.
 *
 * Falls back to empty Maps on any error so the page still renders.
 */

type TokenRow = {
  token: string;
  work_order_id: string;
  work_order_number: string | null;
  sent_at: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  expires_at: string;
  created_at: string;
};

type OrderRow = {
  work_order_id: string;
  supplier_account_id: string;
  supplier_name: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  delivered_at: string | null;
};

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Pick the max-non-null timestamp from a list. */
function pickMax(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  let bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (isNaN(t)) continue;
    if (best === null || t > best) { best = t; bestStr = v; }
  }
  return bestStr;
}
function pickMin(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  let bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (isNaN(t)) continue;
    if (best === null || t < best) { best = t; bestStr = v; }
  }
  return bestStr;
}

export type MaterialsPageAuxData = {
  formStatusByWO: Map<string, FormStatus>;
  progressByWO: Map<string, WoProgress>;
};

export async function getMaterialsPageAuxData(workOrderIds: string[]): Promise<MaterialsPageAuxData> {
  const formStatusByWO = new Map<string, FormStatus>();
  const progressByWO = new Map<string, WoProgress>();
  if (workOrderIds.length === 0) return { formStatusByWO, progressByWO };

  // Seed all-defaults so callers can do constant-time lookups
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  for (const id of workOrderIds) {
    formStatusByWO.set(id, { status: "none", woId: id });
    progressByWO.set(id, {
      workOrderId: id,
      workOrderNumber: null,
      formSentAt: null,
      formOpenedAt: null,
      formSubmittedAt: null,
      supplierDraftedAt: null,
      supplierSentAt: null,
      supplierAcknowledgedAt: null,
      materialsDeliveredAt: null,
      jobCompletedAt: null,
    });
  }

  const sb = adminClient();

  // Pull both source tables in parallel — one shared Supabase client.
  const [tokensResult, ordersResult] = await Promise.allSettled([
    sb
      .from("customer_form_tokens")
      .select("token, work_order_id, work_order_number, sent_at, opened_at, submitted_at, expires_at, created_at")
      .in("work_order_id", workOrderIds)
      .order("created_at", { ascending: false }),
    sb
      .from("supplier_orders")
      .select("work_order_id, supplier_account_id, supplier_name, status, created_at, sent_at, acknowledged_at, delivered_at")
      .in("work_order_id", workOrderIds)
      .order("created_at", { ascending: true }),
  ]);

  // ── Token rows → form status (latest per WO) AND progress stages 1-3 ──
  if (tokensResult.status === "fulfilled" && !tokensResult.value.error) {
    const seen = new Set<string>();
    const now = Date.now();
    for (const row of (tokensResult.value.data ?? []) as TokenRow[]) {
      if (seen.has(row.work_order_id)) continue;
      seen.add(row.work_order_id);

      // Progress stages from this same row
      const progress = progressByWO.get(row.work_order_id);
      if (progress) {
        progress.workOrderNumber = row.work_order_number ?? progress.workOrderNumber;
        progress.formSentAt = row.sent_at;
        progress.formOpenedAt = row.opened_at;
        progress.formSubmittedAt = row.submitted_at;
      }

      // Form status — same shape getFormStatusByWO produced
      const formUrl = `${baseUrl}/select/${row.token}`;
      if (row.submitted_at) {
        formStatusByWO.set(row.work_order_id, {
          status: "submitted",
          woId: row.work_order_id,
          token: row.token,
          sentAt: row.sent_at,
          openedAt: row.opened_at,
          submittedAt: row.submitted_at,
          formUrl,
        });
        continue;
      }
      const expiresMs = new Date(row.expires_at).getTime();
      if (!isNaN(expiresMs) && expiresMs < now) {
        formStatusByWO.set(row.work_order_id, {
          status: "expired",
          woId: row.work_order_id,
          token: row.token,
          sentAt: row.sent_at,
          openedAt: row.opened_at,
          expiredAt: row.expires_at,
          formUrl,
        });
        continue;
      }
      if (row.opened_at) {
        formStatusByWO.set(row.work_order_id, {
          status: "opened",
          woId: row.work_order_id,
          token: row.token,
          sentAt: row.sent_at,
          openedAt: row.opened_at,
          formUrl,
        });
        continue;
      }
      formStatusByWO.set(row.work_order_id, {
        status: "sent",
        woId: row.work_order_id,
        token: row.token,
        sentAt: row.sent_at,
        formUrl,
      });
    }
  } else if (tokensResult.status === "rejected") {
    console.warn("[materials-aux] tokens query failed:", tokensResult.reason);
  }

  // ── Supplier orders → progress stages 4-6 + perSupplier sub-rows ──
  if (ordersResult.status === "fulfilled" && !ordersResult.value.error) {
    const byWO = new Map<string, OrderRow[]>();
    for (const r of (ordersResult.value.data ?? []) as OrderRow[]) {
      if (!byWO.has(r.work_order_id)) byWO.set(r.work_order_id, []);
      byWO.get(r.work_order_id)!.push(r);
    }
    for (const [woId, rows] of byWO) {
      const existing = progressByWO.get(woId);
      if (!existing) continue;
      existing.supplierDraftedAt = pickMin(rows.map((r) => r.created_at));
      existing.supplierSentAt = pickMin(rows.map((r) => r.sent_at));
      const allAcked = rows.length > 0 && rows.every((r) => r.acknowledged_at);
      existing.supplierAcknowledgedAt = allAcked ? pickMax(rows.map((r) => r.acknowledged_at)) : null;
      const allDelivered = rows.length > 0 && rows.every((r) => r.delivered_at);
      existing.materialsDeliveredAt = allDelivered ? pickMax(rows.map((r) => r.delivered_at)) : null;
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
  } else if (ordersResult.status === "rejected") {
    console.warn("[materials-aux] supplier_orders query failed:", ordersResult.reason);
  }

  return { formStatusByWO, progressByWO };
}
