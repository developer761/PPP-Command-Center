import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Schema-driven email diagnostic — DESCRIBES every object in the lookup
 * chain at runtime, finds every field whose type is "email" or whose name
 * contains "email", and pulls all of their values for the given WO.
 *
 * No more guessing where PPP stores customer emails. Whatever field they
 * use, this finds it.
 *
 *   GET /api/admin/customer-form/wo-email-debug?workOrderId=<id>
 *
 * Returns:
 *   {
 *     workOrderId,
 *     wo_object_email_fields: ["..."],   // every email-named field on WorkOrder
 *     account_email_fields: ["..."],
 *     opp_email_fields: ["..."],
 *     contact_email_fields: ["..."],
 *     values: { "<fullPath>": "<value or null>", ... },
 *     account_contacts: [{ Id, Name, Email, CreatedDate, ... }],
 *     winning_path: "...",
 *     winning_value: "...",
 *     instructions: "..."
 *   }
 *
 * Admin-only.
 */

type SfField = {
  name: string;
  type: string;
  label?: string;
  referenceTo?: string[];
  relationshipName?: string | null;
};

type SfDescribeResult = {
  fields: SfField[];
};

/** Find every field whose type is "email" OR whose name/label includes "email" — case-insensitive. */
function findEmailFields(meta: SfDescribeResult): string[] {
  return meta.fields
    .filter((f) => {
      if (f.type === "email") return true;
      const n = (f.name + " " + (f.label ?? "")).toLowerCase();
      return n.includes("email");
    })
    .map((f) => f.name);
}

/** Find every reference (lookup/master-detail) field on an object. */
function findReferenceFields(meta: SfDescribeResult): Array<{ field: string; relationshipName: string; referenceTo: string[] }> {
  return meta.fields
    .filter((f) => f.type === "reference" && f.relationshipName)
    .map((f) => ({ field: f.name, relationshipName: f.relationshipName!, referenceTo: f.referenceTo ?? [] }));
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const workOrderId = new URL(request.url).searchParams.get("workOrderId");
  if (!workOrderId || !/^[a-zA-Z0-9]{15,18}$/.test(workOrderId)) {
    return NextResponse.json({ error: "invalid_work_order_id" }, { status: 400 });
  }

  const conn = await getSalesforceClient();

  // Step 1: DESCRIBE the four relevant objects.
  const [woMeta, accountMeta, oppMeta, contactMeta] = await Promise.all([
    conn.sobject("WorkOrder").describe() as unknown as Promise<SfDescribeResult>,
    conn.sobject("Account").describe() as unknown as Promise<SfDescribeResult>,
    conn.sobject("Opportunity").describe().catch(() => ({ fields: [] }) as SfDescribeResult) as Promise<SfDescribeResult>,
    conn.sobject("Contact").describe() as unknown as Promise<SfDescribeResult>,
  ]);

  // Step 2: Find every email-named field on each object.
  const woEmailFields = findEmailFields(woMeta);          // e.g. ["Customer_Email__c"]
  const accountEmailFields = findEmailFields(accountMeta); // e.g. ["PersonEmail", "Email__c"]
  const oppEmailFields = findEmailFields(oppMeta);        // e.g. ["Customer_Email__c"]
  const contactEmailFields = findEmailFields(contactMeta); // e.g. ["Email"]

  // Step 3: Find reference fields on WorkOrder that point at Account/Contact/Opportunity
  // and on Opportunity that point at Account/Contact. This lets us build the
  // full set of paths from WorkOrder → email field.
  const woRefs = findReferenceFields(woMeta);
  const oppRefs = findReferenceFields(oppMeta);
  const accountRefs = findReferenceFields(accountMeta);

  // Build the path → SOQL-fragment mapping. Each path is the FULL dotted
  // path from WorkOrder. Examples:
  //   WorkOrder direct: "Customer_Email__c"
  //   WO → Contact: "Contact.Email"
  //   WO → Opportunity__r → Account → PersonEmail: "Opportunity__r.Account.PersonEmail"
  //   WO → AccountId → PersonEmail: "Account.PersonEmail"
  const pathsToQuery: string[] = [];

  // Direct WorkOrder email fields (rare but possible)
  for (const f of woEmailFields) pathsToQuery.push(f);

  // WO → Contact (the standard FSL ContactId on WorkOrder)
  const woContactRef = woRefs.find((r) => r.referenceTo.includes("Contact"));
  if (woContactRef) {
    for (const f of contactEmailFields) pathsToQuery.push(`${woContactRef.relationshipName}.${f}`);
    pathsToQuery.push(`${woContactRef.relationshipName}.Name`);
  }

  // WO → Account (FSL AccountId)
  const woAccountRef = woRefs.find((r) => r.referenceTo.includes("Account"));
  if (woAccountRef) {
    for (const f of accountEmailFields) pathsToQuery.push(`${woAccountRef.relationshipName}.${f}`);
    pathsToQuery.push(`${woAccountRef.relationshipName}.Id`);
    pathsToQuery.push(`${woAccountRef.relationshipName}.Name`);
    // Walk Account's reference fields too — e.g., Account → Primary_Contact__c → Contact.Email
    for (const acctRef of accountRefs) {
      if (acctRef.referenceTo.includes("Contact")) {
        for (const f of contactEmailFields) {
          pathsToQuery.push(`${woAccountRef.relationshipName}.${acctRef.relationshipName}.${f}`);
        }
      }
    }
  }

  // WO → Opportunity (PPP's custom Opportunity__c link)
  const woOppRef = woRefs.find((r) => r.referenceTo.includes("Opportunity"));
  if (woOppRef) {
    // Opportunity's own email fields (rare)
    for (const f of oppEmailFields) pathsToQuery.push(`${woOppRef.relationshipName}.${f}`);
    // Opportunity → Account → PersonEmail / Email__c
    const oppAcctRef = oppRefs.find((r) => r.referenceTo.includes("Account"));
    if (oppAcctRef) {
      for (const f of accountEmailFields) pathsToQuery.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.${f}`);
      pathsToQuery.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.Id`);
      pathsToQuery.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.Name`);
      // Opportunity → Account → Primary_Contact__c → Email
      for (const acctRef of accountRefs) {
        if (acctRef.referenceTo.includes("Contact")) {
          for (const f of contactEmailFields) {
            pathsToQuery.push(`${woOppRef.relationshipName}.${oppAcctRef.relationshipName}.${acctRef.relationshipName}.${f}`);
          }
        }
      }
    }
    // Opportunity → Contact (PPP may have Primary_Contact__c on Opp)
    for (const oppRef of oppRefs) {
      if (oppRef.referenceTo.includes("Contact")) {
        for (const f of contactEmailFields) {
          pathsToQuery.push(`${woOppRef.relationshipName}.${oppRef.relationshipName}.${f}`);
        }
        pathsToQuery.push(`${woOppRef.relationshipName}.${oppRef.relationshipName}.Name`);
      }
    }
  }

  // Dedupe paths (relationship walks can produce duplicates).
  const dedupedPaths = Array.from(new Set(pathsToQuery));

  // Step 4: Probe each path individually with its own try/catch — INVALID_FIELD
  // on one path doesn't kill the whole diagnostic.
  const values: Record<string, unknown> = {};
  for (const path of dedupedPaths) {
    try {
      const r = await conn.query<Record<string, unknown>>(
        `SELECT ${path} FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`
      );
      const rec = result0(r.records);
      values[path] = rec ? readPath(rec, path) : null;
    } catch (err) {
      values[path] = `<unavailable: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}>`;
    }
  }

  // Step 5: If we found an Account id, list its child Contacts (most-recent 5).
  // Surfaces the case where the email lives on a Contact related to the
  // Account but not directly linked via any of the paths above.
  let accountContacts: Array<{ Id: string; Name: string | null; Email: string | null; Title: string | null; CreatedDate: string }> = [];
  const accountIdValue = findAccountId(values);
  if (accountIdValue) {
    try {
      const r = await conn.query<{ Id: string; Name: string | null; Email: string | null; Title: string | null; CreatedDate: string }>(
        `SELECT Id, Name, Email, Title, CreatedDate FROM Contact WHERE AccountId = '${accountIdValue}' ORDER BY CreatedDate DESC LIMIT 10`
      );
      accountContacts = r.records;
    } catch (err) {
      values["__account_contacts_error__"] = `<unavailable: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}>`;
    }
  }

  // Step 6: Pick the winning email. Priority: any populated path, in the
  // order they were discovered (which roughly matches "most specific first").
  // Falls back to the most-recent Account.Contact with a usable email.
  let winningPath: string | null = null;
  let winningValue: string | null = null;
  for (const path of dedupedPaths) {
    const v = values[path];
    if (typeof v === "string" && v.trim() && !v.startsWith("<") && v.includes("@")) {
      winningPath = path;
      winningValue = v.trim();
      break;
    }
  }
  if (!winningPath && accountContacts.length > 0) {
    const c = accountContacts.find((c) => c.Email && c.Email.includes("@"));
    if (c) {
      winningPath = `Account.Contacts (most recent: ${c.Name ?? c.Id})`;
      winningValue = c.Email;
    }
  }

  return NextResponse.json({
    ok: true,
    workOrderId,
    schema: {
      wo_email_fields: woEmailFields,
      account_email_fields: accountEmailFields,
      opp_email_fields: oppEmailFields,
      contact_email_fields: contactEmailFields,
    },
    paths_tried: dedupedPaths,
    values,
    account_contacts: accountContacts,
    winning_path: winningPath,
    winning_value: winningValue,
    instructions: winningPath
      ? `Found a usable email at "${winningPath}". The customer-form lookup is being updated to include this path.`
      : `No email found anywhere reachable from this WO. Check the Account.Contacts list — if there's a Contact with an email, link it via WorkOrder.ContactId (or whatever path PPP uses) so the form can find it.`,
  });
}

/** Pull the first record from a SOQL result. */
function result0(records: Array<Record<string, unknown>>): Record<string, unknown> | null {
  return records[0] ?? null;
}

/** Walk a dotted path through a record's nested objects. */
function readPath(rec: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = rec;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur ?? null;
}

/** Pick the Account.Id value out of the probe results (any path ending in .Id under an Account relationship). */
function findAccountId(values: Record<string, unknown>): string | null {
  for (const [key, v] of Object.entries(values)) {
    if (!key.endsWith(".Id")) continue;
    if (typeof v !== "string") continue;
    if (!key.toLowerCase().includes("account")) continue;
    // Account IDs start with "001"
    if (v.startsWith("001")) return v;
  }
  return null;
}
