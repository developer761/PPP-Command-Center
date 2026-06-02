import { NextResponse } from "next/server";
import { validateToken, markSubmitted, markResubmitted } from "@/lib/customer-form/tokens";
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
  /** Customer explicitly opted out of painting this surface. Distinct
   *  from colorId === null (which could just mean "didn't pick"). The
   *  submit handler treats both the same way (skips the SF write) but
   *  preserves the flag in submitted_payload for audit visibility. */
  skipped?: boolean;
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

/**
 * Server-side allowlist for finish values — must stay in lockstep with
 * FINISH_OPTIONS in customer-form-view.tsx. Public endpoint so we can't
 * trust the client to send a valid picklist value; an off-list finish
 * would otherwise land verbatim in ColorNotes__c and the crew would paint
 * with the wrong sheen.
 */
const VALID_FINISHES = new Set([
  "Flat / Matte",
  "Eggshell",
  "Satin",
  "Semi-Gloss",
  "Gloss / High-Gloss",
]);

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
  // This is a public, token-gated endpoint — a malformed body (missing or
  // non-array lineItems) must return a clean 400, never crash the for...of
  // loops below into an unhandled 500.
  if (!Array.isArray(body.lineItems)) {
    return NextResponse.json({ error: "invalid_line_items" }, { status: 400 });
  }

  // 1. Validate. "ok" = first submission; "editable" = customer revising a
  // prior submission before the cutoff (Katie 2026-05-29). "submitted" now
  // means submitted AND past the cutoff → locked.
  const status = await validateToken(tokenFromUrl);
  if (status.kind === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (status.kind === "expired") {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (status.kind === "submitted") {
    return NextResponse.json({ error: "locked", message: "The window to change your colors has closed. Please reply to PPP if you still need a change." }, { status: 409 });
  }
  const isReedit = status.kind === "editable";

  // 2. Fresh re-fetch + drift detection. throwOnError lets us tell a transient
  // Salesforce outage from a genuinely-removed WO: a blip must NOT tell the
  // customer their job is gone (and lose the colors they just picked) — that's
  // a retryable 503, whereas a true empty result is the permanent 410.
  let fresh;
  try {
    fresh = await loadFormRenderData(status.token.work_order_id, { throwOnError: true });
  } catch {
    return NextResponse.json({
      error: "salesforce_unreachable",
      message: "We couldn't reach Salesforce just now — your color picks aren't lost. Please try submitting again in a moment.",
    }, { status: 503 });
  }
  if (!fresh) {
    return NextResponse.json({
      error: "wo_not_found_in_sf",
      message: "We couldn't find this work order in Salesforce — it may have been removed. Please reply to PPP.",
    }, { status: 410 });
  }

  // Build a quick lookup of fresh line items by Id, then detect drift two ways:
  // (a) a line item the customer filled out is GONE (rep deleted it), or
  // (b) a line item was EDITED by the rep after the customer loaded the form
  //     (its LastModifiedDate is newer than the render). Either way we 409 so we
  //     don't silently overwrite the rep's change / lose the customer's picks.
  // The 60s tolerance absorbs clock skew between Salesforce and our server so a
  // WO edited just before the customer loaded never false-triggers.
  const freshById = new Map(fresh.lineItems.map((li) => [li.id, li]));
  const renderedAtMs = body.renderFetchedAt ? new Date(body.renderFetchedAt).getTime() : NaN;
  for (const submitted of body.lineItems) {
    const freshLi = freshById.get(submitted.id);
    if (!freshLi) {
      return NextResponse.json({
        error: "drift_line_item_removed",
        message: "One of the rooms you filled out has been changed by our team. Please reload the form and try again.",
        removedLineItemId: submitted.id,
      }, { status: 409 });
    }
    if (!Number.isNaN(renderedAtMs) && freshLi.lastModifiedDate) {
      const modMs = new Date(freshLi.lastModifiedDate).getTime();
      if (!Number.isNaN(modMs) && modMs > renderedAtMs + 60_000) {
        return NextResponse.json({
          error: "drift_line_item_changed",
          message: "One of the rooms you filled out was just updated by our team. Please reload the form so you're working from the latest version.",
          changedLineItemId: submitted.id,
        }, { status: 409 });
      }
    }
  }
  // (c) a rep ADDED a line item after the customer loaded — the new room was
  //     never shown, so accepting the submit would leave that room un-colored
  //     and the crew would skip it. Force a reload so the customer sees + picks.
  const submittedIds = new Set(body.lineItems.map((li) => li.id));
  const addedLineItem = fresh.lineItems.find((li) => !submittedIds.has(li.id));
  if (addedLineItem) {
    return NextResponse.json({
      error: "drift_line_item_added",
      message: "Our team just added a new room to your job. Please reload the form so you can pick colors for it.",
      addedLineItemId: addedLineItem.id,
    }, { status: 409 });
  }

  // 3. Build SF write batch
  const attempts: SfWriteAttempt[] = [];
  for (const submitted of body.lineItems) {
    const freshLi = freshById.get(submitted.id)!;
    const fields: Record<string, string | null> = {};
    // Defensive: a malformed payload could omit/ill-type surfaces. Guard so the
    // loop never throws on a public endpoint.
    const surfaces = Array.isArray(submitted.surfaces) ? submitted.surfaces : [];
    for (const s of surfaces) {
      const fieldName = SURFACE_TO_FIELD[s.surface.toLowerCase()];
      // On a RE-EDIT, an explicit "don't paint this" (skipped) must CLEAR any
      // color we previously wrote — otherwise a customer removing a color on a
      // second pass silently leaves the old color in SF. First submit keeps the
      // conservative behavior (a blank surface never overwrites with null), so
      // we only force-clear when the customer is revising a prior submission.
      if (isReedit && s.skipped && fieldName) {
        fields[fieldName] = null;
        continue;
      }
      // Skip surfaces the customer didn't pick. Empty/null colorId means the
      // customer chose to skip — don't overwrite any existing value with null
      // unintentionally. (If admin wants to force-clear, they edit in SF.)
      if (!s.colorId) continue;
      if (!fieldName) continue; // Unknown surface label — skip safely
      fields[fieldName] = s.colorId;
    }
    // Combine surface-specific finishes + room notes into ColorNotes__c so
    // the field crew + materials shop see them. Format is human-readable on
    // purpose since PPP staff read this field directly. Reject off-list
    // finishes server-side — the client picklist is the source of truth and
    // a tampered payload shouldn't land "Eggshell Gloss" in the notes.
    for (const s of surfaces) {
      if (s.colorId && s.finish && !VALID_FINISHES.has(s.finish)) {
        return NextResponse.json({
          error: "invalid_finish",
          message: `Finish "${s.finish}" isn't a valid choice. Please pick from the list and try again.`,
          lineItemId: submitted.id,
          surface: s.surface,
        }, { status: 400 });
      }
    }
    const noteLines: string[] = [];
    for (const s of surfaces) {
      if (s.colorId && s.finish) {
        noteLines.push(`${s.surface}: ${s.colorName ?? "(color picked)"}${s.colorCode ? ` (${s.colorCode})` : ""} — ${s.finish}`);
      }
    }
    const submittedNotes = typeof submitted.notes === "string" ? submitted.notes : "";
    if (submittedNotes.trim()) {
      noteLines.push("");
      noteLines.push(`Customer notes: ${submittedNotes.trim()}`);
    }
    if (noteLines.length > 0) {
      fields.ColorNotes__c = noteLines.join("\n");
    } else if (isReedit && freshLi.existingNotes) {
      // Re-edit that left this room with no colors/notes — clear the prior note
      // too, so a removed color doesn't leave a stale "Walls: Stardust —
      // Eggshell" description the crew would still paint. Only when there's an
      // existing note to clear (avoids no-op writes), and only on re-edit (first
      // submit keeps the conservative "don't write empty notes").
      fields.ColorNotes__c = null;
    }
    if (Object.keys(fields).length === 0) continue; // Nothing to write
    attempts.push({
      sObject: "WorkOrderLineItem",
      recordId: submitted.id,
      fields,
    });
  }

  // 4. Persist the submission payload FIRST so a write failure doesn't leave
  // the token half-submitted. First submit uses markSubmitted (idempotent,
  // first-write-only); a re-edit uses markResubmitted (deliberate overwrite).
  const payloadRecord = {
    lineItems: body.lineItems,
    globalNotes: body.globalNotes,
    deliveryAddress: body.deliveryAddress ?? null,
    submittedAt: new Date().toISOString(),
  };
  let runWrites: boolean;
  if (isReedit) {
    const re = await markResubmitted(tokenFromUrl, payloadRecord);
    if (!re.ok) {
      return NextResponse.json({ error: "submit_marker_failed", message: re.error }, { status: 500 });
    }
    runWrites = true; // a re-edit always re-writes the (possibly changed) colors
  } else {
    const submitMark = await markSubmitted(tokenFromUrl, payloadRecord);
    if (!submitMark.ok) {
      return NextResponse.json({ error: "submit_marker_failed", message: submitMark.error }, { status: 500 });
    }
    // First-submit: only the race WINNER writes (double-click/retry losers skip
    // to avoid duplicate WOLI writes + audit noise — audit-flagged 2026-05-26).
    runWrites = submitMark.fresh;
    if (!submitMark.fresh) {
      console.log(`[customer-form] race-lost submit for token ${tokenFromUrl.slice(0, 8)}… — skipping SF writes (winner already fired them)`);
    }
  }

  // 5. Fire the SF writes.
  if (runWrites && attempts.length > 0) {
    const writeResults = await writeSfBatch(attempts, {
      source: "customer_form_submit",
      triggeredByToken: tokenFromUrl,
    });
    const failed = writeResults.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(`[customer-form] ${failed.length}/${writeResults.length} SF writes failed for token ${tokenFromUrl.slice(0, 8)}…:`, failed);
    }
  }

  // If the supplier order already went out, a re-edit changes colors AFTER the
  // materials were ordered — flag it so the UI can tell the customer to contact
  // the team, and so the admin can spot it (submitted_at now > vendor_email_sent_at).
  const orderAlreadyPlaced = isReedit && !!status.token.vendor_email_sent_at;

  return NextResponse.json({
    ok: true,
    reedited: isReedit,
    orderAlreadyPlaced,
    writes: attempts.length,
    workOrderNumber: fresh.workOrderNumber,
  });
}
