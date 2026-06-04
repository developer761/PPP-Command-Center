import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";
import { decideWriteback } from "@/lib/customer-form/writeback-mode";
import { isHiddenWoliStatus } from "@/lib/customer-form/woli-status";

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
  /** Standard FSL WorkOrderLineItem.Status — used by render-data to skip
   *  Canceled/Completed/Closed rooms before they ever reach the form. Kept
   *  on the returned shape for diagnostic surfaces (admin debug pages). */
  status: string | null;
  areaLabel: string | null;          // e.g. "Master Bedroom", "elevator foyer"
  productName: string | null;        // ProductName__c — paired with areaLabel for the room title
  surfaces: string[];                // ["Walls", "Ceiling", "Trim"]
  numCoats: number | null;
  productFamily: string | null;      // "Interior Painting", etc.
  sortOrder: number;
  // Existing color picks (null on fresh line items, populated if a customer
  // already submitted earlier — admin can resend a form to collect changes,
  // OR the customer is re-editing their own submission)
  currentColors: {
    wallId: string | null;
    ceilingId: string | null;
    trimId: string | null;
    floorId: string | null;
    otherId: string | null;
  };
  // Existing finishes per surface (SF FinishX__c). Lets a re-editing customer
  // see what they previously chose, and seeds the finish when a color exists.
  currentFinishes: {
    wall: string | null;
    ceiling: string | null;
    trim: string | null;
    floor: string | null;
    other: string | null;
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
  /** Pre-populated paint product line from WorkOrder.MaterialType__c.
   *  Picklist values: Ultra Spec Interior, Regal Select Interior, Aura
   *  Interior, Ultra Spec Exterior, Regal Select Exterior, Aura Exterior,
   *  SW Emerald, SW Duration, SW Super Paint, Other. Null when admin hasn't
   *  set it yet (about 50% of PPP WOs as of 2026-06-03 per Katie). */
  materialType: string | null;
  /** Best-available scheduled job start: WorkOrder.StartDate (sparse) →
   *  DesiredStart__c → Opp CloseDate (PPP's projected date). Drives the
   *  "link expires 24h before start" rule. Null when none is set. */
  scheduledStart: string | null;
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
  /** Customer-form SF writeback safety state (migration 015). Lets the form
   *  show a banner explaining that this WO's data will OR won't propagate
   *  back to Salesforce — important during Katie's testing phase where only
   *  WOs on the allowlist write back. */
  writeback: {
    mode: "test_only" | "all" | "off";
    shouldWrite: boolean;
    isInAllowlist: boolean;
  };
  /** Count of line items hidden by the Status filter (Canceled / Completed /
   *  Closed / Cannot Complete / Pending REMOVE). When lineItems.length=0 AND
   *  hiddenLineItemCount>0, the form can show a more specific empty state
   *  ("all rooms on this job are cancelled") instead of the generic "no
   *  rooms detailed yet" message. */
  hiddenLineItemCount: number;
};

const WOLI_FIELDS = [
  "Id", "WorkOrderId",
  // Status is the standard FSL field with picklist values: New (default),
  // In Progress, On Hold, Completed, Closed, Cannot Complete, Canceled,
  // Pending Approval - REMOVE / ADD. We pull it so the form can skip rooms
  // that won't be painted (Canceled / Completed / Closed / Cannot Complete /
  // Pending REMOVE). Katie 2026-06-04 clarified to KEEP Pending Approval -
  // ADD visible (rep proposed adding the room — customer needs to pick a
  // color so it can be added with paint specified).
  "Status",
  "AreaLabel__c", "ProductName__c", "Surfaces__c",
  "of_Coats__c", "Product_Family__c",
  "ColorWall__c", "ColorCeiling__c", "ColorTrim__c", "ColorOther__c", "ColorFloor__c",
  "FinishWall__c", "FinishCeiling__c", "FinishTrim__c", "FinishOther__c", "FinishFloor__c",
  "ColorNotes__c", "SortOrder__c", "LastModifiedDate",
];

// HIDDEN_WOLI_STATUSES + isHiddenWoliStatus live in lib/customer-form/woli-status.ts
// so this filter and the snapshot loader's filter can never drift.

export async function loadFormRenderData(
  workOrderId: string,
  opts?: { throwOnError?: boolean }
): Promise<FormRenderData | null> {
  try {
    const conn = await getSalesforceClient();

    // Pull the WO header (account + owner via Opportunity relationship, work
    // type, billing address for the delivery-confirm step on the form).
    const woEsc = workOrderId.replace(/'/g, "\\'");
    // MaterialType__c added 2026-06-03 (Katie) — drives the paint-line picker
    // on the customer form. Falls back to a narrower SELECT on INVALID_FIELD
    // so older orgs without that field still render.
    const richFields = `Id, WorkOrderNumber, Status, CreatedDate,
             StartDate, DesiredStart__c, MaterialType__c,
             WorkType.Name,
             Opportunity__c, Opportunity__r.Owner.Name,
             Opportunity__r.Account.Name, Opportunity__r.CloseDate,
             Opportunity__r.Account.BillingStreet,
             Opportunity__r.Account.BillingCity,
             Opportunity__r.Account.BillingState,
             Opportunity__r.Account.BillingPostalCode`;
    const baseFields = `Id, WorkOrderNumber, Status, CreatedDate,
             StartDate, DesiredStart__c,
             WorkType.Name,
             Opportunity__c, Opportunity__r.Owner.Name,
             Opportunity__r.Account.Name, Opportunity__r.CloseDate,
             Opportunity__r.Account.BillingStreet,
             Opportunity__r.Account.BillingCity,
             Opportunity__r.Account.BillingState,
             Opportunity__r.Account.BillingPostalCode`;
    let woResult: Awaited<ReturnType<typeof conn.query<Record<string, unknown>>>>;
    try {
      woResult = await conn.query<Record<string, unknown>>(
        `SELECT ${richFields} FROM WorkOrder WHERE Id = '${woEsc}' LIMIT 1`.replace(/\s+/g, " ").trim()
      );
    } catch (e) {
      console.warn(`[customer-form] WO rich-fields query failed, falling back to base:`, e instanceof Error ? e.message : e);
      woResult = await conn.query<Record<string, unknown>>(
        `SELECT ${baseFields} FROM WorkOrder WHERE Id = '${woEsc}' LIMIT 1`.replace(/\s+/g, " ").trim()
      );
    }
    if (woResult.records.length === 0) return null;
    const w = woResult.records[0];

    // Pull line items via WHERE IN — same pattern that works around the
    // org-level MALFORMED_QUERY restriction on direct WOLI queries.
    const woliQuery = `SELECT ${WOLI_FIELDS.join(", ")} FROM WorkOrderLineItem WHERE WorkOrderId = '${woEsc}'`;
    const woliResult = await conn.query<Record<string, unknown>>(woliQuery);

    // Count how many got hidden (used by the form's empty-state copy to say
    // "your rooms are all cancelled" vs the generic "no rooms yet").
    const hiddenLineItemCount = woliResult.records.filter((r) =>
      isHiddenWoliStatus(typeof r.Status === "string" ? r.Status : null)
    ).length;
    const lineItems: FormLineItem[] = woliResult.records
      // Hide Canceled / Completed / Closed / Cannot Complete / Pending REMOVE
      // BEFORE mapping. Uses the shared filter so this surface stays in
      // lockstep with the materials view's snapshot filter.
      .filter((r) => !isHiddenWoliStatus(typeof r.Status === "string" ? r.Status : null))
      .map((r) => {
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
          status: str("Status"),
          areaLabel: str("AreaLabel__c"),
          productName: str("ProductName__c"),
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
          currentFinishes: {
            wall: str("FinishWall__c"),
            ceiling: str("FinishCeiling__c"),
            trim: str("FinishTrim__c"),
            floor: str("FinishFloor__c"),
            other: str("FinishOther__c"),
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
    // Scheduled start anchor: real StartDate → DesiredStart__c → CloseDate.
    const scheduledStart =
      (typeof w.StartDate === "string" ? (w.StartDate as string) : null) ??
      (typeof w.DesiredStart__c === "string" ? (w.DesiredStart__c as string) : null) ??
      closeDate;

    return {
      workOrderId: w.Id as string,
      workOrderNumber: (w.WorkOrderNumber as string | null) ?? null,
      status: (w.Status as string | null) ?? null,
      workTypeName,
      accountName,
      ownerName,
      closeDate,
      scheduledStart,
      // Falls through as null if the org doesn't have MaterialType__c (rich
      // SELECT fallback hit) — the form's picker still renders, just empty.
      materialType: typeof w.MaterialType__c === "string" ? (w.MaterialType__c as string) : null,
      lineItems,
      hiddenLineItemCount,
      fetchedAt: new Date().toISOString(),
      billingAddress: {
        street: oppAccount?.BillingStreet ?? null,
        city: oppAccount?.BillingCity ?? null,
        state: oppAccount?.BillingState ?? null,
        postalCode: oppAccount?.BillingPostalCode ?? null,
      },
      writeback: await (async () => {
        const d = await decideWriteback(w.Id as string);
        return { mode: d.mode, shouldWrite: d.shouldWrite, isInAllowlist: d.isInAllowlist };
      })(),
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[customer-form] loadFormRenderData failed for WO ${workOrderId}:`, m);
    // A thrown error here is an INFRASTRUCTURE failure (SF unreachable, auth
    // expired, network) — NOT "the WO doesn't exist" (that's the empty-result
    // `return null` at the records-length check). Callers that need to tell the
    // two apart (the submit route, so it can say "try again" instead of
    // "removed" and lose a customer's submission) pass throwOnError. Default
    // stays null so the select page + create route are unchanged.
    if (opts?.throwOnError) throw err instanceof Error ? err : new Error(m);
    return null;
  }
}
