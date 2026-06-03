import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Email-schema diagnostic — returns the value of every plausible
 * customer-email field for a given WO so admin can pinpoint WHERE
 * PPP actually stores customer emails in Salesforce.
 *
 *   GET /api/admin/customer-form/wo-email-debug?workOrderId=<id>
 *
 * Returns (JSON):
 *   {
 *     workOrderId,
 *     fields: {
 *       "WorkOrder.Contact.Email": "..." | null,
 *       "WorkOrder.Contact.Name": "..." | null,
 *       "WorkOrder.Opportunity.Account.PersonEmail": "..." | null,
 *       "WorkOrder.Opportunity.Account.Email__c": "..." | null,
 *       "WorkOrder.Opportunity.Account.Primary_Contact.Email": "..." | null,
 *       "WorkOrder.Opportunity.Primary_Contact.Email": "..." | null,
 *       "Account.Contacts[]": [{Id, Name, Email, CreatedDate}, ...]
 *     },
 *     winning_path: "..." | null,
 *     winning_value: "..." | null
 *   }
 *
 * Admin-only. Returns ACTUAL email values (not hashed) — this is a
 * diagnostic tool used by trusted admins, not a customer-facing API.
 *
 * If a field doesn't exist in PPP's org (INVALID_FIELD), that field is
 * marked `"<field doesn't exist on this org>"` in the response instead
 * of taking down the whole diagnostic.
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
  if (!workOrderId || !/^[a-zA-Z0-9]{15,18}$/.test(workOrderId)) {
    return NextResponse.json({ error: "invalid_work_order_id" }, { status: 400 });
  }

  const conn = await getSalesforceClient();
  const fields: Record<string, unknown> = {};

  // Pull every field path individually with its own try/catch so a single
  // missing field doesn't kill the whole diagnostic. INVALID_FIELD on any
  // path marks just that field as unavailable.
  const probes: Array<{ key: string; soql: string; extract: (rec: Record<string, unknown>) => unknown }> = [
    {
      key: "WorkOrder.Contact.Email",
      soql: `SELECT Contact.Email FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => (r.Contact as Record<string, unknown> | null)?.Email ?? null,
    },
    {
      key: "WorkOrder.Contact.Name",
      soql: `SELECT Contact.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => (r.Contact as Record<string, unknown> | null)?.Name ?? null,
    },
    {
      key: "WorkOrder.Contact.MobilePhone",
      soql: `SELECT Contact.MobilePhone FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => (r.Contact as Record<string, unknown> | null)?.MobilePhone ?? null,
    },
    {
      key: "WorkOrder.Opportunity.Account.Id",
      soql: `SELECT Opportunity__r.Account.Id FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => ((r.Opportunity__r as Record<string, unknown> | null)?.Account as Record<string, unknown> | undefined)?.Id ?? null,
    },
    {
      key: "WorkOrder.Opportunity.Account.Name",
      soql: `SELECT Opportunity__r.Account.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => ((r.Opportunity__r as Record<string, unknown> | null)?.Account as Record<string, unknown> | undefined)?.Name ?? null,
    },
    {
      key: "WorkOrder.Opportunity.Account.PersonEmail",
      soql: `SELECT Opportunity__r.Account.PersonEmail FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => ((r.Opportunity__r as Record<string, unknown> | null)?.Account as Record<string, unknown> | undefined)?.PersonEmail ?? null,
    },
    {
      key: "WorkOrder.Opportunity.Account.Email__c",
      soql: `SELECT Opportunity__r.Account.Email__c FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => ((r.Opportunity__r as Record<string, unknown> | null)?.Account as Record<string, unknown> | undefined)?.Email__c ?? null,
    },
    {
      key: "WorkOrder.Opportunity.Account.Primary_Contact__r.Email",
      soql: `SELECT Opportunity__r.Account.Primary_Contact__r.Email FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => (((r.Opportunity__r as Record<string, unknown> | null)?.Account as Record<string, unknown> | undefined)?.Primary_Contact__r as Record<string, unknown> | undefined)?.Email ?? null,
    },
    {
      key: "WorkOrder.Opportunity.Primary_Contact__r.Email",
      soql: `SELECT Opportunity__r.Primary_Contact__r.Email FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => ((r.Opportunity__r as Record<string, unknown> | null)?.Primary_Contact__r as Record<string, unknown> | undefined)?.Email ?? null,
    },
    {
      key: "WorkOrder.Opportunity.Primary_Contact__r.Name",
      soql: `SELECT Opportunity__r.Primary_Contact__r.Name FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`,
      extract: (r) => ((r.Opportunity__r as Record<string, unknown> | null)?.Primary_Contact__r as Record<string, unknown> | undefined)?.Name ?? null,
    },
  ];

  for (const p of probes) {
    try {
      const result = await conn.query<Record<string, unknown>>(p.soql);
      const rec = result.records[0];
      fields[p.key] = rec ? p.extract(rec) : null;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // Mark unavailable when the field doesn't exist on this org —
      // distinct from "field exists but is empty" (null above).
      fields[p.key] = `<unavailable: ${m.slice(0, 80)}>`;
    }
  }

  // Account's child Contacts (related list) — most-recent first, capped at 5.
  // Useful when admin wants to see if there's any Contact tied to this
  // customer with a usable email, even if no direct path links it.
  const accountId = fields["WorkOrder.Opportunity.Account.Id"];
  if (typeof accountId === "string" && accountId) {
    try {
      const r = await conn.query<{ Id: string; Email: string | null; Name: string | null; CreatedDate: string }>(
        `SELECT Id, Email, Name, CreatedDate FROM Contact WHERE AccountId = '${accountId}' ORDER BY CreatedDate DESC LIMIT 5`
      );
      fields["Account.Contacts[] (most recent 5)"] = r.records.map((c) => ({
        Id: c.Id,
        Name: c.Name,
        Email: c.Email,
        CreatedDate: c.CreatedDate,
      }));
    } catch (err) {
      fields["Account.Contacts[]"] = `<unavailable: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}>`;
    }
  } else {
    fields["Account.Contacts[]"] = "<no Account on this WO — can't list contacts>";
  }

  // Compute the winning path the production lookup WOULD use today, so
  // admin can see which path the customer-form modal would actually pick.
  const isUsableEmail = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0 && !v.startsWith("<");
  const priorityChain = [
    "WorkOrder.Contact.Email",
    "WorkOrder.Opportunity.Account.PersonEmail",
    "WorkOrder.Opportunity.Account.Email__c",
    "WorkOrder.Opportunity.Account.Primary_Contact__r.Email",
    "WorkOrder.Opportunity.Primary_Contact__r.Email",
  ];
  let winningPath: string | null = null;
  let winningValue: string | null = null;
  for (const key of priorityChain) {
    const v = fields[key];
    if (isUsableEmail(v)) {
      winningPath = key;
      winningValue = v.trim();
      break;
    }
  }
  // If no direct path won, check child-Contacts fallback
  if (!winningPath) {
    const contacts = fields["Account.Contacts[] (most recent 5)"];
    if (Array.isArray(contacts)) {
      const first = contacts.find(
        (c: { Email: string | null }) => isUsableEmail(c.Email)
      );
      if (first && typeof first.Email === "string") {
        winningPath = "Account.Contacts[] (most recent with Email)";
        winningValue = first.Email.trim();
      }
    }
  }

  return NextResponse.json({
    ok: true,
    workOrderId,
    fields,
    winning_path: winningPath,
    winning_value: winningValue,
    instructions: winningPath
      ? `The customer-form modal will pre-fill with this email from ${winningPath}.`
      : `No email found on this WO via any known path. Check the Account.Contacts[] list above — if there's a Contact with an email, link it to the WO (set the WorkOrder.ContactId field) so the form can find it.`,
  });
}
