import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Live-from-Salesforce fetch for a single WO's customer-form context. NOT
 * cached — we always want the freshest WO + line items when the customer
 * lands on the form. Caching here would risk showing the customer stale
 * data while estimators are actively editing in SF.
 *
 * Used by both:
 *   /select/[token]/page.tsx       — renders the form
 *   /api/customer-form/submit/...  — re-fetches at submit to detect drift
 *
 * Returns null if the WO can't be found in SF (deleted, sharing rule, etc.).
 */

export type FormLineItem = {
  id: string;
  areaLabel: string | null;          // e.g. "Master Bedroom", "elevator foyer"
  surfaces: string[];                // ["Walls", "Ceiling", "Trim"]
  numCoats: number | null;
  productFamily: string | null;      // "Interior Painting", etc.
  sortOrder: number;
  // Existing color picks (null on fresh line items, populated if a customer
  // already submitted earlier — admin can resend a form to collect changes)
  currentColors: {
    wallId: string | null;
    ceilingId: string | null;
    trimId: string | null;
    floorId: string | null;
    otherId: string | null;
  };
  existingNotes: string | null;
  lastModifiedDate: string;          // ISO — used for drift detection on submit
};

export type FormRenderData = {
  workOrderId: string;
  workOrderNumber: string | null;
  status: string | null;
  workTypeName: string | null;
  accountName: string | null;
  ownerName: string | null;
  closeDate: string | null;
  lineItems: FormLineItem[];
  /** Fresh-fetch timestamp — written to customer_form_tokens.woli_snapshot_at
   *  for drift detection if the rep edits SF mid-form. */
  fetchedAt: string;
  /** Pre-fill for the "Confirm delivery address" step on the form. Customer
   *  can edit before submit. Pulled live from the Opp's Account so it
   *  reflects what SF has TODAY (vs. the snapshot which may be 5min stale).
   *  Null fields render as empty inputs. */
  billingAddress: {
    street: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
};

const WOLI_FIELDS = [
  "Id", "WorkOrderId",
  "AreaLabel__c", "Surfaces__c",
  "of_Coats__c", "Product_Family__c",
  "ColorWall__c", "ColorCeiling__c", "ColorTrim__c", "ColorOther__c", "ColorFloor__c",
  "ColorNotes__c", "SortOrder__c", "LastModifiedDate",
];

export async function loadFormRenderData(
  workOrderId: string
): Promise<FormRenderData | null> {
  try {
    const conn = await getSalesforceClient();

    // Pull the WO header (account + owner via Opportunity relationship, work
    // type, billing address for the delivery-confirm step on the form).
    const woEsc = workOrderId.replace(/'/g, "\\'");
    const woQuery = `
      SELECT Id, WorkOrderNumber, Status, CreatedDate,
             WorkType.Name,
             Opportunity__c, Opportunity__r.Owner.Name,
             Opportunity__r.Account.Name, Opportunity__r.CloseDate,
             Opportunity__r.Account.BillingStreet,
             Opportunity__r.Account.BillingCity,
             Opportunity__r.Account.BillingState,
             Opportunity__r.Account.BillingPostalCode
      FROM WorkOrder WHERE Id = '${woEsc}' LIMIT 1
    `.replace(/\s+/g, " ").trim();
    const woResult = await conn.query<Record<string, unknown>>(woQuery);
    if (woResult.records.length === 0) return null;
    const w = woResult.records[0];

    // Pull line items via WHERE IN — same pattern that works around the
    // org-level MALFORMED_QUERY restriction on direct WOLI queries.
    const woliQuery = `SELECT ${WOLI_FIELDS.join(", ")} FROM WorkOrderLineItem WHERE WorkOrderId = '${woEsc}'`;
    const woliResult = await conn.query<Record<string, unknown>>(woliQuery);

    const lineItems: FormLineItem[] = woliResult.records.map((r) => {
      const surfacesRaw = typeof r.Surfaces__c === "string" ? (r.Surfaces__c as string) : "";
      const surfaces = surfacesRaw
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const num = (k: string): number | null =>
        typeof r[k] === "number" ? (r[k] as number) : null;
      const str = (k: string): string | null =>
        typeof r[k] === "string" ? (r[k] as string) : null;
      return {
        id: r.Id as string,
        areaLabel: str("AreaLabel__c"),
        surfaces,
        numCoats: num("of_Coats__c"),
        productFamily: str("Product_Family__c"),
        sortOrder: num("SortOrder__c") ?? 0,
        currentColors: {
          wallId: str("ColorWall__c"),
          ceilingId: str("ColorCeiling__c"),
          trimId: str("ColorTrim__c"),
          floorId: str("ColorFloor__c"),
          otherId: str("ColorOther__c"),
        },
        existingNotes: str("ColorNotes__c"),
        lastModifiedDate: r.LastModifiedDate as string,
      };
    });

    // Sort line items by SortOrder then by AreaLabel for a stable display order
    lineItems.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return (a.areaLabel ?? "").localeCompare(b.areaLabel ?? "");
    });

    const opp = w.Opportunity__r as Record<string, unknown> | undefined;
    const oppAccount = opp?.Account as
      | {
          Name?: string;
          BillingStreet?: string | null;
          BillingCity?: string | null;
          BillingState?: string | null;
          BillingPostalCode?: string | null;
        }
      | undefined;
    const accountName = oppAccount?.Name ?? null;
    const ownerName = (opp?.Owner as { Name?: string } | undefined)?.Name ?? null;
    const closeDate = (opp?.CloseDate as string | undefined) ?? null;
    const workTypeName = (w.WorkType as { Name?: string } | null | undefined)?.Name ?? null;

    return {
      workOrderId: w.Id as string,
      workOrderNumber: (w.WorkOrderNumber as string | null) ?? null,
      status: (w.Status as string | null) ?? null,
      workTypeName,
      accountName,
      ownerName,
      closeDate,
      lineItems,
      fetchedAt: new Date().toISOString(),
      billingAddress: {
        street: oppAccount?.BillingStreet ?? null,
        city: oppAccount?.BillingCity ?? null,
        state: oppAccount?.BillingState ?? null,
        postalCode: oppAccount?.BillingPostalCode ?? null,
      },
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[customer-form] loadFormRenderData failed for WO ${workOrderId}:`, m);
    return null;
  }
}
