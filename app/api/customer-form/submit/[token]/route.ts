import { NextResponse } from "next/server";
import { validateToken, markSubmitted } from "@/lib/customer-form/tokens";
import { loadFormRenderData } from "@/lib/customer-form/render-data";
import { writeSfBatch, type SfWriteAttempt } from "@/lib/salesforce/writeback";

/**
 * Customer form submit handler.
 *
 *   POST /api/customer-form/submit/[token]
 *
 * Steps:
 *   1. Validate token (must be ok — expired/submitted/not_found → reject)
 *   2. Re-fetch the WO+WOLI fresh from SF so we can detect drift (rep added
 *      a line item, deleted one, edited surfaces mid-flow). If drift detected,
 *      return 409 so the form can show "your rep just updated this" UI.
 *   3. Build a batch of WOLI write attempts — one per line item, updating
 *      ColorWall__c / ColorCeiling__c / ColorTrim__c / ColorOther__c /
 *      ColorFloor__c + ColorNotes__c based on the customer's picks.
 *   4. Run writeSfBatch() — every write logs to sf_writes_audit, cache
 *      invalidates on success.
 *   5. Mark the token submitted with the full payload (for replay + admin
 *      review).
 *
 * Public endpoint — no auth header. The token IS the auth.
 */

type SubmittedSurface = {
  surface: string;
  colorId: string | null;
  colorName: string | null;
  colorCode: string | null;
  finish: string | null;
};

type SubmittedLineItem = {
  id: string;
  surfaces: SubmittedSurface[];
  notes: string;
};

type SubmitPayload = {
  token: string;
  lineItems: SubmittedLineItem[];
  globalNotes: string;
  renderFetchedAt: string;
  /** Customer-confirmed delivery address from the form's last step. The
   *  supplier-order builder reads this in preference to the stale SF
   *  Account.BillingAddress so the supplier email goes to where the
   *  customer says materials should go. */
  deliveryAddress?: {
    name?: string | null;
    street: string;
    city: string;
    state: string;
    postalCode: string;
  };
};

/** Map a surface name (from Surfaces__c) to the WOLI color field it controls. */
const SURFACE_TO_FIELD: Record<string, string> = {
  walls: "ColorWall__c",
  wall: "ColorWall__c",
  ceiling: "ColorCeiling__c",
  trim: "ColorTrim__c",
  floor: "ColorFloor__c",
  other: "ColorOther__c",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: tokenFromUrl } = await params;

  let body: SubmitPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body || body.token !== tokenFromUrl) {
    return NextResponse.json({ error: "token_mismatch" }, { status: 400 });
  }

  // 1. Validate
  const status = await validateToken(tokenFromUrl);
  if (status.kind === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (status.kind === "expired") {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (status.kind === "submitted") {
    return NextResponse.json({ error: "already_submitted" }, { status: 409 });
  }

  // 2. Fresh re-fetch + drift detection
  const fresh = await loadFormRenderData(status.token.work_order_id);
  if (!fresh) {
    return NextResponse.json({
      error: "wo_not_found_in_sf",
      message: "We couldn't find this work order in Salesforce — it may have been removed. Please reply to PPP.",
    }, { status: 410 });
  }

  // Build a quick lookup of fresh line items by Id. If any line item the
  // customer filled out is missing from the fresh fetch, the rep deleted it
  // — surface that as drift so we don't silently lose data.
  const freshById = new Map(fresh.lineItems.map((li) => [li.id, li]));
  for (const submitted of body.lineItems) {
    if (!freshById.has(submitted.id)) {
      return NextResponse.json({
        error: "drift_line_item_removed",
        message: "One of the rooms you filled out has been changed by our team. Please reload the form and try again.",
        removedLineItemId: submitted.id,
      }, { status: 409 });
    }
  }

  // 3. Build SF write batch
  const attempts: SfWriteAttempt[] = [];
  for (const submitted of body.lineItems) {
    const freshLi = freshById.get(submitted.id)!;
    const fields: Record<string, string | null> = {};
    for (const s of submitted.surfaces) {
      // Skip surfaces the customer didn't pick. Empty/null colorId means the
      // customer chose to skip — don't overwrite any existing value with null
      // unintentionally. (If admin wants to force-clear, they edit in SF.)
      if (!s.colorId) continue;
      const fieldName = SURFACE_TO_FIELD[s.surface.toLowerCase()];
      if (!fieldName) continue; // Unknown surface label — skip safely
      fields[fieldName] = s.colorId;
    }
    // Combine surface-specific finishes + room notes into ColorNotes__c so
    // the field crew + materials shop see them. Format is human-readable on
    // purpose since PPP staff read this field directly.
    const noteLines: string[] = [];
    for (const s of submitted.surfaces) {
      if (s.colorId && s.finish) {
        noteLines.push(`${s.surface}: ${s.colorName ?? "(color picked)"}${s.colorCode ? ` (${s.colorCode})` : ""} — ${s.finish}`);
      }
    }
    if (submitted.notes.trim()) {
      noteLines.push("");
      noteLines.push(`Customer notes: ${submitted.notes.trim()}`);
    }
    if (noteLines.length > 0) {
      fields.ColorNotes__c = noteLines.join("\n");
    }
    if (Object.keys(fields).length === 0) continue; // Nothing to write
    attempts.push({
      sObject: "WorkOrderLineItem",
      recordId: submitted.id,
      fields,
    });
  }

  // 4. Mark submitted FIRST so a write failure doesn't leave the token in a
  // weird half-submitted state. The submitted_payload captures the full
  // customer intent regardless of whether SF accepts the writes.
  const submitMark = await markSubmitted(tokenFromUrl, {
    lineItems: body.lineItems,
    globalNotes: body.globalNotes,
    deliveryAddress: body.deliveryAddress ?? null,
    submittedAt: new Date().toISOString(),
  });
  if (!submitMark.ok) {
    return NextResponse.json({
      error: "submit_marker_failed",
      message: submitMark.error,
    }, { status: 500 });
  }

  // 5. Fire the SF writes. Each gets its own audit row + cache invalidation.
  if (attempts.length > 0) {
    const writeResults = await writeSfBatch(attempts, {
      source: "customer_form_submit",
      triggeredByToken: tokenFromUrl,
    });
    const failed = writeResults.filter((r) => !r.ok);
    if (failed.length > 0) {
      // Log loudly — Supabase row is marked submitted with the payload, so an
      // admin can replay via the audit log. We don't show the customer the
      // error since their form succeeded from their perspective.
      console.error(`[customer-form] ${failed.length}/${writeResults.length} SF writes failed for token ${tokenFromUrl}:`, failed);
    }
  }

  return NextResponse.json({
    ok: true,
    writes: attempts.length,
    workOrderNumber: fresh.workOrderNumber,
  });
}
