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
    // Pull customer email from EVERY plausible PPP schema location, then
    // prefer them in priority order. The chain (highest → lowest):
    //
    //   1. WorkOrder.Contact.Email                       (Katie's canonical path)
    //   2. Account.PersonEmail                            (Person Account model)
    //   3. Account.Email__c                               (Business Account custom)
    //   4. Account.Primary_Contact__r.Email               (Account's primary contact)
    //   5. Opportunity.Primary_Contact__r.Email           (Opp's primary contact)
    //   6. Most-recent child Contact on the Account.Email (related list)
    //
    // We tried only the Account-side paths originally, then added
    // WorkOrder.Contact, but Katie was still seeing blanks — so this commit
    // expands to cover the Opportunity-Primary-Contact path AND the child-
    // Contacts related list on the Account. If admin still sees blanks
    // after this, hit /api/admin/customer-form/wo-email-debug?workOrderId=X
    // for a full schema dump showing every email field's actual value.
    //
    // Falls back through progressively narrower SELECTs on INVALID_FIELD so
    // missing/FLS'd fields don't break the lookup. Diagnostic console.log
    // shows the winning source name (no email value logged — PII safe).
    type ContactEmailFields = { Email?: string | null; Name?: string | null };
    type AcctEmailFields = {
      Id?: string | null;
      PersonEmail?: string | null;
      Email__c?: string | null;
      Name?: string | null;
      Primary_Contact__r?: { Email?: string | null } | null;
    };
    type OppEmailFields = {
      Account?: AcctEmailFields;
      Primary_Contact__r?: { Email?: string | null; Name?: string | null } | null;
    };
    type WoEmailShape = {
      Contact?: ContactEmailFields | null;
      Opportunity__r?: OppEmailFields;
    };
    // Progressive query fallbacks. Each fewer field than the previous so a
    // single missing/FLS'd field never kills the whole lookup. The widest
    // query also includes Opp.Primary_Contact path; the narrowest falls
    // back to the Account-only fields (covers orgs without WorkOrder.ContactId).
    const queries: Array<{ label: string; soql: string }> = [
      {
        label: "all (WO.Contact + Account.* + Opp.Primary_Contact)",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.Id, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Primary_Contact__r.Email, Opportunity__r.Account.Name, Opportunity__r.Primary_Contact__r.Email, Opportunity__r.Primary_Contact__r.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "drop-opp-primary-contact",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.Id, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Primary_Contact__r.Email, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "drop-account-primary-contact",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.Id, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "drop-email-custom",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.Id, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "contact-only",
        soql: `SELECT Contact.Email, Contact.Name, Opportunity__r.Account.Id, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
      {
        label: "account-only (no WO.ContactId on this org)",
        soql: `SELECT Opportunity__r.Account.Id, Opportunity__r.Account.PersonEmail, Opportunity__r.Account.Email__c, Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      },
    ];
    let row: WoEmailShape | undefined;
    let lastErr: unknown = null;
    for (const q of queries) {
      try {
        const r = await conn.query<Record<string, unknown>>(q.soql);
        row = r.records[0] as WoEmailShape | undefined;
        if (row || r.records.length > 0) break;
      } catch (err) {
        lastErr = err;
        console.warn(`[customer-form/wo-email] ${q.label} query failed, trying narrower:`, err instanceof Error ? err.message : err);
      }
    }
    if (row === undefined && lastErr) throw lastErr;

    const contact = row?.Contact ?? null;
    const opp = row?.Opportunity__r;
    const account = opp?.Account;
    const oppPrimary = opp?.Primary_Contact__r ?? null;

    const contactDirectEmail = typeof contact?.Email === "string" ? contact.Email.trim() : "";
    const personEmail = typeof account?.PersonEmail === "string" ? account.PersonEmail.trim() : "";
    const customEmail = typeof account?.Email__c === "string" ? account.Email__c.trim() : "";
    const acctPrimaryEmail = typeof account?.Primary_Contact__r?.Email === "string" ? account.Primary_Contact__r.Email.trim() : "";
    const oppPrimaryEmail = typeof oppPrimary?.Email === "string" ? oppPrimary.Email.trim() : "";

    let email = contactDirectEmail || personEmail || customEmail || acctPrimaryEmail || oppPrimaryEmail || null;
    let source = contactDirectEmail ? "WorkOrder.Contact.Email"
               : personEmail ? "Account.PersonEmail"
               : customEmail ? "Account.Email__c"
               : acctPrimaryEmail ? "Account.Primary_Contact__r.Email"
               : oppPrimaryEmail ? "Opportunity.Primary_Contact__r.Email"
               : "(none)";

    // If every direct path came up empty, fall back to the Account's child
    // Contacts (related list). Most-recent Contact wins (matches PPP's
    // "latest active contact for this customer" semantics). Skipped when
    // we don't even have an Account id (WO with no Opp) — nothing to query.
    if (!email && account?.Id) {
      try {
        const childRes = await conn.query<{ Id: string; Email: string | null; Name: string | null; CreatedDate: string }>(
          `SELECT Id, Email, Name, CreatedDate FROM Contact WHERE AccountId = '${account.Id}' AND Email != null ORDER BY CreatedDate DESC LIMIT 1`
        );
        const childContact = childRes.records[0];
        if (childContact?.Email) {
          email = childContact.Email.trim();
          source = "Account.Contacts (most recent with email)";
        }
      } catch (childErr) {
        console.warn(`[customer-form/wo-email] child-Contact fallback failed:`, childErr instanceof Error ? childErr.message : childErr);
      }
    }

    // Diagnostic — winning source name only, no PII. Confirms which path
    // PPP's data actually lives on so we can prune dead fallbacks later.
    console.log(`[customer-form/wo-email] WO=${workOrderId.slice(0, 6)}… email source: ${source} ${email ? "(populated)" : "(EMPTY — no email anywhere on this WO/Account/Contact)"}`);

    // Customer name priority: WorkOrder.Contact.Name → Opp.Primary_Contact.Name
    // → Account.Name. Use the most-specific name we have so the modal
    // pre-fills the actual person we're emailing.
    const customerName = (typeof contact?.Name === "string" && contact.Name.trim())
      ? contact.Name.trim()
      : (typeof oppPrimary?.Name === "string" && oppPrimary.Name.trim())
        ? oppPrimary.Name.trim()
        : (account?.Name ?? null);
    return NextResponse.json({ ok: true, email, customerName, source });
  } catch (err) {
    // Soft-fail — the modal still works, the worker just types the email.
    console.warn("[customer-form/wo-email] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: true, email: null });
  }
}
