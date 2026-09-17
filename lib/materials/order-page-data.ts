import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { loadDashboardData } from "@/lib/data-source";
import { deriveOpenMaterialsWorkOrders, type OpenWorkOrderForMaterials } from "@/lib/salesforce/materials";
import { resolveWorkOrderId } from "@/lib/materials/resolve-wo";
import { roomLabelFrom } from "@/lib/customer-form/room-label";
import { extractCustomerFreeText } from "@/lib/customer-form/notes";
import { colorNoteLines } from "@/lib/supplier-order/color-note-items";
import { normalizeBuildPayload, emptyBuildPayload, type OrderBuildPayload } from "@/lib/supplier-order/build-state";
import { normalizeFulfillmentState, emptyFulfillmentState, type FulfillmentState } from "@/lib/supplier-order/fulfillment-state";
import { capabilitiesFor } from "@/lib/auth/roles";
import { loadSqftOverridesFor } from "@/lib/materials/view-props";
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
// this page must classify surfaces identically or a color shows in one and
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

  // The measured square footage somebody typed on the work-order page. The
  // DRAFT already uses it (the gallons and the vendor email are computed from
  // it), but this panel read Salesforce's own field — so a room that had been
  // measured showed one number on screen and was ordered against another, and
  // the room dimensions derived from it were the wrong room.
  const sqftOverrides = await loadSqftOverridesFor(job.lineItems.map((li) => li.raw.id));

  for (const li of job.lineItems) {
    const room = roomLabelFrom(li.raw.areaLabel, li.raw.productName);
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
      sqft: sqftOverrides[li.raw.id] || li.raw.sqFootage,
      // Katie item 13 — the paintable area, which is what the gallons come
      // from. 0 when the rep never measured it, and then only floor shows.
      wallSqft: li.raw.wallSurfaceArea ?? 0,
      perimeterLf: li.raw.perimeter ?? 0,
      heightFt: li.raw.heightFt ?? 0,
      // Kate 2026-09-04 — the rep's own scope notes, so this list shows what
      // the job covers rather than just how many lines it has.
      notes: li.raw.description ?? null,
      // Katie item 23 — the per-surface COLORS. On a work order where a rep
      // puts the whole house on one line, Description says "see notes for
      // colors" and this is the notes. Free text, not our machine format:
      // extractMachineColorLines returns nothing for it, which is exactly why
      // none of it reached the order.
      colorNotes: extractCustomerFreeText(li.raw.colorNotes) || null,
      // Color notes never reach the vendor email (R4.14), so each color in
      // them is offered to the custom-item form — including the orphan-surface
      // lines the color form writes, which the free-text view above omits.
      colorNoteLines: colorNoteLines(li.raw.colorNotes),
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

/** An order that already went to a vendor for this work order. */
export type PriorOrder = {
  poNumber: string | null;
  supplierAccountId: string;
  supplierName: string | null;
  sentAt: string | null;
};

/**
 * Orders already SENT for this work order.
 *
 * Nothing on either order screen looked at `supplier_orders`, so coming back
 * to add one forgotten gallon resumed the whole finished order — vendor
 * pre-selected, every quantity and extra still there — and "Continue to
 * fulfilment" → Send emailed the lot again as a second PO. The vendor ships
 * the job twice. The only place the order's own state was visible is the
 * work-order page the estimator just left.
 *
 * Cancelled and failed rows are excluded: neither is an order anybody is
 * holding. Best-effort — a work order that cannot load this still builds.
 */
export async function loadSentOrdersForWorkOrder(workOrderId: string): Promise<PriorOrder[]> {
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb
      .from("supplier_orders")
      .select("po_number, supplier_account_id, supplier_name, sent_at, status, cancelled_at")
      .eq("work_order_id", workOrderId)
      .order("sent_at", { ascending: false });
    if (error) throw error;
    return (data ?? [])
      .filter((r) => {
        const row = r as { status?: string | null; cancelled_at?: string | null; sent_at?: string | null };
        if (row.status === "cancelled" || row.cancelled_at) return false;
        if (row.status === "failed") return false;
        return !!row.sent_at;
      })
      .map((r) => {
        const row = r as { po_number?: string | null; supplier_account_id: string; supplier_name?: string | null; sent_at?: string | null };
        return {
          poNumber: row.po_number ?? null,
          supplierAccountId: row.supplier_account_id,
          supplierName: row.supplier_name ?? null,
          sentAt: row.sent_at ?? null,
        };
      });
  } catch (err) {
    console.warn("[order-page-data] sent orders unavailable:", err);
    return [];
  }
}
