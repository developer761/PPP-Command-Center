import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole } from "@/lib/auth/roles";
import { writeSf } from "@/lib/salesforce/writeback";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Write the Work Order's Follow-up Date back to Salesforce (Kate round-2 #03).
 * The Materials WO page mirrors `WorkOrder.FollowupDate__c` and lets an admin /
 * account manager edit it; this persists the change to SF.
 *
 *   POST /api/dashboard/materials/followup
 *   body: { workOrderId: string, date: "YYYY-MM-DD" | "" }   ("" clears it)
 *
 * Access: `canEnterColors` (admin or account manager) — same gate as the
 * sqft-override + supplier-order routes, so a scoped Sales Rep can't write.
 * PPP's org casing for the field is ambiguous in the data dictionary, so we
 * try `FollowupDate__c` first and fall back to `FollowUpDate__c` on an
 * invalid-field error.
 */

const WO_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const profile = await getProfileByUserId(data.user.id);
    if (profile && profile.is_active === false && !isAdminEmail(data.user.email)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const canEnterColors = capabilitiesFor(
      normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email))
    ).canEnterColors;
    if (!canEnterColors) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const body = (await request.json().catch(() => null)) as
      | { workOrderId?: unknown; date?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    const workOrderId = typeof body.workOrderId === "string" ? body.workOrderId.trim() : "";
    if (!WO_ID_RE.test(workOrderId)) {
      return NextResponse.json({ error: "invalid_wo_id" }, { status: 400 });
    }
    const rawDate = typeof body.date === "string" ? body.date.trim() : "";
    if (rawDate && !DATE_RE.test(rawDate)) {
      return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    }
    const value = rawDate || null; // "" → clear the date in SF

    // Kate round-3 #13: save in the Command Center FIRST, then push to
    // Salesforce. Round 2 wrote only to SF, so when the field didn't resolve
    // under either casing the date silently never existed and the Mail Hub's
    // follow-up filter matched nothing on every date. The local copy is what
    // the Command Center filters and displays; Salesforce still gets the push.
    let savedLocally = false;
    try {
      const sb = createSupabaseAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SECRET_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      if (value) {
        const { error } = await sb.from("wo_followup_dates").upsert(
          {
            work_order_id: workOrderId,
            followup_date: value,
            updated_by: data.user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "work_order_id" }
        );
        if (error) throw error;
      } else {
        const { error } = await sb.from("wo_followup_dates").delete().eq("work_order_id", workOrderId);
        if (error) throw error;
      }
      savedLocally = true;
    } catch (err) {
      // Migration 146 pending, or the table is unreachable. Not fatal — the SF
      // push below is still attempted, and the response says what happened.
      console.warn("[materials/followup] local save unavailable:", err);
    }

    const ctx = { source: "admin_manual" as const, triggeredByUserId: data.user.id };
    // Try the two casings PPP's org might use.
    let result = await writeSf(
      { sObject: "WorkOrder", recordId: workOrderId, fields: { FollowupDate__c: value } },
      ctx
    );
    if (!result.ok && /INVALID_FIELD|No such column|FollowupDate__c/i.test(result.error)) {
      result = await writeSf(
        { sObject: "WorkOrder", recordId: workOrderId, fields: { FollowUpDate__c: value } },
        ctx
      );
    }
    if (!result.ok) {
      // Never lose the date over a Salesforce problem. When the Command Center
      // save landed, the user's action DID stick — tell them the truth (saved
      // here, not in Salesforce) rather than a bare failure that invites them
      // to retype it. Kate round-3 #30 is the general form of this.
      if (savedLocally) {
        return NextResponse.json({
          ok: true,
          date: value,
          salesforceSynced: false,
          warning: `Saved in the Command Center, but Salesforce rejected it: ${result.error}`,
        });
      }
      return NextResponse.json({ error: "save_failed", detail: result.error }, { status: 502 });
    }
    return NextResponse.json({ ok: true, date: value, salesforceSynced: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[materials/followup] unhandled error: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
