import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * One-shot diagnostic: hit Salesforce DIRECTLY for a specific WO and dump
 * everything related to it — the WO itself, any line items on the standard
 * `WorkOrderLineItem` object, any line items on a custom `Work_Order_Line_Item__c`
 * object if it exists, and a count of how many WOLI records reference this WO
 * via WorkOrderId.
 *
 * Resolves the open mystery: are PPP's line items on the standard FSL object,
 * a custom object, or somewhere else entirely?
 *
 * Usage:
 *   GET /api/admin/wo-debug?wo=00012345      (Work Order Number)
 *   GET /api/admin/wo-debug?account=Solomon  (substring match on Account.Name)
 *   GET /api/admin/wo-debug?owner=Al%20Solomon  (substring match on Owner.Name)
 *
 * Admin-only. Returns rich JSON for inspection.
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

  const url = new URL(request.url);
  const woNumber = url.searchParams.get("wo");
  const accountFilter = url.searchParams.get("account");
  const ownerFilter = url.searchParams.get("owner");

  if (!woNumber && !accountFilter && !ownerFilter) {
    return NextResponse.json({
      error: "missing_param",
      usage: {
        wo: "WorkOrder.WorkOrderNumber (e.g., ?wo=00012345)",
        account: "Substring match on Opportunity.Account.Name (e.g., ?account=Solomon)",
        owner: "Substring match on Opportunity.Owner.Name (e.g., ?owner=Al%20Solomon)",
      },
    });
  }

  // Escape single quotes for SOQL safety. Also escape `\` (so `\\'` typed
  // literally doesn't turn into the SOQL escape sequence) plus the LIKE
  // wildcards `%` and `_` so an admin typing them in the filter doesn't
  // accidentally widen the result set unbounded.
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[%_]/g, "\\$&");

  try {
    const conn = await getSalesforceClient();

    // 1. Find the WO(s) matching the input filter
    let whereClause = "";
    if (woNumber) {
      whereClause = `WHERE WorkOrderNumber = '${esc(woNumber)}'`;
    } else if (accountFilter) {
      whereClause = `WHERE Opportunity__r.Account.Name LIKE '%${esc(accountFilter)}%'`;
    } else if (ownerFilter) {
      whereClause = `WHERE Opportunity__r.Owner.Name LIKE '%${esc(ownerFilter)}%'`;
    }

    const woQuery = `
      SELECT Id, WorkOrderNumber, Status, CreatedDate,
             WorkType.Name,
             Opportunity__c, Opportunity__r.OwnerId, Opportunity__r.Owner.Name,
             Opportunity__r.Account.Name, Opportunity__r.CloseDate
      FROM WorkOrder ${whereClause}
      LIMIT 25
    `.replace(/\s+/g, " ").trim();

    const woResult = await conn.query<Record<string, unknown>>(woQuery);
    const woRecords = woResult.records;

    if (woRecords.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "No WorkOrder matched the filter",
        filter: { woNumber, accountFilter, ownerFilter },
      });
    }

    const woIds = woRecords.map((w) => w.Id as string);
    const inClause = woIds.map((id) => `'${id}'`).join(", ");

    // 2. Standard FSL WorkOrderLineItem records for these WOs (direct query)
    let standardWoliCount = 0;
    let standardWoliSample: Array<Record<string, unknown>> = [];
    let standardWoliError: string | null = null;
    try {
      const standardResult = await conn.query<Record<string, unknown>>(
        `SELECT Id, WorkOrderId, AreaLabel__c, Surfaces__c, of_Coats__c, ColorWall__c, ColorCeiling__c, ColorTrim__c, ColorNotes__c FROM WorkOrderLineItem WHERE WorkOrderId IN (${inClause})`
      );
      standardWoliCount = standardResult.records.length;
      standardWoliSample = standardResult.records.slice(0, 10);
    } catch (e) {
      standardWoliError = e instanceof Error ? e.message : String(e);
    }

    // 3. Try a few custom-object naming variants in case PPP put line items elsewhere
    type CustomProbe = {
      object: string;
      count: number;
      sample: Array<Record<string, unknown>>;
      fields: string[];
      error: string | null;
    };
    const customProbes: CustomProbe[] = [];
    const customCandidates = [
      "Work_Order_Line_Item__c",
      "WorkOrderLineItem__c",
      "WO_Line_Item__c",
      "PPP_Work_Order_Line_Item__c",
    ];
    for (const obj of customCandidates) {
      try {
        const meta = await conn.sobject(obj).describe() as { fields?: Array<{ name: string }> };
        const fieldNames = (meta.fields ?? []).map((f) => f.name);
        // Try to find a parent-WO reference field
        const woRefField = fieldNames.find((f) => /work.*order/i.test(f) && /__c$/.test(f));
        if (!woRefField) {
          customProbes.push({ object: obj, count: 0, sample: [], fields: fieldNames, error: "no WorkOrder reference field found" });
          continue;
        }
        const r = await conn.query<Record<string, unknown>>(
          `SELECT Id, ${woRefField} FROM ${obj} WHERE ${woRefField} IN (${inClause})`
        );
        customProbes.push({
          object: obj,
          count: r.records.length,
          sample: r.records.slice(0, 5),
          fields: fieldNames.slice(0, 40),
          error: null,
        });
      } catch (e) {
        customProbes.push({
          object: obj,
          count: 0,
          sample: [],
          fields: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 4. List ALL child relationships on WorkOrder so we can see every place
    // line items could live (the deep-dive hinted at WorkOrderLineItems but
    // PPP may have added custom ones).
    type ChildRel = { relationshipName: string | null; childSObject: string; field: string };
    type WoDescribe = { childRelationships?: ChildRel[] };
    let woChildren: ChildRel[] = [];
    try {
      const woMeta = await conn.sobject("WorkOrder").describe() as WoDescribe;
      woChildren = (woMeta.childRelationships ?? []).filter(
        (c) => c.relationshipName !== null
      );
    } catch {
      // ignore
    }

    return NextResponse.json({
      ok: true,
      input: { woNumber, accountFilter, ownerFilter },
      workOrders: woRecords.map((w) => ({
        Id: w.Id,
        WorkOrderNumber: w.WorkOrderNumber,
        Status: w.Status,
        CreatedDate: w.CreatedDate,
        WorkType: (w.WorkType as { Name?: string } | null | undefined)?.Name ?? null,
        OwnerName: ((w.Opportunity__r as { Owner?: { Name?: string } } | null | undefined)?.Owner?.Name) ?? null,
        AccountName: ((w.Opportunity__r as { Account?: { Name?: string } } | null | undefined)?.Account?.Name) ?? null,
        CloseDate: ((w.Opportunity__r as { CloseDate?: string } | null | undefined)?.CloseDate) ?? null,
      })),
      standardWoli: {
        count: standardWoliCount,
        error: standardWoliError,
        sample: standardWoliSample,
      },
      customObjects: customProbes,
      workOrderChildRelationships: woChildren,
    }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "sf_failed", message }, { status: 500 });
  }
}
