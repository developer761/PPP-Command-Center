import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getProfileByUserId } from "@/lib/auth/profile";

/**
 * Persist a per-room square-footage override for Materials Ordering.
 *
 * Kate #17 / Karan 2026-06-13: ~77% of PPP's open paint rooms have no
 * Sq_Footage__c in Salesforce, so JobDetail lets staff type it in. This USED
 * to write Sq_Footage__c back to Salesforce — but that field is a FORMULA
 * field, so every write was rejected (502) and the value never persisted.
 *
 * Now we store the value in Command Center (`wo_li_sqft_overrides`, migration
 * 073) and hydrate it on page load. Salesforce stays source of truth for
 * rooms/colors; this is just the human-entered measurement overlay the gallon
 * estimator needs, and a local value always wins over the SF value.
 *
 *   POST /api/admin/wo-li/sqft
 *   body: { woliId: string, sqft: number, workOrderId?: string }
 *   returns: { ok: true, woliId, sqft }   (sqft 0 clears the override)
 *
 * Any authenticated PPP staff user can call this (workers must enter sqft from
 * the field; the Materials UI is already scope-gated).
 */

function overridesClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
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
      | { woliId?: unknown; sqft?: unknown; workOrderId?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    // WOLI Id — SF Ids are 15 or 18 chars, [a-zA-Z0-9]. Defensive validation.
    const woliId = typeof body.woliId === "string" ? body.woliId.trim() : "";
    if (!woliId || !/^[a-zA-Z0-9]{15,18}$/.test(woliId)) {
      return NextResponse.json({ error: "invalid_woli_id" }, { status: 400 });
    }

    const workOrderId =
      typeof body.workOrderId === "string" && /^[a-zA-Z0-9]{15,18}$/.test(body.workOrderId.trim())
        ? body.workOrderId.trim()
        : null;

    // Sqft — allow integers >= 0. Cap at 100k to catch fat-finger typos.
    // Reject NaN / negative / non-finite.
    const sqftRaw = typeof body.sqft === "number" ? body.sqft : Number(body.sqft);
    if (!Number.isFinite(sqftRaw) || sqftRaw < 0 || sqftRaw > 100000) {
      return NextResponse.json({ error: "invalid_sqft" }, { status: 400 });
    }
    const sqft = Math.round(sqftRaw);

    const sb = overridesClient();

    // sqft === 0 clears the override (fall back to the SF value / empty).
    if (sqft === 0) {
      const { error } = await sb
        .from("wo_li_sqft_overrides")
        .delete()
        .eq("woli_id", woliId);
      if (error) {
        console.error(`[wo-li/sqft] clear failed for ${woliId}: ${error.message}`);
        return NextResponse.json({ error: "save_failed", detail: error.message }, { status: 500 });
      }
      console.log(`[wo-li/sqft] ${writerLabel} cleared override on WOLI ${woliId}`);
      return NextResponse.json({ ok: true, woliId, sqft: 0 });
    }

    const { error } = await sb.from("wo_li_sqft_overrides").upsert(
      {
        woli_id: woliId,
        work_order_id: workOrderId,
        sqft,
        updated_by: writerLabel,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "woli_id" }
    );
    if (error) {
      console.error(`[wo-li/sqft] save failed for ${woliId}: ${error.message}`);
      return NextResponse.json({ error: "save_failed", detail: error.message }, { status: 500 });
    }

    console.log(`[wo-li/sqft] ${writerLabel} set sqft=${sqft} on WOLI ${woliId}`);
    return NextResponse.json({ ok: true, woliId, sqft });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[wo-li/sqft] unhandled error: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
