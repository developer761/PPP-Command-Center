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
    // Pull customer email from every plausible PPP schema location in ONE
    // round-trip, then prefer them in this order:
    //   • WorkOrder.Contact.Email             (Katie's canonical answer
    //                                          2026-06-03 — PPP stores the
    //                                          customer email on the Contact
    //                                          linked to the Work Order)
    //   • Account.PersonEmail                  (Person Account model)
    //   • Account.Email__c                     (Business Account custom field)
    //   • Account.Primary_Contact__r.Email     (Account → Primary Contact → Email)
    //
    // We tried only the Account-side paths before this commit, which silently
    // failed for every PPP customer whose email lives on WorkOrder.Contact.
    // Falls back through progressively narrower SELECTs on INVALID_FIELD so
    // missing/FLS'd fields don't take down the whole lookup. Diagnostic
    // console.log shows the winning source (or that none had data) in Vercel
    // logs so we can confirm Katie's path against PPP's real data.
    type ContactEmailFields = {
      Email?: string | null;
      Name?: string | null;
    };
    type AcctEmailFields = {
      PersonEmail?: string | null;
      Email__c?: string | null;
      Name?: string | null;
      Primary_Contact__r?: { Email?: string | null } | null;
    };
    type WoEmailShape = {
      Contact?: ContactEmailFields | null;
      Opportunity__r?: { Account?: AcctEmailFields };
    };
    let row: WoEmailShape | undefined;
    const queries: Array<{ label: string; soql: string }> = [
      {
        label: "full (Contact.Email + PersonEmail + Email__c + Primary_Contact__r.Email)",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Primary_Contact__r.Email, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "drop-primary-contact (Contact.Email + PersonEmail + Email__c)",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "drop-email-custom (Contact.Email + PersonEmail)",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "contact-only (Contact.Email only)",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "account-only (no Contact field on WorkOrder for this org)",
        soql: `SELECT Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
    ];
    let lastErr: unknown = null;
    for (const q of queries) {
      try {
        const r = await conn.query<Record<string, unknown>>(q.soql);
        row = r.records[0] as WoEmailShape | undefined;
        if (row || r.records.length > 0) {
          // Query succeeded (record found, or WO simply doesn't have an Opp)
          break;
        }
      } catch (err) {
        lastErr = err;
        console.warn(`[customer-form/wo-email] ${q.label} query failed, trying narrower:`, err instanceof Error ? err.message : err);
        // Keep iterating to the next narrower query.
      }
    }
    if (row === undefined && lastErr) {
      // Every fallback failed — surface as soft-fail (email:null) so the
      // modal still works (worker types the email manually).
      throw lastErr;
    }

    const contact = row?.Contact ?? null;
    const account = row?.Opportunity__r?.Account;
    const contactDirectEmail = typeof contact?.Email === "string" ? contact.Email.trim() : "";
    const personEmail = typeof account?.PersonEmail === "string" ? account.PersonEmail.trim() : "";
    const customEmail = typeof account?.Email__c === "string" ? account.Email__c.trim() : "";
    const primaryContactEmail = typeof account?.Primary_Contact__r?.Email === "string" ? account.Primary_Contact__r.Email.trim() : "";
    // Priority chain — Katie's path first, then the fallbacks.
    const email = contactDirectEmail || personEmail || customEmail || primaryContactEmail || null;

    // Diagnostic — log WHICH source supplied the email (or that none did).
    // Helps Karan + me see in Vercel logs which schema location PPP customers
    // actually use, and confirm Katie's WorkOrder.Contact.Email path against
    // real data. Email itself NOT logged so PII doesn't end up in long-term
    // log retention — only the field name + populated/empty signal.
    const source = contactDirectEmail ? "WorkOrder.Contact.Email"
                 : personEmail ? "Account.PersonEmail"
                 : customEmail ? "Account.Email__c"
                 : primaryContactEmail ? "Account.Primary_Contact__r.Email"
                 : "(none)";
    console.log(`[customer-form/wo-email] WO=${workOrderId.slice(0, 6)}… email source: ${source} ${email ? "(populated)" : "(EMPTY — no email on file)"}`);

    // Customer name: WorkOrder.Contact.Name is the most specific (the actual
    // person we're emailing); fall back to the account name if Contact is null.
    const customerName = (typeof contact?.Name === "string" && contact.Name.trim()) ? contact.Name.trim() : (account?.Name ?? null);
    return NextResponse.json({ ok: true, email, customerName, source });
  } catch (err) {
    // Soft-fail — the modal still works, the worker just types the email.
    console.warn("[customer-form/wo-email] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: true, email: null });
  }
}
