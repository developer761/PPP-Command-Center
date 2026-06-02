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
    // Try several PPP customer-email locations in one round-trip:
    //   • Account.PersonEmail            (Person Account model — PPP's primary)
    //   • Account.Email__c               (Business Account custom field — fallback)
    //   • Account.Primary_Contact__r.Email  (Account.Primary_Contact lookup → Contact email)
    // On INVALID_FIELD (org doesn't have one of the optional fields), fall
    // back to a narrower SELECT progressively. Diagnostic console.log shows
    // which source actually provided the email (or that nothing did) so
    // production logs surface PPP's real schema.
    type AcctEmailFields = {
      PersonEmail?: string | null;
      Email__c?: string | null;
      Name?: string | null;
      Primary_Contact__r?: { Email?: string | null } | null;
    };
    type AcctEmailShape = { Opportunity__r?: { Account?: AcctEmailFields } };
    let account: AcctEmailFields | undefined;
    const queries: Array<{ label: string; soql: string }> = [
      {
        label: "rich (PersonEmail + Email__c + Primary_Contact__r.Email)",
        soql: `SELECT Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Primary_Contact__r.Email, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "medium (PersonEmail + Email__c)",
        soql: `SELECT Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "narrow (PersonEmail only)",
        soql: `SELECT Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
    ];
    let lastErr: unknown = null;
    for (const q of queries) {
      try {
        const r = await conn.query<Record<string, unknown>>(q.soql);
        account = (r.records[0] as AcctEmailShape | undefined)?.Opportunity__r?.Account;
        if (account || r.records.length > 0) {
          // Query succeeded (record found, or WO simply doesn't have an Opp)
          break;
        }
      } catch (err) {
        lastErr = err;
        console.warn(`[customer-form/wo-email] ${q.label} query failed, trying narrower:`, err instanceof Error ? err.message : err);
        // Keep iterating to the next narrower query.
      }
    }
    if (account === undefined && lastErr) {
      // All three queries failed — surface as soft-fail (email:null) so the
      // modal still works.
      throw lastErr;
    }

    const personEmail = typeof account?.PersonEmail === "string" ? account.PersonEmail.trim() : "";
    const customEmail = typeof account?.Email__c === "string" ? account.Email__c.trim() : "";
    const contactEmail = typeof account?.Primary_Contact__r?.Email === "string" ? account.Primary_Contact__r.Email.trim() : "";
    const email = personEmail || customEmail || contactEmail || null;

    // Diagnostic — log WHICH source supplied the email (or that none did).
    // Helps Karan + me see in Vercel logs whether PPP customers actually
    // have email anywhere, and if so, which field. Truncated so the email
    // itself doesn't end up in long-term log retention.
    const source = personEmail ? "PersonEmail" : customEmail ? "Email__c" : contactEmail ? "Primary_Contact__r.Email" : "(none)";
    console.log(`[customer-form/wo-email] WO=${workOrderId.slice(0, 6)}… email source: ${source} ${email ? "(populated)" : "(EMPTY — no email on file)"}`);

    return NextResponse.json({ ok: true, email, customerName: account?.Name ?? null, source });
  } catch (err) {
    // Soft-fail — the modal still works, the worker just types the email.
    console.warn("[customer-form/wo-email] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: true, email: null });
  }
}
