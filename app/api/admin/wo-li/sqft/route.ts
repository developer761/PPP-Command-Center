import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { getSalesforceClient } from "@/lib/salesforce/client";
import { clearSalesforceCache } from "@/lib/salesforce/queries";

/**
 * Update WorkOrderLineItem.Sq_Footage__c in Salesforce.
 *
 * Karan 2026-06-13: PPP's SF team doesn't fill Sq_Footage__c on most WOLI
 * rows — the probe found ~77% of paint-WO rooms have zero measurement. So
 * Materials Ordering needs a per-room editable input on JobDetail. When a
 * worker / admin types a number, we save it to SF immediately so:
 *   (a) the gallon estimator picks it up,
 *   (b) the value persists across sessions and devices,
 *   (c) Salesforce + Command Center stay aligned (one source of truth).
 *
 * After a successful write we invalidate the snapshot cache so the next
 * request fetches fresh data. Yes, that incurs a cold-load cost for the
 * next visitor — but sqft entry is rare (once per WO setup) and the
 * alternative (stale snapshot for 30 min) would have users second-guess
 * whether their change saved.
 *
 *   POST /api/admin/wo-li/sqft
 *   body: { woliId: string, sqft: number }
 *   returns: { ok: true, woliId, sqft }
 *
 * Any authenticated PPP staff user can call this. The Materials page is
 * already worker-scoped at the UI layer (workers see only their WOs), so
 * a worker can only naturally surface woliIds for WOs they own. Karan
 * 2026-06-13: workers MUST be able to enter sqft from the field — leaving
 * this admin-only would have blocked the whole feature for the team.
 *
 * The WOLI Id maps unambiguously to one WorkOrder in SF (every WOLI has a
 * fixed `WorkOrderId` parent), so an SF write here always lands on the
 * correct WO — no risk of cross-WO drift.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Profile lookup is here to log who wrote the value (audit trail in
    // SF's LastModifiedById is the SF connected-app user, so for now we
    // just print the PPP user to logs). Not used for auth — any signed-in
    // staff user can write.
    const profile = await getProfileByUserId(data.user.id);
    const writerLabel = profile?.sf_user_name ?? profile?.email ?? data.user.email ?? data.user.id;

    const body = (await request.json().catch(() => null)) as
      | { woliId?: unknown; sqft?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    // WOLI Id — SF Ids are 15 or 18 chars, [a-zA-Z0-9]. Defensive validation.
    const woliId = typeof body.woliId === "string" ? body.woliId.trim() : "";
    if (!woliId || !/^[a-zA-Z0-9]{15,18}$/.test(woliId)) {
      return NextResponse.json({ error: "invalid_woli_id" }, { status: 400 });
    }

    // Sqft — allow integers >= 0. Cap at 100k to catch fat-finger typos
    // (no real paint room is 100,000 sqft; if it ever happens we'll raise
    // the cap). Reject NaN / negative / non-finite.
    const sqftRaw = typeof body.sqft === "number" ? body.sqft : Number(body.sqft);
    if (!Number.isFinite(sqftRaw) || sqftRaw < 0 || sqftRaw > 100000) {
      return NextResponse.json({ error: "invalid_sqft" }, { status: 400 });
    }
    const sqft = Math.round(sqftRaw);

    const conn = await getSalesforceClient();

    // Fire the update. jsforce throws if the Id doesn't exist / field is
    // FLS-blocked — let the catch below surface a generic error.
    const updateResult = await conn.sobject("WorkOrderLineItem").update({
      Id: woliId,
      Sq_Footage__c: sqft,
    });

    // jsforce can return either a single result or array depending on input
    // shape. We pass a single object so result is single, but coerce
    // defensively.
    const result = Array.isArray(updateResult) ? updateResult[0] : updateResult;
    if (!result || !result.success) {
      const errors = (result as { errors?: Array<{ message?: string }> })?.errors;
      const msg = errors?.[0]?.message ?? "salesforce_update_failed";
      console.error(`[wo-li/sqft] SF write failed for ${woliId}: ${msg}`);
      return NextResponse.json({ error: "salesforce_update_failed", detail: msg }, { status: 502 });
    }

    // Snapshot cache must be invalidated so the next read picks up the new
    // value. Without this, the user would type 150 → SF has 150 → but the
    // page on next reload still shows 0 for ~30 min until TTL expires. This
    // is the right tradeoff per the comment at the top of the file.
    await clearSalesforceCache();

    console.log(
      `[wo-li/sqft] ${writerLabel} set Sq_Footage__c=${sqft} on WOLI ${woliId}`
    );
    return NextResponse.json({ ok: true, woliId, sqft });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[wo-li/sqft] unhandled error: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
