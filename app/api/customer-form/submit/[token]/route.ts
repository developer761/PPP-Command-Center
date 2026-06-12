import { NextResponse } from "next/server";
import { validateToken, markSubmitted, markResubmitted } from "@/lib/customer-form/tokens";
import { loadFormRenderData, invalidateFormRenderData } from "@/lib/customer-form/render-data";
import { writeSfBatch, type SfWriteAttempt } from "@/lib/salesforce/writeback";
import { decideWriteback } from "@/lib/customer-form/writeback-mode";
import { checkRateLimit, sweepRateLimit } from "@/lib/rate-limit";
import { notifySenderOnSubmit } from "@/lib/customer-form/notify-sender";
import { insertCustomerFormSubmittedNotification } from "@/lib/notifications/insert";
import { VALID_MATERIAL_TYPE_VALUES } from "@/lib/customer-form/material-types";

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
  /** Customer's selection from the Material Type picker. Null when the
   *  customer didn't pick (we don't blank out admin's pre-set value). When
   *  set, the submit handler writes it back to WorkOrder.MaterialType__c. */
  materialType?: string | null;
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
  // Katie 2026-06-03: Flat and Matte are distinct sheens on different
  // products; same for Gloss vs High-Gloss. Keep the legacy combined values
  // accepted so any in-flight form a customer was filling out before the
  // split doesn't fail server-side validation on submit.
  "Flat",
  "Matte",
  "Flat / Matte",
  "Eggshell",
  "Satin",
  "Semi-Gloss",
  "Gloss",
  "High-Gloss",
  "Gloss / High-Gloss",
]);

/**
 * Sanitize a customer-supplied delivery-address field. Customer input lands
 * in supplier email bodies verbatim — uncapped strings would let a
 * customer paste a multi-KB blob into "street" and produce a wall-of-text
 * email to the supplier. Also strip control chars (except CR/LF which are
 * still rejected — addresses are single-line fields) so an embedded NUL
 * can't distort the address block.
 */
function sanitizeAddressField(v: unknown, maxLen = 200): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const stripped = v.replace(/[\x00-\x1F\x7F]/g, " ").trim();
  if (!stripped) return null;
  return stripped.slice(0, maxLen);
}

function sanitizeDeliveryAddress(
  addr: SubmitPayload["deliveryAddress"]
): SubmitPayload["deliveryAddress"] | null {
  if (!addr || typeof addr !== "object") return null;
  const street = sanitizeAddressField(addr.street);
  const city = sanitizeAddressField(addr.city);
  const state = sanitizeAddressField(addr.state, 50);
  const postalCode = sanitizeAddressField(addr.postalCode, 20);
  const name = sanitizeAddressField(addr.name);
  if (!street && !city && !state && !postalCode && !name) return null;
  return {
    name,
    street: street ?? "",
    city: city ?? "",
    state: state ?? "",
    postalCode: postalCode ?? "",
  };
}

/**
 * Sanitize free-text customer notes (globalNotes + per-line item.notes).
 * Unlike address fields, these may include newlines — strip control chars
 * but preserve \n / \r. Cap to a generous-but-bounded length so a paste of
 * an entire novel can't blow up the supplier email body (~5KB is plenty
 * for the longest legit note PPP has ever received per Katie). Trims
 * trailing whitespace. Returns "" for blank/missing so callers can store
 * empty cleanly.
 */
function sanitizeNotesField(v: unknown, maxLen = 5000): string {
  if (v == null || typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const stripped = v.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, " ").trim();
  if (!stripped) return "";
  return stripped.slice(0, maxLen);
}

// Server-side allowlist for WorkOrder.MaterialType__c now lives in
// lib/customer-form/material-types.ts — same source as the customer picker
// + the admin per-surface override dropdown. Re-export-by-alias here keeps
// the local reference name (`VALID_MATERIAL_TYPES`) so the rest of this
// file reads naturally.
const VALID_MATERIAL_TYPES = VALID_MATERIAL_TYPE_VALUES;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: tokenFromUrl } = await params;

  // Rate-limit the public endpoint BEFORE any DB / SF work. A leaked token
  // shouldn't let an attacker burn SF API calls or audit-log capacity.
  // Per-token bucket: 8 attempts per minute. Happy path = 1 submit; this
  // covers a double-tap + a couple of retries after transient errors and
  // still chokes any botnet to a trickle. Random 1-in-32 sweep keeps the
  // bucket map bounded without a separate timer.
  if (Math.random() < 0.03125) sweepRateLimit();
  const limit = checkRateLimit(`submit:${tokenFromUrl}`, { max: 8, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "You're submitting too fast — please wait a minute and try again. If you keep seeing this, reply to the PPP email.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
        },
      }
    );
  }

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
  // Per-element shape guard. A null element or one missing `id` would crash
  // `.map(li => li.id)` + `freshById.get(submitted.id)` further down with a
  // TypeError → unhandled 500. Reject as 400 instead.
  for (const li of body.lineItems) {
    if (!li || typeof li !== "object" || typeof (li as { id?: unknown }).id !== "string") {
      return NextResponse.json({ error: "invalid_line_item_shape" }, { status: 400 });
    }
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

  // PREVIEW MODE — admin opened this from materials view to test the form.
  // Skip submission marking + SF writes entirely, return success so the UI
  // shows the thank-you page. Multiple preview submits are allowed
  // (audience: admin, exploring). No customer data is altered.
  if (status.token.kind === "preview") {
    console.log(`[customer-form] preview submit accepted for token ${tokenFromUrl.slice(0, 8)}… (skipping SF writes + submission stamping)`);
    return NextResponse.json({
      ok: true,
      preview: true,
      reedited: false,
      orderAlreadyPlaced: false,
      writes: 0,
      writesAttempted: 0,
      writesSucceeded: 0,
      writeSkippedReason: "Preview mode — submission accepted but no Salesforce write performed.",
      writebackMode: "off" as const,
      workOrderNumber: status.token.work_order_number,
    });
  }

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
      // Per-element shape guard — a malformed surface element (null, or
      // missing `surface` string) would otherwise crash on `.toLowerCase()`.
      if (!s || typeof s !== "object" || typeof (s as { surface?: unknown }).surface !== "string") continue;
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
      // ColorNotes__c is a Long Text Area in PPP's org (32k cap), but a Long
      // Text Area sObject field on jsforce can also silently reject at much
      // smaller limits depending on the field's "Length" property. Defensive
      // cap at 30,000 chars (well under 32k) — if a customer pasted a wall of
      // text into the notes textarea, truncate with a marker so the crew can
      // see something was cut. Round 4 audit 2026-06-04: writeback agent
      // flagged this as a real risk that would silently fail the WOLI write.
      const MAX_COLOR_NOTES_CHARS = 30_000;
      const joined = noteLines.join("\n");
      fields.ColorNotes__c = joined.length > MAX_COLOR_NOTES_CHARS
        ? joined.slice(0, MAX_COLOR_NOTES_CHARS - 80) + `\n\n[…truncated — customer notes exceeded ${MAX_COLOR_NOTES_CHARS} chars]`
        : joined;
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

  // Material Type writeback — single WorkOrder.MaterialType__c update when
  // the customer picked a paint product line. Skip when empty/null so we
  // don't blank out an admin-set value. Pushed as a WorkOrder-level attempt
  // alongside the WOLI batch so it benefits from the same audit + retry
  // logic in writeSfBatch.
  const customerMaterialType = typeof body.materialType === "string" ? body.materialType.trim() : "";
  // Flag surfaced in the response so the form can show a "your paint line
  // wasn't saved" warning instead of a clean success thank-you. Without this
  // the customer thinks SF was updated when it wasn't. Audit 2026-06-07.
  let materialTypeDropped = false;
  if (customerMaterialType) {
    if (!VALID_MATERIAL_TYPES.has(customerMaterialType)) {
      // Value isn't in our allowlist (~24 items as of Katie's 2026-06-10
      // expansion). Two real reasons this happens:
      //   (a) Tampered/stale client — picklist changed since the form loaded.
      //   (b) Legacy SF value — admin set MaterialType__c to "Aura ULTRA" or
      //       some retired picklist value before our allowlist existed, the
      //       form pre-filled it, and the customer submitted without changing.
      // Either way: DON'T fail the whole submit (would block the colors from
      // writing back too). Skip the MaterialType__c write only — leave the
      // existing SF value alone — and log so admin can clean up the picklist.
      console.warn(`[customer-form] dropping MaterialType__c write for WO ${status.token.work_order_id.slice(0, 8)}…: value "${customerMaterialType}" not in VALID_MATERIAL_TYPES allowlist (likely legacy SF value or tampered client). WOLI writes proceed normally.`);
      materialTypeDropped = true;
    } else {
      attempts.push({
        sObject: "WorkOrder",
        recordId: status.token.work_order_id,
        fields: { MaterialType__c: customerMaterialType },
      });
    }
  }

  // 4. Persist the submission payload FIRST so a write failure doesn't leave
  // the token half-submitted. First submit uses markSubmitted (idempotent,
  // first-write-only); a re-edit uses markResubmitted (deliberate overwrite).
  //
  // Sanitize free-text notes before persistence — globalNotes + per-line
  // item.notes flow verbatim into the supplier email body, so a 100KB
  // pasted blob would otherwise blow up the email. Capped + control-char
  // stripped (newlines preserved). Keeps the rest of the lineItems shape
  // intact since per-element shape was already validated up top.
  const sanitizedLineItems = body.lineItems.map((li) => ({
    ...li,
    notes: sanitizeNotesField((li as { notes?: unknown }).notes),
  }));
  const payloadRecord = {
    lineItems: sanitizedLineItems,
    globalNotes: sanitizeNotesField(body.globalNotes),
    materialType: customerMaterialType || null,
    deliveryAddress: sanitizeDeliveryAddress(body.deliveryAddress),
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

  // 5. Fire the SF writes — gated by the writeback safety mode (migration 015).
  // Katie 2026-06-03: during the testing phase we only write to test WOs.
  const decision = await decideWriteback(status.token.work_order_id);
  let writesAttempted = 0;
  let writesSucceeded = 0;
  let writeSkippedReason: string | null = null;
  if (runWrites && attempts.length > 0) {
    if (!decision.shouldWrite) {
      writeSkippedReason = decision.reason;
      console.log(`[customer-form] SF writes SKIPPED for WO ${status.token.work_order_id.slice(0, 8)}… (mode=${decision.mode}, inAllowlist=${decision.isInAllowlist}): ${decision.reason}`);
    } else {
      writesAttempted = attempts.length;
      const writeResults = await writeSfBatch(attempts, {
        source: "customer_form_submit",
        triggeredByToken: tokenFromUrl,
      });
      writesSucceeded = writeResults.filter((r) => r.ok).length;
      const failed = writeResults.filter((r) => !r.ok);
      if (failed.length > 0) {
        console.error(`[customer-form] ${failed.length}/${writeResults.length} SF writes failed for token ${tokenFromUrl.slice(0, 8)}…:`, failed);
      }
      // The render-data cache (added 2026-06-06 for the speed pass) holds
      // the pre-submit WOLI shape. Successful writes invalidate it so the
      // next admin/customer view reads fresh state, not the stale 3-min
      // snapshot we cached when admin sent the form.
      if (writesSucceeded > 0) {
        invalidateFormRenderData(status.token.work_order_id);
      }
    }
  }

  // If the supplier order already went out, a re-edit changes colors AFTER the
  // materials were ordered — flag it so the UI can tell the customer to contact
  // the team, and so the admin can spot it (submitted_at now > vendor_email_sent_at).
  const orderAlreadyPlaced = isReedit && !!status.token.vendor_email_sent_at;

  // Notify the sender — Katie 2026-06-05: "When the customer submits a form,
  // can the sender also be notified of a submission so they know that they
  // need to review what the customer sent?" Fire-and-forget: any failure
  // logs but never blocks the customer's success response.
  //
  // Self-audit 2026-06-05: gate on attempts.length too. The race-winner flag
  // (runWrites) doesn't imply there was anything to write — a customer who
  // submits with zero colors picked across all rooms produces an empty
  // attempts list but is still the race winner. Notifying admin "colors
  // submitted" when no colors actually came in is just inbox noise that
  // wastes their time opening Mail Hub to investigate.
  //
  // Edge-case audit 2026-06-05: also skip the notification when SF writeback
  // was bypassed (test_only + this WO not allowlisted, or mode=off). The
  // colors live in the Command Center but nothing changed in SF, and the
  // notification copy says "submitted" — admin would assume SF was updated
  // when it wasn't. Admin can still find these submissions via Mail Hub
  // directly (the token's submitted_payload is preserved either way).
  //
  // Katie batch 3 (2026-06-05): also notify when the customer submitted a
  // notes-only response (no line items, just project description in
  // globalNotes). For exterior / sparse WOs the customer's notes ARE the
  // full submission — admin needs to know it came in even though nothing
  // wrote to SF. The notes are preserved in submitted_payload regardless.
  const notesOnly = !!(body.globalNotes && body.globalNotes.trim().length > 0);
  const hasMeaningfulSubmission = attempts.length > 0 || notesOnly;
  const writebackHappened = decision.shouldWrite || notesOnly;
  // notesOnly = notes were the only meaningful content (no per-room color
  // writes fired). Drives notification copy so admin doesn't expect color
  // data in SF when only project-description text arrived.
  const notifyNotesOnly = attempts.length === 0 && notesOnly;
  // writebackSkipped = the SF writeback gate BLOCKED the write even though
  // there were attempts queued (test_only + not on allowlist, or mode=off).
  // Tells the notification to add a clarifier so admin knows to manually
  // reconcile via Mail Hub instead of assuming SF is current. Only set
  // when there WAS something to write — pure notes-only paths don't
  // count as "skipped" since there's nothing to write either way.
  const writebackSkipped = attempts.length > 0 && !decision.shouldWrite;

  if (status.token.created_by_user_id && runWrites && hasMeaningfulSubmission) {
    // EMAIL — conservative gate: only fire when SF was actually updated.
    // The email copy says "submitted" which implies SF state; firing on a
    // writeback-skipped path would mislead admin to expect data in SF that
    // isn't there. The bell below has no such promise so it fires regardless.
    if (writebackHappened) {
      notifySenderOnSubmit({
        adminUserId: status.token.created_by_user_id,
        customerName: status.token.customer_name,
        workOrderNumber: fresh.workOrderNumber,
        workOrderId: status.token.work_order_id,
        isReedit,
        lineItemCount: body.lineItems.length,
        orderAlreadyPlaced,
        notesOnly: notifyNotesOnly,
        writebackSkipped,
      }).catch((err) => {
        console.warn(`[customer-form] sender notification failed for token ${tokenFromUrl.slice(0, 8)}…:`, err instanceof Error ? err.message : err);
      });
    }

    // IN-APP BELL (Katie + Alex 2026-06-12): light up the bell for the WO
    // sender + every admin. Fires for EVERY meaningful submission — including
    // writeback-skipped paths — because Katie wants admin to see every form
    // come in. The insert helper adds a "saved in Command Center only" hint
    // when writebackSkipped so admin knows what to expect. Workers only see
    // rows they were inserted as recipient on, so a worker's bell never
    // reveals another rep's customer.
    insertCustomerFormSubmittedNotification({
      senderUserId: status.token.created_by_user_id,
      workOrderId: status.token.work_order_id,
      workOrderNumber: fresh.workOrderNumber,
      customerName: status.token.customer_name,
      isReedit,
      lineItemCount: body.lineItems.length,
      notesOnly: notifyNotesOnly,
      writebackSkipped,
    }).catch((err) => {
      console.warn(`[customer-form] bell insert failed for token ${tokenFromUrl.slice(0, 8)}…:`, err instanceof Error ? err.message : err);
    });
  }

  return NextResponse.json({
    ok: true,
    reedited: isReedit,
    orderAlreadyPlaced,
    writes: attempts.length,
    writesAttempted,
    writesSucceeded,
    writeSkippedReason,
    writebackMode: decision.mode,
    workOrderNumber: fresh.workOrderNumber,
    // True when customer submitted a Material Type value that wasn't in our
    // current allowlist. Customer-facing form uses this to show a clarifier
    // instead of a clean thank-you so the customer doesn't think their
    // paint-line pick was saved when it wasn't. Audit 2026-06-07.
    materialTypeDropped,
  });
}
