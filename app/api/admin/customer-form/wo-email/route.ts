import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Look up a work order's customer email DIRECTLY from Salesforce so the
 * "Send Color Form" modal can pre-fill it — regardless of whether that
 * customer made the top-5,000-by-revenue snapshot the materials page loads.
 *
 *   GET /api/admin/customer-form/wo-email?workOrderId=<id>
 *
 * Returns { ok:true, email } (email may be null if SF has none). Soft-fails
 * (200 + email:null) on any SF error so the modal still lets the worker type.
 * Admin-only.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const workOrderId = new URL(request.url).searchParams.get("workOrderId");
  // SF ids are 15/18 alphanumeric — validate before interpolating into SOQL.
  if (!workOrderId || !/^[a-zA-Z0-9]{15,18}$/.test(workOrderId)) {
    return NextResponse.json({ error: "invalid_work_order_id" }, { status: 400 });
  }

  try {
    const conn = await getSalesforceClient();
    // Person Account customers (PPP's model) store email in PersonEmail, reached
    // via the WO's Opportunity → Account relationship (same path render-data uses).
    const r = await conn.query<Record<string, unknown>>(
      `SELECT Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`
    );
    const rec = r.records[0] as
      | { Opportunity__r?: { Account?: { PersonEmail?: string | null; Name?: string | null } } }
      | undefined;
    const acct = rec?.Opportunity__r?.Account;
    const email = (typeof acct?.PersonEmail === "string" && acct.PersonEmail.trim()) ? acct.PersonEmail.trim() : null;
    return NextResponse.json({ ok: true, email, customerName: acct?.Name ?? null });
  } catch (err) {
    // Soft-fail — the modal still works, the worker just types the email.
    console.warn("[customer-form/wo-email] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: true, email: null });
  }
}
