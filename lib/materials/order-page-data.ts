import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { loadDashboardData } from "@/lib/data-source";
import { deriveOpenMaterialsWorkOrders, getSupplierName, type OpenWorkOrderForMaterials } from "@/lib/salesforce/materials";
import { resolveWorkOrderId } from "@/lib/materials/resolve-wo";
import { STANDARD_SURFACES } from "@/lib/customer-form/surface-mapping";
import { roomLabelFrom } from "@/lib/customer-form/room-label";
import { parseMachineColorLines } from "@/lib/customer-form/notes";
import { normalizeBuildPayload, emptyBuildPayload, type OrderBuildPayload } from "@/lib/supplier-order/build-state";
import type { SourceLine, PreviewGroup, PreviewColor } from "@/components/order-builder-view";

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
  previewGroups: PreviewGroup[];
  canOrderMaterials: boolean;
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
  // colour id → the colour plus every place it lands
  const colorPlacements = new Map<
    string,
    { color: { id: string; name: string; code: string | null; hex: string | null; manufacturerId: string | null }; placements: Array<{ room: string; surface: string }> }
  >();

  for (const li of job.lineItems) {
    const room = roomLabelFrom(li.raw.areaLabel, li.raw.productName, "Unnamed area");
    const selected = (li.raw.surfaces ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const orphans = selected.filter((s) => !STANDARD_SURFACES.includes(s) && s !== "Other");

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

    // Kate round-3 #10: a room with 2+ orphan surfaces has its colours in
    // ColorNotes__c and ColorOther__c deliberately blank — one field can't hold
    // two. Reading only `li.other` meant this preview showed fewer colours than
    // the order actually contains (the draft builder sources them from the
    // customer's submitted payload), so the screen disagreed with the email.
    // Re-link them to the catalog by code, then by name.
    const notesBySurface = new Map(
      parseMachineColorLines(li.raw.colorNotes).map((p) => [p.surface.toLowerCase(), p])
    );
    const relink = (surface: string): typeof li.wall => {
      const note = notesBySurface.get(surface.toLowerCase());
      if (!note) return li.other;
      const byCode = note.colorCode
        ? bundle.snapshot!.paintColors.find(
            (c) => (c.code ?? "").toLowerCase() === note.colorCode!.toLowerCase()
          )
        : undefined;
      const match =
        byCode ??
        bundle.snapshot!.paintColors.find(
          (c) => c.name.toLowerCase() === note.colorName.toLowerCase()
        );
      // No catalog match (a custom mix, a discontinued code): fall back rather
      // than dropping the surface. The colour still reaches the vendor through
      // the order's Color Notes block.
      return match ?? li.other;
    };
    const slots: Array<{ surface: string; color: typeof li.wall }> = [
      { surface: "Walls", color: li.wall },
      { surface: "Ceiling", color: li.ceiling },
      { surface: "Trim", color: li.trim },
      { surface: "Floor", color: li.floor },
      // Only use the generic "Other" slot when Salesforce didn't name the
      // orphan surfaces; otherwise the named ones below carry that colour.
      ...(orphans.length === 0 ? [{ surface: "Other", color: li.other }] : []),
      ...orphans.map((s) => ({ surface: s, color: relink(s) })),
    ];

    for (const slot of slots) {
      const c = slot.color;
      if (!c) continue;
      let entry = colorPlacements.get(c.id);
      if (!entry) {
        entry = {
          color: {
            id: c.id,
            name: c.name,
            code: c.code ?? null,
            hex: c.hexValue ?? null,
            manufacturerId: c.manufacturerId ?? null,
          },
          placements: [],
        };
        colorPlacements.set(c.id, entry);
      }
      // Kate round-3 #15: room + surface, so two lines of the same colour are
      // distinguishable and nothing shows a generic "Area".
      if (!entry.placements.some((p) => p.room === room && p.surface === slot.surface)) {
        entry.placements.push({ room, surface: slot.surface });
      }
    }
  }

  const byMfg = new Map<string, PreviewGroup>();
  for (const entry of colorPlacements.values()) {
    const mfgId = entry.color.manufacturerId ?? "unknown";
    let group = byMfg.get(mfgId);
    if (!group) {
      group = {
        supplierName: getSupplierName(bundle.snapshot, mfgId === "unknown" ? null : mfgId),
        supplierAccountId: mfgId === "unknown" ? null : mfgId,
        colors: [],
      };
      byMfg.set(mfgId, group);
    }
    const previewColor: PreviewColor = {
      id: entry.color.id,
      name: entry.color.name,
      code: entry.color.code,
      hex: entry.color.hex,
      placements: entry.placements,
    };
    group.colors.push(previewColor);
  }

  return {
    job,
    workOrderId: woId,
    sourceLines,
    previewGroups: Array.from(byMfg.values()).sort((a, b) => a.supplierName.localeCompare(b.supplierName)),
    canOrderMaterials: bundle.viewer?.isAdmin ?? false,
  };
}

/** Read the committed build for one (WO, supplier). Deploy-safe: returns an
 *  empty payload while migration 144 is pending. */
export async function loadBuildPayload(
  workOrderId: string,
  supplierAccountId: string
): Promise<{ payload: OrderBuildPayload; committed: boolean; available: boolean }> {
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
    };
  } catch (err) {
    console.warn("[order-page-data] build load unavailable:", err);
    return { payload: emptyBuildPayload(), committed: false, available: false };
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
