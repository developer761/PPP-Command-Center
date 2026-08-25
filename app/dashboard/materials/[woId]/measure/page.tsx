import { redirect } from "next/navigation";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import MeasureView, { type MeasureRoom } from "@/components/measure-view";
import { loadOrderPageData } from "@/lib/materials/order-page-data";
import { roomLabelFrom } from "@/lib/customer-form/room-label";
import { suggestFromHistory, type HistorySample } from "@/lib/measure/from-history";
import type { MeasureSuggestion } from "@/lib/measure/types";

export const dynamic = "force-dynamic";

/**
 * Measure the rooms on one work order.
 *
 * Sits on the work order rather than standing alone, because the rooms ARE the
 * work order's line items — the same records the gallon estimator sizes and the
 * supplier order buys for. Anything captured here writes to
 * wo_li_sqft_overrides, which the estimator already reads, so a number entered
 * in a bedroom shows up in the vendor quantities without another step.
 */

/** Past measurements to compare against. Read from the Command Center's own
 *  overrides rather than Salesforce: these carry a clean room label and a known
 *  source, where SF's AreaLabel__c is frequently blank or a fragment. */
async function loadHistory(): Promise<HistorySample[]> {
  try {
    const sb = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb
      .from("room_measurement_captures")
      .select("room_label, accepted_sqft")
      .not("accepted_sqft", "is", null)
      .limit(5000);
    if (error || !data) return [];
    return (data as Array<{ room_label: string | null; accepted_sqft: number }>)
      .filter((r) => r.room_label && r.accepted_sqft > 0)
      .map((r) => ({ label: r.room_label!, sqft: r.accepted_sqft }));
  } catch {
    // Migration 156 pending — history simply has nothing to say yet.
    return [];
  }
}

async function loadSaved(woliIds: string[]) {
  const out = new Map<string, { sqft: number; source: string | null; confidence: string | null }>();
  if (woliIds.length === 0) return out;
  try {
    const sb = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Selected defensively: source/confidence only exist after 156.
    const { data, error } = await sb.from("wo_li_sqft_overrides").select("*").in("woli_id", woliIds);
    if (error || !data) return out;
    for (const r of data as Array<Record<string, unknown>>) {
      out.set(String(r.woli_id), {
        sqft: Number(r.sqft) || 0,
        source: (r.source as string) ?? null,
        confidence: (r.confidence as string) ?? null,
      });
    }
  } catch {
    /* pre-156 — nothing saved yet */
  }
  return out;
}

export default async function MeasurePage({ params }: { params: Promise<{ woId: string }> }) {
  const { woId } = await params;
  const clean = decodeURIComponent(woId).trim().replace(/^['"]|['"]$/g, "");
  const data = await loadOrderPageData(clean);
  if (!data) redirect("/dashboard/materials");
  // Measuring is field work — an Account Manager should be able to do it.
  // Placing the order stays admin-only, gated separately.

  const lineItems = data.job.lineItems;
  const [history, saved] = await Promise.all([
    loadHistory(),
    loadSaved(lineItems.map((li) => li.raw.id)),
  ]);

  const rooms: MeasureRoom[] = lineItems.map((li) => {
    const s = saved.get(li.raw.id);
    return {
      woliId: li.raw.id,
      label: roomLabelFrom(li.raw.areaLabel, li.raw.productName, "Unnamed area"),
      sfSqft: li.raw.sqFootage || 0,
      savedSqft: s?.sqft ?? null,
      savedSource: s?.source ?? null,
      savedConfidence: s?.confidence ?? null,
      surfaces: (li.raw.surfaces ?? "").split(";").map((x) => x.trim()).filter(Boolean),
    };
  });

  // A history suggestion per room, computed server-side so the card can offer
  // it the moment the page opens — no tap, no request.
  const historyByRoom: Record<string, MeasureSuggestion> = {};
  for (const room of rooms) {
    const s = suggestFromHistory(room.label, history);
    if (s) historyByRoom[room.woliId] = s;
  }

  const acct = data.job.wo;
  return (
    <div className="animate-fade-up max-w-3xl mx-auto">
      <MeasureView
        workOrderId={data.workOrderId}
        workOrderNumber={acct.workOrderNumber ?? null}
        customerName={acct.accountName ?? null}
        rooms={rooms}
        address={data.address}
        historyByRoom={historyByRoom}
      />
    </div>
  );
}
