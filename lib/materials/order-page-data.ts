import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { loadDashboardData } from "@/lib/data-source";
import { deriveOpenMaterialsWorkOrders, type OpenWorkOrderForMaterials } from "@/lib/salesforce/materials";
import { resolveWorkOrderId } from "@/lib/materials/resolve-wo";
import { roomLabelFrom } from "@/lib/customer-form/room-label";
import { normalizeBuildPayload, emptyBuildPayload, type OrderBuildPayload } from "@/lib/supplier-order/build-state";
import { normalizeFulfillmentState, emptyFulfillmentState, type FulfillmentState } from "@/lib/supplier-order/fulfillment-state";
import { capabilitiesFor } from "@/lib/auth/roles";
import type { SourceLine } from "@/components/order-builder-view";

/**
 * Server data for the two order pages (Kate round-3 #18).
 *
 * Both pages resolve the work order through exactly the same path the work-order
 * page uses, so viewer scoping and the 15↔18-char Salesforce Id handling behave
 * identically — a rep who can't see a WO can't reach its order screens either.
 */

export type OrderPageData = {
  job: OpenWorkOrderForMaterials;
  workOrderId: string;
  sourceLines: SourceLine[];
  canOrderMaterials: boolean;
  /** Customer address, for the measure tool's property lookup. Null when
   *  Salesforce has none on the account. */
  address: { street: string; city: string; state: string; postalCode: string } | null;
};

// STANDARD_SURFACES is imported, not redeclared — the Rooms & Colors list and
// this page must classify surfaces identically or a colour shows in one and
// vanishes from the other.

export async function loadOrderPageData(
  rawWoId: string
): Promise<OrderPageData | null> {
  const bundle = await loadDashboardData({}, { materials: true });
  if (!bundle.snapshot) return null;

  const jobs = deriveOpenMaterialsWorkOrders(bundle.snapshot);
  const woId = resolveWorkOrderId(rawWoId, jobs);
  if (!woId) return null;
  const job = jobs.find((j) => j.wo.id === woId);
  if (!job) return null;

  const sourceLines: SourceLine[] = [];

  for (const li of job.lineItems) {
    const room = roomLabelFrom(li.raw.areaLabel, li.raw.productName, "Unnamed area");
    const selected = (li.raw.surfaces ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    // Kate round-3 #14: the source list has to say which room AND which
    // surfaces the line covers — "Interior Painting · 2 coats" identified
    // nothing when a work order had six of them.
    sourceLines.push({
      id: li.raw.id,
      room,
      surfaces: selected,
      detail: [li.raw.productFamily, li.raw.numCoats ? `${li.raw.numCoats} coats` : null, li.raw.primer]
        .filter(Boolean)
        .join(" · "),
      sqft: li.raw.sqFootage,
    });
  }

  // ID-first, name fallback — the same lookup the draft route uses, so the
  // address the measure tool reads is the one the order would deliver to.
  const acct =
    (job.wo.accountId ? bundle.snapshot.accounts.find((a) => a.id === job.wo.accountId) : null) ??
    (job.wo.accountName ? bundle.snapshot.accounts.find((a) => a.name === job.wo.accountName) : null) ??
    null;

  return {
    job,
    workOrderId: woId,
    sourceLines,
    // Derive from the ROLE, not `viewer.isAdmin` — this line read the admin
    // flag directly, so widening the capability in roles.ts alone would have
    // left both order pages still saying "admin-only" to everyone else. A
    // missing viewer stays false rather than falling through to "rep".
    canOrderMaterials: bundle.viewer
      ? capabilitiesFor(bundle.viewer.role).canOrderMaterials
      : false,
    address: acct?.billingStreet
      ? {
          street: acct.billingStreet ?? "",
          city: acct.billingCity ?? "",
          state: acct.billingState ?? "",
          postalCode: acct.billingPostalCode ?? "",
        }
      : null,
  };
}

/** Read the committed build for one (WO, supplier). Deploy-safe: returns an
 *  empty payload while migration 144 is pending. */
export async function loadBuildPayload(
  workOrderId: string,
  supplierAccountId: string
): Promise<{ payload: OrderBuildPayload; committed: boolean; available: boolean; fulfillment: FulfillmentState }> {
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb
      .from("supplier_order_builds")
      // R4.33: the fulfilment slice rides along on the row we were fetching
      // anyway, so restoring it costs no extra round-trip.
      .select("payload, committed_at, fulfillment")
      .eq("work_order_id", workOrderId)
      .eq("supplier_account_id", supplierAccountId)
      .maybeSingle();
    if (error) throw error;
    return {
      payload: data ? normalizeBuildPayload(data.payload) : emptyBuildPayload(),
      committed: !!data?.committed_at,
      available: true,
      fulfillment: normalizeFulfillmentState(data?.fulfillment),
    };
  } catch (err) {
    // Also the path when migration 155 is pending: selecting a column that
    // doesn't exist errors the whole query, so the build payload would be lost
    // too. Retry without it rather than degrade a working feature.
    try {
      const sb = createSupabaseAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SECRET_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      const { data, error } = await sb
        .from("supplier_order_builds")
        .select("payload, committed_at")
        .eq("work_order_id", workOrderId)
        .eq("supplier_account_id", supplierAccountId)
        .maybeSingle();
      if (error) throw error;
      return {
        payload: data ? normalizeBuildPayload(data.payload) : emptyBuildPayload(),
        committed: !!data?.committed_at,
        available: true,
        fulfillment: emptyFulfillmentState(),
      };
    } catch {
      console.warn("[order-page-data] build load unavailable:", err);
      return { payload: emptyBuildPayload(), committed: false, available: false, fulfillment: emptyFulfillmentState() };
    }
  }
}

/** The most recently touched build for a WO — lets the builder resume into the
 *  supplier the worker was last working with instead of asking again. */
export async function loadLatestBuildForWorkOrder(
  workOrderId: string
): Promise<{ supplierAccountId: string | null; payload: OrderBuildPayload; available: boolean }> {
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb
      .from("supplier_order_builds")
      .select("supplier_account_id, payload")
      .eq("work_order_id", workOrderId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    // No row yet is a perfectly normal first visit — persistence still works.
    if (!data) return { supplierAccountId: null, payload: emptyBuildPayload(), available: true };
    return {
      supplierAccountId: data.supplier_account_id as string,
      payload: normalizeBuildPayload(data.payload),
      available: true,
    };
  } catch (err) {
    // Migration 144 pending (or the table is unreachable): the builder still
    // works in-memory, it just can't resume. Flagged in the UI, not swallowed.
    console.warn("[order-page-data] latest build unavailable:", err);
    return { supplierAccountId: null, payload: emptyBuildPayload(), available: false };
  }
}
