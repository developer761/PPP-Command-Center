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
    // Try Person-Account email first (PPP's primary customer model) plus the
    // Business-Account custom Email__c fallback in a single round-trip. Either
    // can be null per-customer; we pick the populated one.
    type AcctEmailFields = { PersonEmail?: string | null; Email__c?: string | null; Name?: string | null };
    type AcctEmailShape = { Opportunity__r?: { Account?: AcctEmailFields } };
    let account: AcctEmailFields | undefined;
    try {
      const r = await conn.query<Record<string, unknown>>(
        `SELECT Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`
      );
      account = (r.records[0] as AcctEmailShape | undefined)?.Opportunity__r?.Account;
    } catch (richErr) {
      // INVALID_FIELD if Email__c doesn't exist on this org → fall back to the
      // narrower query without it.
      console.warn("[customer-form/wo-email] rich query failed, retrying without Email__c:", richErr instanceof Error ? richErr.message : richErr);
      const r = await conn.query<Record<string, unknown>>(
        `SELECT Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`
      );
      account = (r.records[0] as AcctEmailShape | undefined)?.Opportunity__r?.Account;
    }
    const personEmail = typeof account?.PersonEmail === "string" ? account.PersonEmail.trim() : "";
    const customEmail = typeof account?.Email__c === "string" ? account.Email__c.trim() : "";
    const email = personEmail || customEmail || null;
    return NextResponse.json({ ok: true, email, customerName: account?.Name ?? null });
  } catch (err) {
    // Soft-fail — the modal still works, the worker just types the email.
    console.warn("[customer-form/wo-email] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: true, email: null });
  }
}
