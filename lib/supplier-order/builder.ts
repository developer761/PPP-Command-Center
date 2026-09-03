import "server-only";

import { createClient } from "@supabase/supabase-js";
import { loadSupplierTemplate, render } from "@/lib/supplier-order/templates";
import { estimateOrderGallons, classifySurface, formatOrderQuantity, formatOrderTotal, summarizeOrder, addCustomItemsToTotal, applyQuantityOverrides, formatColorLabel, type RoomTakeoff, type RoomSurface, type GallonEstimate, type QuantityOverride } from "@/lib/supplier-order/estimate-gallons";
import { loadCoverageConfig } from "@/lib/supplier-order/coverage-config";
import { isExteriorWorkOrder, isInteriorWorkOrder, filterMaterialTypesForWorkOrder, paintLineFromValue } from "@/lib/customer-form/material-types";
import { roomLabelFrom } from "@/lib/customer-form/room-label";
import { extractMachineColorLines } from "@/lib/customer-form/notes";
import { denormalizeFinishFromSf } from "@/lib/customer-form/surface-mapping";
import type {
  SnapshotAccount,
  SnapshotPaintColor,
  SnapshotWoli,
  SnapshotWorkOrder,
} from "@/lib/salesforce/queries";

/**
 * Supplier order builder. Pure server-side function that converts
 *   (work order + customer-form picks + worker extras + delivery mode)
 * into a fully-populated email draft + structured line items.
 *
 * Inputs come from:
 *   - SF snapshot (work order, line items, account, paint colors)
 *   - customer_form_tokens.submitted_payload (the customer's color picks
 *     + any address corrections they made)
 *   - The worker's modal selections (extras dropdown, fulfillment mode,
 *     special instructions)
 *
 * Output is a SupplierOrderDraft — used to populate the modal's preview
 * AND saved as supplier_orders.draft_body when the worker sends.
 */

export type FulfillmentMethod = "delivery" | "pickup";

/**
 * Synthetic supplier id for the "General Supplies" flow — extras-only
 * orders that don't belong to a paint vendor (rollers, brushes, tape,
 * drop cloths, primer, etc.). Sent to env-configured GENERAL_SUPPLIES_EMAIL
 * (typically the warehouse or a Home Depot pro account). Stored in
 * supplier_orders with this id so it surfaces in the Sent view + WO
 * progress alongside paint orders.
 */
export const GENERAL_SUPPLIES_ID = "__general__";

/** Label shown to workers + included in the email. Override via env if PPP
 *  wants to brand it differently (e.g., "Home Depot Pro Account"). */
export function generalSuppliesLabel(): string {
  return process.env.GENERAL_SUPPLIES_LABEL ?? "General Supplies";
}

/** Recipient email for general-supplies orders. Falls back to the regular
 *  RESEND_FROM_ADDRESS so admin gets the email if no warehouse address is
 *  configured. Returns null only if neither is set (Send button disabled). */
export function generalSuppliesEmail(): string | null {
  return (
    process.env.GENERAL_SUPPLIES_EMAIL ||
    process.env.RESEND_FROM_ADDRESS ||
    null
  );
}

export type DeliveryAddress = {
  name: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  /** Where did this address come from? Helps admin trust the data. */
  source: "customer_form" | "sf_account" | "manual";
};

export type SupplierOrderLineItem = {
  surface: string;          // "Walls" / "Trim" / "Ceiling" / "Floor" / "Other"
  colorId: string;
  colorName: string;
  colorCode: string | null;
  manufacturerName: string | null;
  finish: string | null;    // "Eggshell" / "Semi-Gloss" / etc.
  sqft: number;             // From WOLI.Sq_Footage__c (floor area) — context only
  coats: number;            // From WOLI.of_Coats__c (default 2) — context only
  sourceWoliId: string;
  roomLabel: string;        // "Master Bedroom" / "Living Room"
};
// NOTE: order QUANTITIES live in gallonEstimates (the per-color roll-up). These
// per-surface line items are placement context (which color goes where); they
// deliberately carry NO gallon figure — the old per-surface number triple-
// counted (full floor sqft for walls AND ceiling AND trim).

export type SupplierOrderExtra = {
  extraId: string;
  name: string;
  unit: string;
  qty: number;
};

export type BuildSupplierOrderInput = {
  workOrder: SnapshotWorkOrder;
  woliRows: SnapshotWoli[];           // ALL WOLI rows for this WO
  paintColorsById: Map<string, SnapshotPaintColor>;
  customerAccount: SnapshotAccount | null;
  supplierAccountId: string;
  supplierAccount: SnapshotAccount;
  /** Customer's submitted form payload — colors per surface + their
   *  delivery-address correction if any. Null when no submission yet
   *  (worker can still build a draft using SF defaults). */
  customerSubmittedPayload: CustomerSubmittedPayload | null;
  /** Worker's modal choices */
  fulfillmentMethod: FulfillmentMethod;
  pickupLocation?: string;
  extras: SupplierOrderExtra[];
  specialInstructions?: string;
  /** Override required-by date (default: WO close date OR today+3, whichever later). */
  requiredByDate?: string;  // ISO date
  /** Worker-typed delivery address (when SF has none). Top-priority candidate —
   *  flows into the email's delivery block, source="manual". */
  manualDeliveryAddress?: { street: string; city: string; state: string; postalCode: string };
  /** Per-color Material Type overrides — Katie 2026-06-05. Keyed by
   *  `${colorId}::${finish ?? ""}` (matches the modal's +/- override map
   *  shape). When set, this color's line in the order-summary block uses
   *  the override; otherwise falls back to job-level (customer-submitted or
   *  WO.MaterialType__c). Mixed-product jobs drop the "Paint product line"
   *  header and prefix each line with its product instead. */
  materialTypeOverrides?: Record<string, string>;
  /** Kate round-2 #16: the estimator's MAIN paint line chosen on the Order
   *  Materials page — the top-priority job-level value (beats the customer/WO
   *  value). Every color defaults to it unless a per-color override differs. */
  materialType?: string | null;
  /** Kate round-2 #25: the editable "Color Notes" value from the modal. When
   *  provided it becomes the COLOR NOTES email section (replacing the old
   *  Customer-Notes + Not-Painting blocks); when omitted the builder falls back
   *  to the default built from the customer's notes + opted-out surfaces. */
  colorNotes?: string | null;
  /** True when the worker MANUALLY picked this supplier (a store), vs the
   *  supplier being auto-derived from a color's manufacturer. PPP buys paint of
   *  any brand from stores (Aboffs sells BM, SW, etc.), so a hand-picked store
   *  order includes EVERY color on the WO regardless of manufacturer — otherwise
   *  the order goes out empty/short. Auto-detected groups still filter by
   *  manufacturer (to split brands across their mapped suppliers). */
  includeAllColors?: boolean;
  /** Worker-typed square footage per WorkOrderLineItem (`wo_li_sqft_overrides`,
   *  migration 073). The single most valuable manual entry in the whole flow —
   *  ~77% of PPP's open rooms have no Sq_Footage__c at all, so without this the
   *  estimator has nothing to work from and the vendor gets
   *  "___ (PPP to confirm quantity)".
   *
   *  It was measured, typed, saved and shown on the work-order page — and then
   *  dropped on the way to the order, because only view-props read the table.
   *  The WO page and the email disagreed about the same room. */
  sqftOverrides?: Record<string, number>;
  /** Kate round-3 #18/#22/#23/#26: the worker's COMMITTED per-line quantities,
   *  keyed by `${colorId}::${finish ?? ""}`. The email is rendered FROM these —
   *  previously the modal typed a quantity, then rewrote the rendered body with
   *  a regex, so any later re-draft (extras, fulfilment, product line) silently
   *  reverted the number to the estimate and shipped "(PPP to confirm quantity)".
   *  Passing them through the builder makes the email and the screen the same
   *  computation. */
  quantityOverrides?: Record<string, QuantityOverride>;
  /** Kate round-3 #28: worker-typed COLOR lines (stain, venetian plaster,
   *  colour matches — anything that isn't in the paint catalogue). Rendered as
   *  real order lines alongside the picked colours, not buried in notes. */
  customColorItems?: CustomColorItem[];
  /** Kate round-3 #29: who the supplier should call about this order. */
  contactName?: string | null;
  contactPhone?: string | null;
  /** R4.29: ...and write to. The orderer is CC'd so the reply lands. */
  contactEmail?: string | null;
};

/** A worker-typed colour line — one free-text field carrying colour + finish,
 *  plus a quantity and unit like any other line (Kate round-3 #28). */
export type CustomColorItem = {
  id: string;
  /** Free text, e.g. "Color Match: Behr 56, eggshell". */
  label: string;
  qty: number;
  unit: string;
};

export type CustomerSubmittedPayload = {
  lineItems: Array<{
    id: string;        // WOLI id
    surfaces: Array<{
      surface: string;
      colorId: string | null;
      colorName: string | null;
      colorCode: string | null;
      finish: string | null;
      /** Customer explicitly opted out of painting this surface (e.g.
       *  "leave the ceiling as-is"). Distinct from "forgot to pick" —
       *  surfaces with null colorId AND skipped=false aren't shown to
       *  the supplier, but skipped=true surfaces ARE surfaced as a
       *  separate "customer is not painting" block so supplier knows
       *  the intent. */
      skipped?: boolean;
    }>;
    notes: string;
  }>;
  globalNotes?: string;
  /** Customer-selected paint product line from the Material Type picker on
   *  the form. Mirrors WorkOrder.MaterialType__c. When set, surfaced at the
   *  top of the "ORDER — WHAT TO BUY" section in the supplier email so the
   *  vendor knows which BM / SW line to mix. Null when customer didn't pick
   *  AND admin hadn't pre-set MaterialType__c on the WO. */
  materialType?: string | null;
  /** R4.3: the exterior paint line on a job that has both scopes. */
  materialTypeExterior?: string | null;
  /** Customer-confirmed/corrected delivery address from the form's last step. */
  deliveryAddress?: {
    name?: string;
    street: string;
    city: string;
    state: string;
    postalCode: string;
  } | null;
};

export type SupplierOrderDraft = {
  poNumber: string;
  subject: string;
  body: string;
  lineItems: SupplierOrderLineItem[];
  /** Per-color "what to buy" rollup — whole gallons aggregated across every
   *  room (the clean shopping list that leads the email + drives the app's
   *  estimate banner). Quantities are system estimates; the app shows a
   *  "review before sending" banner, the vendor email shows clean numbers. */
  gallonEstimates: GallonEstimate[];
  /** Surfaces the customer explicitly opted out of painting. Surfaced in
   *  the email body so the supplier knows "customer is not painting the
   *  ceiling" vs "customer forgot to pick a ceiling color" — these used
   *  to be silently dropped from the order, leaving suppliers guessing. */
  skippedSurfaces: Array<{ roomLabel: string; surface: string }>;
  /** Kate round-2 #25: default Color Notes text (customer notes + opted-out
   *  surfaces) the modal pre-fills its editable Color Notes field with. */
  colorNotesDefault: string;
  /** When the WO has 0 customer-picked colors yet (no form submission),
   *  this is true and the worker should be warned. */
  noColorsPicked: boolean;
  /** When delivery_address has no source (couldn't resolve), this is true. */
  unresolvedAddress: boolean;
  deliveryAddress: DeliveryAddress | null;
  requiredByDate: string;
  /** Where the email is going (from supplier_settings.order_email). When
   *  null, the modal disables the Send button + nudges admin to set it
   *  in Settings → Suppliers. Copy-to-Clipboard still works. */
  sentToEmail: string | null;
  pppAccountNumber: string | null;
  /** Configured pickup locations for this supplier — admin sets these once
   *  in /dashboard/settings/suppliers, then workers pick from a dropdown
   *  instead of typing the address every time. Empty array = no curated
   *  locations, modal falls back to a text input. */
  pickupLocations: PickupLocation[];
  /** Supplier accepts phone orders only — modal hides email Send/Copy and
   *  shows a "Call this supplier" panel with phoneNumber. */
  phoneOnly: boolean;
  phoneNumber: string | null;
  /** Supplier defaults to pickup regardless of delivery address (NYC suppliers
   *  per Katie 2026-06-10). When true the modal opens with fulfillment=pickup. */
  pickupDefault: boolean;
  /** Material Type allowlist filtered for THIS WO's interior/exterior context.
   *  The customer form's job-level picker already filters; the admin's per-
   *  color override picker in the modal needs the same allowlist so an admin
   *  can't accidentally pick "Aura Interior" for an exterior WO. Computed
   *  server-side in the builder from `workTypeName` + WOLI product names.
   *  Empty array = no filtering (mixed/unknown WO → show all). */
  allowedMaterialTypeValues: string[];
  /** R5.3 — the paint lines this EMAIL will actually carry, so the order screen
   *  can show the same thing it is previewing.
   *
   *  On a mixed job the entry form correctly asks twice, and the email applies
   *  the exterior answer to the colours that are exterior (R4.3) — but none of
   *  that was visible on the order screen, which knew only its own saved
   *  payload. Kate's report was that "neither answer reaches the order screen";
   *  the answers were reaching the vendor, just not the person sending them.
   *
   *  Deliberately RESOLVED values, not a new source of truth: this reports what
   *  the builder decided, so displaying it cannot make the screen and the email
   *  disagree. Which of the three sources wins is a separate question (R5.2,
   *  held) and is untouched here. */
  resolvedMaterialType: string | null;
  /** Effective per-colour lines keyed `${colorId}::${finish ?? ""}` — the
   *  estimator's explicit overrides plus the exterior defaults derived from the
   *  job's scopes. */
  resolvedMaterialTypeOverrides: Record<string, string>;
  /** The exterior line the AM picked, when the job has both scopes. Null on a
   *  single-scope job. */
  exteriorMaterialType: string | null;
};

/* ─── Helpers ─── */

// supplierCode() helper retired with the ABO/BM/SW PO-prefix format
// (Katie 2026-06-05 — "remove the ABO-### part"). PO format now lives in
// nextPoNumber() below.

/**
 * Generate the next PO number for a supplier order.
 *
 * Katie 2026-06-05: "remove the ABO-### part — retailers have smaller PO
 * spaces, keeping it to just our WO number is best." Old format was
 * `PPP-WO00284666-ABO-000123` (16+ chars after PPP-WO). New format:
 *
 *   - First order on a WO  →  `PPP-WO00284666`
 *   - Second order same WO →  `PPP-WO00284666-2`
 *   - Third                →  `PPP-WO00284666-3`
 *
 * Counter is across all suppliers on the WO (Aboffs first → suffix omitted;
 * Sunbelt second → -2). Workers + retailers see at-a-glance which WO an
 * order belongs to without the prefix noise.
 *
 * Uniqueness: po_number column has a UNIQUE constraint. Two near-simultaneous
 * sends on the same WO could both compute the same N (race) — the DB rejects
 * the loser with 23505. The send-route catches that as "duplicate_order" and
 * surfaces a friendly message; admin re-tries and gets the next N.
 */
/**
 * The next free PO number for a work order.
 *
 * `po_number` is globally UNIQUE, so this must return something genuinely
 * unclaimed — and the old implementation could not. It COUNTED the WO's orders
 * while excluding cancelled ones, which meant:
 *
 *   send order   → 0 existing → "PPP-WO00314545"
 *   cancel it    → status='cancelled', but the row still holds that PO
 *   send again   → cancelled excluded, count back to 0 → "PPP-WO00314545"
 *                → 23505 unique_violation on a PO the cancelled row still owns
 *
 * Every retry recomputed the same number, so the work order could never take
 * another order again. Not a race, not transient — permanent, which is exactly
 * how Kate described it (R5.6), and WO 00314545 was sitting in that state in
 * production.
 *
 * The exclusion was deliberate: "so a retracted order doesn't bump the next
 * live PO to -2" (edge-case audit 2026-06-05). That cosmetic tidy-up created a
 * hard block. It was also wrong on its own terms — a cancelled order's PO was
 * already EMAILED to the vendor, so handing the same number to a different
 * order gives them two different orders under one PO. The gap is the honest
 * record.
 *
 * Counting is the wrong primitive regardless: it can't see which numbers are
 * actually taken, and two concurrent sends compute the same count. So read the
 * numbers in use — every status — and take the first free slot.
 */
export async function nextPoNumber(workOrderId: string, woNumber: string): Promise<string> {
  const base = `PPP-WO${woNumber}`;
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb
      .from("supplier_orders")
      .select("po_number")
      .eq("work_order_id", workOrderId);
    if (!error && data) {
      const taken = new Set(
        (data as Array<{ po_number: string | null }>)
          .map((r) => (r.po_number ?? "").trim())
          .filter(Boolean)
      );
      if (!taken.has(base)) return base;
      // Suffix upward past every number this WO has ever used. Bounded so a
      // corrupt table can't spin; the timestamp fallback below covers it.
      for (let n = 2; n <= 500; n++) {
        const candidate = `${base}-${n}`;
        if (!taken.has(candidate)) return candidate;
      }
    }
    if (error) console.warn("[supplier-order] PO lookup failed:", error.message);
  } catch (err) {
    console.warn("[supplier-order] PO lookup unreachable:", err);
  }
  // Supabase unreachable, or 500 suffixes exhausted. A timestamp suffix keeps
  // the number human-readable and can't collide with the `-N` series.
  return `${base}-t${String(Date.now()).slice(-6)}`;
}

/** Compute required-by: WO close date if it's already 3+ days out, else today + 3 days. */
/** Today in PPP's timezone (Eastern), as yyyy-mm-dd. */
function todayEtISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function computeRequiredByDate(workOrder: SnapshotWorkOrder, override?: string): string {
  // Kate round-3 #32: never ask a vendor to deliver in the past. The override
  // arrives from the client, so it is validated HERE — the date input's `min`
  // and the display clamp are conveniences, not the rule. A hand-typed or
  // tampered value used to render straight into the email body while the
  // supplier_orders row recorded something else entirely.
  const todayEt = todayEtISO();
  if (override) return override < todayEt ? todayEt : override;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  // Kate round-2 #24: default the "Required by" to the job's START date; if the
  // start date is already in the past, fall back to the following day (so we
  // never ask a vendor to deliver in the past).
  const start = workOrder.startDate || workOrder.desiredStartDate;
  if (start) {
    const startDate = new Date(start.slice(0, 10) + "T00:00:00Z");
    if (!isNaN(startDate.getTime())) {
      if (startDate.getTime() >= today.getTime()) return startDate.toISOString().split("T")[0];
      return new Date(today.getTime() + 86_400_000).toISOString().split("T")[0];
    }
  }
  const threeDaysOut = new Date(today.getTime() + 3 * 86_400_000);
  if (workOrder.closeDate) {
    // SF closeDate may come back as a Date field ("2025-06-16") or a
    // DateTime field ("2025-06-16T16:00:00.000+0000") depending on org
    // schema. Slice to the 10-char date prefix BEFORE appending T00:00:00Z
    // so the parser always sees a clean date-only ISO. Audit 2026-06-13.
    const closeDate = new Date(workOrder.closeDate.slice(0, 10) + "T00:00:00Z");
    if (!isNaN(closeDate.getTime()) && closeDate.getTime() > threeDaysOut.getTime()) {
      // WO close date is far enough out — use that minus 3 days.
      const target = new Date(closeDate.getTime() - 3 * 86_400_000);
      return target.toISOString().split("T")[0];
    }
  }
  // Either no close date or it's too soon — fall back to today + 3.
  return threeDaysOut.toISOString().split("T")[0];
}

/** Map WOLI color-field slot → label. Orphan surfaces (cabinets, accent wall,
 *  etc.) route into the shared ColorOther__c slot on submit, so they surface
 *  here as "Other" (see lib/customer-form/surface-mapping). */
const SURFACE_FIELD_TO_LABEL: Record<string, string> = {
  colorWallId: "Walls",
  colorCeilingId: "Ceiling",
  colorTrimId: "Trim",
  colorOtherId: "Other",
  colorFloorId: "Floor",
};

/** Resolve the supplier-grouped line items from the WOLI rows + customer picks.
 *  Returns only line items whose color belongs to the target supplier.
 *  Prefers customer-submitted picks; falls back to existing WOLI fields.
 *
 *  Also returns the surfaces the customer explicitly OPTED OUT of (skipped),
 *  so the email body can tell the supplier "customer is not painting the
 *  ceiling" instead of silently dropping the surface — the supplier would
 *  otherwise have to guess whether the customer forgot or chose not to. */
function resolveLineItems(
  input: BuildSupplierOrderInput
): {
  lineItems: SupplierOrderLineItem[];
  rooms: RoomTakeoff[];
  skippedSurfaces: Array<{ roomLabel: string; surface: string }>;
  /** `${colorId}::${finish}` → the scope(s) that colour is painted on. */
  scopesByColorKey: Map<string, Set<"interior" | "exterior">>;
} {
  const out: SupplierOrderLineItem[] = [];
  // Per-room geometry + painted surfaces for the gallon estimator — only the
  // surfaces that made it onto THIS supplier's order (same filter as `out`),
  // so the rollup counts only colors actually being ordered here.
  const rooms: RoomTakeoff[] = [];
  const skipped: Array<{ roomLabel: string; surface: string }> = [];
  // R4.3 — which scope(s) each colour is used on, so an exterior colour can
  // default to the EXTERIOR paint line. Kate tied this to the round-2 ask that
  // the line default to the AM's Internal Entry pick: with two picks, sending
  // only the interior one would put exterior colours on an interior product —
  // the exact thing splitting the picker was meant to prevent.
  const scopesByColorKey = new Map<string, Set<"interior" | "exterior">>();
  const customerByLineId = new Map<string, CustomerSubmittedPayload["lineItems"][number]>();
  if (input.customerSubmittedPayload) {
    for (const li of input.customerSubmittedPayload.lineItems) {
      customerByLineId.set(li.id, li);
    }
  }

  for (const woli of input.woliRows) {
    const roomLabel = roomLabelFrom(woli.areaLabel, woli.productName);
    // The line item's own product name is the scope signal ("Exterior
    // Painting: Siding"). Fall back to the work order's type when it's silent.
    const woliScope: "interior" | "exterior" | null = isExteriorWorkOrder({
      workTypeName: null,
      lineItemProductNames: [woli.productName],
    })
      ? "exterior"
      : isInteriorWorkOrder({ workTypeName: null, lineItemProductNames: [woli.productName] })
        ? "interior"
        : null;
    const noteScope = (colorId: string, finish: string | null) => {
      if (!woliScope) return;
      const k = `${colorId}::${finish ?? ""}`;
      const set = scopesByColorKey.get(k) ?? new Set<"interior" | "exterior">();
      set.add(woliScope);
      scopesByColorKey.set(k, set);
    };
    const sqft = woli.sqFootage > 0 ? woli.sqFootage : woli.wallSurfaceArea;
    const coats = woli.numCoats > 0 ? woli.numCoats : 2;
    // Each surface slot on a WOLI is either a customer-picked color (from
    // the form's submitted payload) OR an existing color reference on the
    // WOLI itself (set previously by the rep). Customer picks take priority.
    const customer = customerByLineId.get(woli.id);
    const customerSurfaces = new Map<string, CustomerSubmittedPayload["lineItems"][number]["surfaces"][number]>();
    if (customer) {
      for (const s of customer.surfaces) {
        customerSurfaces.set(s.surface.toLowerCase(), s);
      }
    }

    // Surfaces on THIS supplier's order for this room — fed to the estimator.
    const roomSurfaces: RoomSurface[] = [];

    // Each slot carries the WOLI's OWN finish (FinishWall__c etc.), not just its
    // colour. Without it, a rep who enters colours directly in Salesforce — no
    // customer form involved — produced order lines with no sheen at all, and
    // two sheens of one colour MERGED into a single line, because the estimator
    // buckets on `colorId::finish`. Simply White Eggshell on the walls and
    // Simply White Semigloss on the trim became "4 gal — Simply White · Walls,
    // Trim": the vendor mixes one sheen for a two-sheen job, and the merge
    // changes the packaging arithmetic so the work-order page and the email
    // disagree on the gallon total.
    type SurfaceSlot = { fieldKey: string; surfaceLabel: string; existingColorId: string | null; existingFinish: string | null };
    const slots: SurfaceSlot[] = [
      { fieldKey: "colorWallId",    surfaceLabel: "Walls",   existingColorId: woli.colorWallId,    existingFinish: woli.finishWall },
      { fieldKey: "colorCeilingId", surfaceLabel: "Ceiling", existingColorId: woli.colorCeilingId, existingFinish: woli.finishCeiling },
      { fieldKey: "colorTrimId",    surfaceLabel: "Trim",    existingColorId: woli.colorTrimId,    existingFinish: woli.finishTrim },
      { fieldKey: "colorOtherId",   surfaceLabel: "Other",   existingColorId: woli.colorOtherId,   existingFinish: woli.finishOther },
      { fieldKey: "colorFloorId",   surfaceLabel: "Floor",   existingColorId: woli.colorFloorId,   existingFinish: woli.finishFloor },
    ];

    // R4.15 — the slot list above is the five SALESFORCE FIELDS, so it only
    // ever looks up "walls", "ceiling", "trim", "other", "floor". A customer
    // who picked (or skipped) "Cabinets" or "Door" was invisible to it: the
    // lookup for those labels never happened.
    //
    // Kate's report was that "Kitchen: Customer selected "Don't paint this
    // surface" on Cabinets." reached Salesforce and Rooms & Colors but never
    // reached Order Materials. This is why — and the same gap put the shared
    // ColorOther__c colour on the order under the label "Other" instead of
    // "Door", which is what the estimator actually needs to read.
    //
    // So walk the customer's OWN surfaces for anything the field list can't
    // represent, and let them speak for themselves.
    const fieldSurfaceKeys = new Set(slots.map((sl) => sl.surfaceLabel.toLowerCase()));
    for (const [key, pick] of customerSurfaces) {
      if (fieldSurfaceKeys.has(key)) continue;
      if (pick.skipped) {
        skipped.push({ roomLabel, surface: pick.surface });
        continue;
      }
      if (!pick.colorId) continue;
      slots.push({
        fieldKey: `customer:${key}`,
        surfaceLabel: pick.surface,
        existingColorId: pick.colorId,
        existingFinish: pick.finish ?? null,
      });
    }
    // With the real orphan surfaces now carrying their own colours, the shared
    // "Other" slot would double-count them — ColorOther__c holds a copy of
    // whichever one Salesforce could fit. Drop it when the customer named the
    // surfaces themselves.
    const namedOrphans = [...customerSurfaces.keys()].filter((k) => !fieldSurfaceKeys.has(k));
    const slotsToWalk = namedOrphans.length > 0
      ? slots.filter((sl) => sl.surfaceLabel !== "Other")
      : slots;

    for (const slot of slotsToWalk) {
      const customerPick = customerSurfaces.get(slot.surfaceLabel.toLowerCase());
      // Customer explicitly opted out of this surface — record it for the
      // supplier email so they know the intent. We only surface the skip
      // when the WOLI ACTUALLY HAS this slot configured (existingColorId
      // present OR customer specified) to avoid noise from slots that
      // aren't relevant to this WO at all.
      if (customerPick?.skipped) {
        skipped.push({ roomLabel, surface: slot.surfaceLabel });
        continue;
      }
      const colorId = customerPick?.colorId ?? slot.existingColorId;
      if (!colorId) continue;
      const color = input.paintColorsById.get(colorId);
      if (!color) continue;
      // Supplier filtering:
      // - MANUAL store pick (includeAllColors): include EVERY color on the WO,
      //   whatever the brand. PPP buys BM/SW/etc. from stores like Aboffs, so a
      //   hand-picked store order is "this whole job's paint from this store."
      //   (To split brands across stores, use the auto-detected groups / batch.)
      // - AUTO-detected supplier group: only colors whose manufacturer maps to
      //   this supplier — don't put a BM color on a different manufacturer's order.
      if (!input.includeAllColors) {
        if (!color.manufacturerId) {
          console.warn(`[supplier-order/builder] PaintColor ${color.id} (${color.name}) has no manufacturerId — skipping from auto supplier order ${input.supplierAccountId}`);
          continue;
        }
        if (color.manufacturerId !== input.supplierAccountId) continue;
      }

      out.push({
        surface: slot.surfaceLabel,
        colorId,
        colorName: color.name,
        colorCode: color.code,
        manufacturerName: input.supplierAccount.name,
        finish: customerPick?.finish ?? denormalizeFinishFromSf(slot.existingFinish),
        sqft,
        coats,
        sourceWoliId: woli.id,
        roomLabel,
      });
      // Feed the gallon estimator — classify the surface into a paint bucket
      // (ceiling/walls/trim/floor/unsized). The estimator derives wall area,
      // trim linear feet, deductions, buffer + packaging from the room geometry.
      const resolvedFinish = customerPick?.finish ?? denormalizeFinishFromSf(slot.existingFinish);
      noteScope(colorId, resolvedFinish);
      roomSurfaces.push({
        kind: classifySurface(slot.surfaceLabel),
        surfaceLabel: slot.surfaceLabel,
        colorId,
        colorName: color.name,
        colorCode: color.code,
        finish: resolvedFinish,
      });
    }

    // Extra surfaces the customer picked that aren't one of the 5 standard SF
    // color slots (Accent Wall, Cabinets, Door, Window, Closet, Shelves). These
    // have no structured SF color field, so without this they'd be INVISIBLE to
    // the supplier order (they'd live only in ColorNotes text). Surface them as
    // "unsized" → they show in the buy-list + email as "needs review (PPP to
    // confirm quantity)" for the worker to set. We don't auto-size them (no
    // reliable geometry for a cabinet front or a single accent wall).
    const STANDARD_SURFACES = new Set(["walls", "ceiling", "trim", "other", "floor"]);
    if (customer) {
      for (const cs of customer.surfaces) {
        const key = cs.surface.toLowerCase();
        if (STANDARD_SURFACES.has(key)) continue; // handled by the slots above
        if (cs.skipped || !cs.colorId) continue;  // opted out / no pick
        const color = input.paintColorsById.get(cs.colorId);
        if (!color) continue;
        // Same supplier filter as the standard slots: manual store pick takes
        // every color; auto-detected groups filter by manufacturer.
        if (!input.includeAllColors) {
          if (!color.manufacturerId) continue;
          if (color.manufacturerId !== input.supplierAccountId) continue;
        }
        out.push({
          surface: cs.surface,
          colorId: cs.colorId,
          colorName: color.name,
          colorCode: color.code,
          manufacturerName: input.supplierAccount.name,
          finish: cs.finish ?? null,
          sqft: 0,
          coats,
          sourceWoliId: woli.id,
          roomLabel,
        });
        noteScope(cs.colorId, cs.finish ?? null);
        roomSurfaces.push({
          kind: "unsized",
          surfaceLabel: cs.surface,
          colorId: cs.colorId,
          colorName: color.name,
          colorCode: color.code,
          finish: cs.finish ?? null,
        });
      }
    }

    // One RoomTakeoff per WOLI that has at least one ordered surface. Geometry
    // comes straight from the WOLI; missing values (perimeter, height, opening
    // counts, coats) fall back to the estimator's spec defaults.
    if (roomSurfaces.length > 0) {
      rooms.push({
        woliId: woli.id,
        roomLabel,
        // A number a human measured beats a blank (or stale) Salesforce field.
        // 0 means "cleared" and correctly falls back to Salesforce.
        floorAreaSqft: input.sqftOverrides?.[woli.id] || woli.sqFootage,
        wallSurfaceAreaSqft: woli.wallSurfaceArea, // measured wall area wins when >0
        perimeterLf: woli.perimeter,        // 0/missing → estimator derives 4×√(floor)
        heightFt: woli.heightFt,            // 0/missing → estimator default (8 ft)
        doors: woli.numDoors,               // 0/missing → estimator default (1/room)
        windows: woli.numWindows,           // 0/missing → estimator default (1/room)
        closets: woli.numClosets,           // 0/missing → estimator default (0/room)
        coats: woli.numCoats,               // 0/missing → estimator default (2)
        // Katie's rule: when WOLI.# of doors is explicitly set, those door
        // faces (room-side) are in scope along with the casings. Default-
        // assumed doors (1/room fallback) don't trigger faces — only an
        // explicit count from the estimator does. Explicit typeof guard so
        // a null/undefined/NaN/string field can't sneak past `> 0` (which
        // would silently evaluate false and suppress door faces on garbage).
        paintDoorFaces: typeof woli.numDoors === "number" && woli.numDoors > 0,
        surfaces: roomSurfaces,
      });
    }
  }

  return { lineItems: out, rooms, skippedSurfaces: skipped, scopesByColorKey };
}

/** Resolve the delivery address with the fallback chain:
 *  1. Customer-confirmed address from the form (most current, customer-verified)
 *  2. SF Account BillingAddress (PPP's CRM source of truth)
 *  3. null + unresolvedAddress=true (admin needs to enter manually)
 */
function resolveDeliveryAddress(input: BuildSupplierOrderInput): DeliveryAddress | null {
  if (input.fulfillmentMethod === "pickup") return null;

  // This name becomes the SHIP-TO line the supplier puts on the delivery, so
  // unlike the email body it cannot simply be omitted — a package needs an
  // addressee. It also must not read "(unknown customer)", which is what a work
  // order with no Account resolved used to print on the label. Fall back to the
  // work order, which is the reference PPP and the vendor already share.
  const customerName =
    input.customerAccount?.name?.trim() ||
    (input.workOrder.workOrderNumber
      ? `Precision Painting Plus — WO #${input.workOrder.workOrderNumber}`
      : "Precision Painting Plus");

  // An address is only usable by a supplier if it has street + city + (state or
  // zip). A street-only / city-less address would ship a half address that
  // looks complete (unresolvedAddress=false) but the driver can't route — so a
  // partial candidate is skipped and we fall through, ending at null which
  // flags unresolvedAddress=true and makes the admin complete it.
  const deliverable = (a: DeliveryAddress): boolean =>
    !!(a.street && a.city && (a.state || a.postalCode));

  const candidates: DeliveryAddress[] = [];

  // Worker typed it in the modal (SF had none) — highest priority.
  const manual = input.manualDeliveryAddress;
  if (manual && manual.street?.trim()) {
    candidates.push({
      name: customerName,
      street: manual.street.trim(),
      city: manual.city?.trim() || "",
      state: manual.state?.trim() || "",
      postalCode: manual.postalCode?.trim() || "",
      source: "manual",
    });
  }

  const submitted = input.customerSubmittedPayload?.deliveryAddress;
  if (submitted && submitted.street?.trim()) {
    candidates.push({
      name: submitted.name?.trim() || customerName,
      street: submitted.street.trim(),
      city: submitted.city?.trim() || "",
      state: submitted.state?.trim() || "",
      postalCode: submitted.postalCode?.trim() || "",
      source: "customer_form",
    });
  }

  const acct = input.customerAccount;
  if (acct?.billingStreet?.trim()) {
    candidates.push({
      name: customerName,
      street: acct.billingStreet.trim(),
      city: acct.billingCity?.trim() || "",
      state: acct.billingState?.trim() || "",
      postalCode: acct.billingPostalCode?.trim() || "",
      source: "sf_account",
    });
  }

  return candidates.find(deliverable) ?? null;
}

/** Format a delivery address block for the email body. */
function formatAddressBlock(address: DeliveryAddress): string {
  const lines: string[] = [address.name, address.street];
  const cityStateZip = [
    address.city,
    [address.state, address.postalCode].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  if (cityStateZip) lines.push(cityStateZip);
  return lines.join("\n");
}

/** The "what to buy" shopping list — per-color whole-gallon totals. Leads the
 *  email so the vendor sees order quantities first. NO "estimate" wording (the
 *  app shows the estimate banner; the vendor email stays clean). Lines we can't
 *  size from a floor measurement show a blank quantity + "PPP to confirm".
 *
 *  materialType (optional) is included on each line as the paint product line
 *  ("Regal Select Interior" / "Aura Interior" / "SW Emerald" etc.) so the
 *  vendor mixes the right SKU. Katie 2026-06-03: "Missing the product name —
 *  ex: Regal, Aura, etc. This is very important."
 *
 *  materialTypeOverrides (Katie 2026-06-05): per-color override map keyed by
 *  `${colorId}::${finish ?? ""}` — same shape as the modal's +/- override map.
 *  When set, the line shows the override as a tag prefix; the job-level header
 *  is dropped if NOT every color shares the same value (mixed-product job). */
/** " — Living Room, Bathroom · Walls" for one order line (Kate round-3 #25).
 *  Rooms are capped so a colour used in a dozen rooms doesn't blow the line
 *  width; the count keeps it honest rather than silently truncating. */
function formatPlacementSuffix(rooms: string[], surfaces: string[]): string {
  const cleanRooms = rooms.map((r) => r.trim()).filter(Boolean);
  const cleanSurfaces = surfaces.map((s) => s.trim()).filter(Boolean);
  if (cleanRooms.length === 0 && cleanSurfaces.length === 0) return "";
  const MAX_ROOMS = 4;
  const roomText =
    cleanRooms.length > MAX_ROOMS
      ? `${cleanRooms.slice(0, MAX_ROOMS).join(", ")} +${cleanRooms.length - MAX_ROOMS} more`
      : cleanRooms.join(", ");
  const parts = [roomText, cleanSurfaces.join(", ")].filter(Boolean);
  return ` — ${parts.join(" · ")}`;
}

/** Exported for tests: this is the exact paint block a vendor reads. */
export function formatOrderSummaryBlock(
  estimates: GallonEstimate[],
  materialType: string | null,
  materialTypeOverrides?: Map<string, string>,
  customColorItems: CustomColorItem[] = [],
): string {
  if (estimates.length === 0 && customColorItems.length === 0) {
    return "(no colors picked yet — customer has not submitted the color form)";
  }
  // Every colour zeroed out and nothing typed by hand: there is no paint on
  // this order. Say so plainly rather than emitting a header over an empty
  // list, which reads to a vendor like the message got truncated.
  if (estimates.every((e) => e.excluded) && customColorItems.length === 0) {
    return "(no paint on this order — see the extras and notes below)";
  }
  // Resolve the effective material type per color (override → fall through to
  // job-level). Then decide whether ALL colors share one product (single
  // header) or whether the job is mixed (per-line prefix, no header).
  const effective = estimates.map((e) => {
    const key = `${e.colorId}::${e.finish ?? ""}`;
    return materialTypeOverrides?.get(key) ?? materialType ?? null;
  });
  // Only lines that will actually be ordered decide whether the job has one
  // shared paint line or a mix — otherwise an excluded colour on a different
  // product line makes the header read "mixed — see each line below" when
  // every remaining line shares one.
  const orderedEffective = effective.filter((_, i) => !estimates[i].excluded);

  // R4.32: group the lines under their paint line instead of prefixing every
  // row with "[Regal Select] ". Colors with no line — and no default set for
  // the order — collect under [NOT SET], because Kate's requirement is that
  // nothing is silently unaccounted for: a row with no product line used to be
  // visually identical to a row covered by the header.
  //
  // Only group when at least ONE line is actually set. Grouping an order where
  // nobody picked anything would render a single "[NOT SET]" heading over the
  // whole list, which is noise, not information.
  const anyLineSet = orderedEffective.some((m) => !!m);
  const NOT_SET = "[NOT SET]";
  const groups = new Map<string, string[]>();
  const groupOrder: string[] = [];
  const pushGrouped = (group: string, line: string) => {
    let arr = groups.get(group);
    if (!arr) {
      arr = [];
      groups.set(group, arr);
      groupOrder.push(group);
    }
    arr.push(line);
  };

  for (let i = 0; i < estimates.length; i++) {
    const e = estimates[i];
    // The worker set this colour to zero — PPP is not buying it. It has to
    // vanish from the vendor's order, not appear as a "to confirm" placeholder,
    // which is what a zero used to render as. It still shows in the builder UI
    // as "not ordering" so the decision is visible and reversible.
    if (e.excluded) continue;
    const mt = effective[i];
    // R4.24: the name usually already carries the code ("1421 Bistro Blue"),
    // and sometimes IS the code ("Super White"). Appending unconditionally
    // produced "1421 Bistro Blue 1421".
    const label = formatColorLabel(e.colorName, e.colorCode);
    // Finish stays. Kate's R4.30 mock-up omits it, but the estimator buckets on
    // `colorId::finish` precisely because two sheens of one colour are two
    // different SKUs — dropping it would have a vendor mix one sheen for a
    // two-sheen job. R4.25 asked only for room and surface to come off.
    const finish = e.finish ? ` · ${e.finish}` : "";
    // R4.25: room and surface removed. The vendor doesn't stock by room; the
    // placement detail is for PPP and stays on the order screen.
    const manualPlaceholder = e.manualOnly || (e.buckets === 0 && e.cans === 0);
    // R4.27: "___ (PPP to confirm quantity)" → "TBD". Kate flagged that "___"
    // is easy to miss, and the parenthetical restated it at length.
    const qty = manualPlaceholder ? "TBD" : formatOrderQuantity(e);
    pushGrouped(mt || NOT_SET, `  ${qty} — ${label}${finish}`);
  }
  // Kate round-3 #28: worker-typed colour lines (stain, plaster, colour
  // matches) are real order lines, not a note the vendor has to interpret.
  // They carry no product line, so they belong under [NOT SET] — which is
  // exactly where Kate's R4.32 example puts "Behr 56 Semigloss".
  for (const c of customColorItems) {
    const label = c.label.trim();
    if (!label) continue;
    const qty = Math.max(1, Math.floor(c.qty || 1));
    const unit = (c.unit || "gal").trim();
    pushGrouped(NOT_SET, `  ${qty} ${unit} — ${label}`);
  }

  const lines: string[] = [];
  if (!anyLineSet) {
    // Nothing to group by — a flat list, as before.
    for (const g of groupOrder) lines.push(...groups.get(g)!);
  } else {
    // [NOT SET] last: it reads as the exception, not as a peer heading.
    const ordered = [...groupOrder.filter((g) => g !== NOT_SET), ...(groups.has(NOT_SET) ? [NOT_SET] : [])];
    ordered.forEach((g, idx) => {
      if (idx > 0) lines.push("");
      lines.push(`  ${g === NOT_SET ? NOT_SET : g.toUpperCase()}`);
      lines.push(...groups.get(g)!);
    });
  }
  // Job total line — a quick cross-check for purchasing ("grab this many total").
  // Custom colour lines count toward the total — they're real order lines.
  // R4.30: the job TOTAL line was removed. It restated the arithmetic the
  // vendor does anyway, and every time the per-line rules changed (excluded
  // colors, quarts, custom items) it was another place that could disagree
  // with the lines directly above it.
  // Only warn when NO product line is set anywhere. With R4.32 grouping in
  // place a partially-set order already says so structurally — the unset rows
  // sit under [NOT SET] — so the warning is reserved for the case where the
  // grouping is suppressed entirely and the vendor has nothing to go on.
  if (!anyLineSet) {
    lines.push("");
    lines.push("  ⚠ Paint product line not specified — please confirm before mixing.");
  }
  return lines.join("\n");
}

/** Per-room "where each color goes" detail. Deliberately carries NO gallon
 *  numbers — quantities live in the order summary above (the old per-surface
 *  gallon figure triple-counted, using the full sqft for walls AND ceiling AND
 *  trim). This block is context for the crew/vendor, not a quantity source. */
function formatPlacementBlock(items: SupplierOrderLineItem[]): string {
  if (items.length === 0) return "(no colors picked yet)";
  const byRoom = new Map<string, SupplierOrderLineItem[]>();
  for (const li of items) {
    if (!byRoom.has(li.roomLabel)) byRoom.set(li.roomLabel, []);
    byRoom.get(li.roomLabel)!.push(li);
  }
  const blocks: string[] = [];
  for (const [room, rows] of byRoom) {
    blocks.push(room);
    for (const r of rows) {
      const code = r.colorCode ? ` (${r.colorCode})` : "";
      const finish = r.finish ? `, ${r.finish}` : "";
      blocks.push(`  - ${r.surface}: ${r.colorName}${code}${finish}`);
    }
    blocks.push("");
  }
  return blocks.join("\n").trim();
}

function formatExtrasBlock(extras: SupplierOrderExtra[]): string {
  // Filter qty <= 0 first — an extra with qty 0 reads as garbage to the vendor
  // ("- Painter's Tape × 0") and shouldn't have made the array in the first
  // place, but guard here too so a stale draft can't ship a confusing line.
  const visible = extras.filter((e) => e.qty > 0);
  if (visible.length === 0) return "";
  const lines = ["EXTRAS"];
  for (const e of visible) {
    lines.push(`- ${e.name} × ${e.qty}${e.unit && e.unit !== "each" ? ` ${e.unit}` : ""}`);
  }
  return lines.join("\n");
}

function formatFulfillmentBlock(
  fulfillmentMethod: FulfillmentMethod,
  address: DeliveryAddress | null,
  pickupLocation?: string,
  supplierPickupFallback?: string,
): string {
  if (fulfillmentMethod === "pickup") {
    // Kate round-2 #19: when no branch is typed, PICKUP was left blank. Fall
    // back to the vendor's own account address so it's never empty.
    const loc = (pickupLocation ?? "").trim() || (supplierPickupFallback ?? "").trim() || "(branch TBD — please confirm)";
    return `PICKUP at ${loc}`;
  }
  if (!address) {
    return "DELIVERY — address TBD (admin will confirm before send)";
  }
  return `DELIVERY to:\n${formatAddressBlock(address)}`;
}

function readableDate(iso: string): string {
  // Empty or whitespace input (no date set yet) → "TBD" rather than a blank
  // gap in the email — vendors otherwise wonder if the line broke.
  if (!iso || !iso.trim()) return "TBD — please confirm";
  // Slice to 10-char date prefix BEFORE appending T00:00:00Z so this
  // works for both date-only ("2025-06-16") and datetime
  // ("2025-06-16T16:00:00.000+0000") SF field shapes. Audit 2026-06-13.
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  // Bad date string (typo'd month, garbage from a custom field) — surface
  // "(invalid date)" instead of the raw ISO so a worker proofreading the
  // draft sees something's wrong rather than letting a malformed date ride.
  if (isNaN(d.getTime())) return `(invalid date: ${iso})`;
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export type PickupLocation = { name: string; address: string };

/** Read supplier_settings row for the target supplier (best-effort).
 *  Returns the phone/pickup flags too so the order-modal can switch flows
 *  for phone-only suppliers (Janovic) and NYC pickup-default suppliers. */
async function loadSupplierSettings(supplierAccountId: string): Promise<{
  orderEmail: string | null;
  pppAccountNumber: string | null;
  pickupLocations: PickupLocation[];
  phoneOnly: boolean;
  phoneNumber: string | null;
  pickupDefault: boolean;
}> {
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    // Rich SELECT first, fall back to base if the new columns aren't migrated.
    let row: Record<string, unknown> | null = null;
    const rich = await sb
      .from("supplier_settings")
      .select("order_email, ppp_account_number, pickup_locations, phone_only, phone_number, pickup_default")
      .eq("supplier_account_id", supplierAccountId)
      .maybeSingle();
    if (rich.error) {
      const base = await sb
        .from("supplier_settings")
        .select("order_email, ppp_account_number, pickup_locations")
        .eq("supplier_account_id", supplierAccountId)
        .maybeSingle();
      row = (base.data as Record<string, unknown> | null) ?? null;
    } else {
      row = (rich.data as Record<string, unknown> | null) ?? null;
    }
    const raw = row?.pickup_locations;
    const pickupLocations: PickupLocation[] = Array.isArray(raw)
      ? (raw as unknown[])
          .filter((p): p is { name: string; address: string } =>
            typeof p === "object" && p !== null &&
            typeof (p as { name?: unknown }).name === "string" &&
            typeof (p as { address?: unknown }).address === "string"
          )
          .filter((p) => p.name.trim().length > 0)
      : [];
    return {
      orderEmail: (row?.order_email as string | null) ?? null,
      pppAccountNumber: (row?.ppp_account_number as string | null) ?? null,
      pickupLocations,
      phoneOnly: Boolean(row?.phone_only),
      phoneNumber: (row?.phone_number as string | null) ?? null,
      pickupDefault: Boolean(row?.pickup_default),
    };
  } catch (err) {
    console.warn(`[supplier-order/builder] loadSupplierSettings failed:`, err);
    return {
      orderEmail: null,
      pppAccountNumber: null,
      pickupLocations: [],
      phoneOnly: false,
      phoneNumber: null,
      pickupDefault: false,
    };
  }
}

/* ─── Public entry point ─── */

export async function buildSupplierOrderDraft(
  input: BuildSupplierOrderInput
): Promise<SupplierOrderDraft> {
  const isGeneral = input.supplierAccountId === GENERAL_SUPPLIES_ID;

  // Per-supplier email template (DB override or code default). General
  // Supplies uses the same default template — overrides loaded by id which
  // works fine for a synthetic id (will return defaults).
  const { template } = await loadSupplierTemplate(input.supplierAccountId);

  // Per-supplier config — general supplies pulls from env vars instead
  // of supplier_settings (which has no row for the synthetic id).
  const settings = isGeneral
    ? {
        orderEmail: generalSuppliesEmail(),
        pppAccountNumber: null,
        pickupLocations: [] as Array<{ name: string; address: string }>,
        phoneOnly: false,
        phoneNumber: null,
        pickupDefault: false,
      }
    : await loadSupplierSettings(input.supplierAccountId);

  // Resolve everything that goes into the email. General Supplies skips
  // paint colors entirely — none of the WO's PaintColors match the synthetic
  // manufacturer id so resolveLineItems returns empty, which is the right
  // shape (extras-only order).
  const { lineItems, rooms, skippedSurfaces, scopesByColorKey } = resolveLineItems(input);
  // Tunable coverage config (Settings → Coverage); falls back to code defaults.
  const rawEstimates = estimateOrderGallons(rooms, await loadCoverageConfig());
  // Kate round-3 #22/#23/#26: fold the worker's COMMITTED quantities in here,
  // once, before anything is rendered — so the order list, the total and the
  // vendor email are all the same numbers. The old flow typed a quantity into
  // the modal and then patched the rendered email text with a regex, which any
  // subsequent re-draft threw away.
  const quantityOverridesMap = input.quantityOverrides
    ? new Map<string, QuantityOverride>(Object.entries(input.quantityOverrides))
    : undefined;
  const gallonEstimates = applyQuantityOverrides(rawEstimates, quantityOverridesMap);
  const customColorItems = (input.customColorItems ?? []).filter((c) => c.label.trim());
  // Paint product line — prefer the customer's selection (they may have
  // refined the admin pre-set value), fall back to whatever was on the WO at
  // build time. Null when neither has it; the summary block flags it as a
  // "please confirm before mixing" warning to the vendor. (Audit 2026-06-07:
  // the WO fallback link was broken — the middle term was `"" ||` instead of
  // `input.workOrder.materialType ||`, so the admin's pre-set value was
  // silently ignored and the vendor warning fired on every order even when
  // admin had set the paint line.)
  // Kate round-2 #16 / round-3 #24: the paint line, in priority order —
  //   1. what the estimator picked on the order builder
  //   2. what the AM or customer chose on the entry form (this is #24: the
  //      AM's Internal Entry pick has to REACH the order form, and it does so
  //      through the submitted payload)
  //   3. whatever was pre-set on the work order in Salesforce
  // Collapsed to a LINE (#09) so a legacy "Regal Select Eggshell" on an old WO
  // still lands on a value the pickers can show.
  const materialType =
    paintLineFromValue(
      (input.materialType ?? "").trim() ||
      (input.customerSubmittedPayload?.materialType ?? "").trim() ||
      input.workOrder.materialType ||
      ""
    ) || null;

  // R4.3 — the AM's EXTERIOR pick, applied to the colours that are actually
  // exterior. Kate tied the split picker to the round-2 ask that the line
  // default to the AM's Internal Entry pick; with two picks, carrying only the
  // interior one would put exterior colours on an interior product, which is
  // the exact failure splitting the picker was meant to prevent.
  //
  // Written as per-colour overrides rather than a second job-level default,
  // because that's the shape the rest of the order already speaks: the builder
  // renders them per line and the vendor email groups by line (R4.30), so an
  // interior/exterior job arrives as two clearly separated groups.
  //
  // An explicit override from the estimator always wins — this only fills gaps.
  const exteriorLine = paintLineFromValue(
    (input.customerSubmittedPayload?.materialTypeExterior ?? "").trim()
  );
  const derivedMaterialTypeOverrides = new Map<string, string>(
    input.materialTypeOverrides ? Object.entries(input.materialTypeOverrides) : []
  );
  if (exteriorLine) {
    for (const e of gallonEstimates) {
      const key = `${e.colorId}::${e.finish ?? ""}`;
      if (derivedMaterialTypeOverrides.has(key)) continue;
      const scopes = scopesByColorKey.get(key);
      // Only a colour used EXCLUSIVELY on exterior work. One used on both is
      // ambiguous, and guessing there would be worse than leaving the job
      // default in place for the estimator to correct.
      if (scopes && scopes.size === 1 && scopes.has("exterior")) {
        derivedMaterialTypeOverrides.set(key, exteriorLine);
      }
    }
  }
  // Per-color Material Type overrides (Katie 2026-06-05). Convert the
  // serialization-friendly Record<> into a Map for O(1) lookups inside the
  // formatter. Empty record / undefined → no overrides → formatter falls
  // through to job-level for every line.
  // The derived map already carries the estimator's explicit overrides plus
  // the exterior defaults filled in above, so it is the one everything reads.
  const materialTypeOverridesMap =
    derivedMaterialTypeOverrides.size > 0 ? derivedMaterialTypeOverrides : undefined;
  const orderSummaryBlock = formatOrderSummaryBlock(gallonEstimates, materialType, materialTypeOverridesMap, customColorItems);
  const placementBlock = formatPlacementBlock(lineItems);
  const deliveryAddress = resolveDeliveryAddress(input);
  const requiredByDate = computeRequiredByDate(input.workOrder, input.requiredByDate);
  const poNumber = await nextPoNumber(
    input.workOrder.id,
    input.workOrder.workOrderNumber ?? input.workOrder.id.slice(-6)
  );

  // EMPTY, not "(unknown customer)". The template wraps every use in a
  // {{#customer_name}} section, so an unknown customer omits the line entirely
  // rather than mailing a vendor the word "(unknown customer)" — the same rule
  // the PPP Account line already follows two fields up. It also stops
  // customer_first rendering as "(unknown" in any greeting that uses it.
  const customerName = input.customerAccount?.name ?? "";
  const customerFirst = customerName.split(/\s+/)[0] || "there";

  const vars: Record<string, string> = {
    supplier_name: isGeneral ? generalSuppliesLabel() : input.supplierAccount.name,
    // Optional — when null, the {{#ppp_account_number}}…{{/ppp_account_number}}
    // section in the template renders nothing so the "PPP Account:" line is
    // omitted entirely. Workers should never see placeholders.
    ppp_account_number: settings.pppAccountNumber ?? "",
    po_number: poNumber,
    customer_name: customerName,
    customer_first: customerFirst,
    wo_number: input.workOrder.workOrderNumber ?? "",
    required_by_date: readableDate(requiredByDate),
    fulfillment_method: input.fulfillmentMethod,
    // Kate #19: vendor's own address (SF billing) as the pickup fallback, else a
    // configured pickup branch — so "PICKUP at" is never blank.
    fulfillment_block: formatFulfillmentBlock(
      input.fulfillmentMethod,
      deliveryAddress,
      input.pickupLocation,
      [input.supplierAccount.billingStreet, input.supplierAccount.billingCity].filter(Boolean).join(", ")
        || settings.pickupLocations?.[0]?.address
        || "",
    ),
    delivery_address_block: deliveryAddress ? formatAddressBlock(deliveryAddress) : "",
    pickup_location: input.pickupLocation ?? "",
    // For templates that inline {{line_items_block}}: the buy-list ONLY.
    // Katie 2026-06-03: drop the COLOR PLACEMENT breakdown — vendor doesn't
    // need to know which room each color goes in; that's PPP's concern,
    // not theirs. `placementBlock` is still built (cheap) so templates that
    // explicitly reference {{placement_block}} continue to work, but the
    // default assembly below no longer includes it.
    line_items_block: orderSummaryBlock,
    placement_block: placementBlock,
    extras_block: formatExtrasBlock(input.extras),
    special_instructions: input.specialInstructions?.trim() ?? "",
    ppp_brand: "Precision Painting Plus",
    // Kate round-3 #29: the supplier had no way to reach anyone. If a colour is
    // unavailable or a quantity looks wrong they need a number to call, and it
    // should be whoever is placing the order.
    contact_name: (input.contactName ?? "").trim(),
    contact_phone: (input.contactPhone ?? "").trim(),
    contact_email: (input.contactEmail ?? "").trim(),
  };

  const subject = render(template.subject, vars);

  // Assemble body — template parts joined by the standard structure. Admin
  // can override any of the parts at the template editor; the assembled
  // output is what goes into the modal's preview textarea (and what gets
  // sent). The COLORS + EXTRAS + INSTRUCTIONS blocks come after the
  // template intro so admin overrides don't accidentally remove them.
  const greeting = render(template.greeting, vars);
  const intro = render(template.intro, vars);
  const outro = render(template.outro, vars);
  const signoff = render(template.signoff, vars);

  const sections: string[] = [
    greeting,
    "",
    intro.trim(),
    "",
    "ORDER",
    orderSummaryBlock,
  ];
  // Customer notes from the form. Two sources:
  //   - submitted_payload.globalNotes (project-level, e.g. notes-only / exterior)
  //   - per-line items.notes (room-specific custom requests)
  // For exterior + sparse-WO jobs these notes ARE the order content the
  // supplier needs to scope correctly. Karan 2026-06-09: do NOT drop them
  // between submit and supplier. Render after the ORDER block, before
  // any other sections, so the vendor reads the customer's words next to
  // the buy-list. Sanitize (already capped + control-char stripped server-
  // side in the submit route).
  const payload = input.customerSubmittedPayload;
  const customerGlobalNotes = payload?.globalNotes?.trim() ?? "";
  const perLineNotes: Array<{ roomLabel: string; note: string }> = [];
  if (payload?.lineItems) {
    // CRITICAL: room label is `areaLabel`, NOT `productName`. Pre-2026-06-09
    // productName was hardcoded null in the snapshot mapper so the truthy
    // guard always failed + the map stayed empty + "Room" was the fallback.
    // After the 71dd9ed restoration, productName is populated (e.g. "Aura"
    // or "SW Emerald") — using it here would print product names where
    // room names belong. areaLabel is what L323 already uses for placement
    // blocks; keep this consistent.
    const woliRoomLabel = new Map<string, string>();
    for (const li of input.woliRows) {
      const label = (li.areaLabel ?? "").trim();
      if (li.id && label) woliRoomLabel.set(li.id, label);
    }
    for (const item of payload.lineItems) {
      const note = (item.notes ?? "").trim();
      if (!note) continue;
      // Kate round-3 #31: never invent a room called "Room". When Salesforce
      // genuinely has no area label, the note stands on its own rather than
      // being filed under a placeholder that reads like a real room name.
      perLineNotes.push({ roomLabel: woliRoomLabel.get(item.id) ?? "", note });
    }
  }
  // Kate round-2 #25: the "CUSTOMER NOTES" + "CUSTOMER IS NOT PAINTING" blocks
  // are consolidated into ONE editable "COLOR NOTES" section. The default text is
  // built from the customer's notes + opted-out surfaces so the estimator sees
  // (and can edit) what might be missing; if the modal sends an edited value
  // (`input.colorNotes`), that wins.
  const colorNotesDefaultParts: string[] = [];
  if (customerGlobalNotes) colorNotesDefaultParts.push(customerGlobalNotes);
  // Kate round-3 #16: the colours Salesforce keeps in ColorNotes__c — orphaned
  // surfaces (a line with Cabinets AND Door has nowhere else to put them) and
  // non-BM/SW colours. Without this they are absent from the order lines AND
  // from the email, so the vendor never learns about them at all.
  for (const li of input.woliRows) {
    const machineLines = extractMachineColorLines(li.colorNotes);
    if (machineLines.length === 0) continue;
    // Kate round-3 #31: one surface per LINE. The Salesforce write was fixed to
    // do this, and then this join(" · ") put them straight back onto a single
    // run-on line — the exact separator she rejected — in the order's Color
    // Notes box and in the vendor email's COLOR NOTES block.
    const label = (li.areaLabel ?? "").trim();
    if (label) colorNotesDefaultParts.push(`${label}:`);
    for (const line of machineLines) colorNotesDefaultParts.push(line);
  }
  for (const { roomLabel, note } of perLineNotes) {
    colorNotesDefaultParts.push(roomLabel ? `- ${roomLabel}: ${note}` : `- ${note}`);
  }
  if (skippedSurfaces.length > 0) {
    colorNotesDefaultParts.push("Not painting:");
    for (const s of skippedSurfaces) colorNotesDefaultParts.push(`- ${s.roomLabel} · ${s.surface}`);
  }
  const colorNotesDefault = colorNotesDefaultParts.join("\n");
  // R4.14: COLOR NOTES no longer goes on the vendor email. Kate: color notes
  // exist to inform the ESTIMATOR, not the supplier — when something in them
  // needs ordering, the estimator adds it as a custom color item, which does
  // reach the email as a real line. Still computed above because the order
  // screen renders it (and persists it), just not appended here.
  void colorNotesDefault;
  const extrasBlock = formatExtrasBlock(input.extras);
  if (extrasBlock) {
    sections.push("");
    sections.push(extrasBlock);
  }
  if (vars.special_instructions) {
    sections.push("");
    sections.push("FULFILMENT INSTRUCTIONS"); // Kate #25 rename
    sections.push(vars.special_instructions);
  }
  // Kate round-3 #29 + R4.29: a reachable human on every order — name, phone
  // AND email, so a vendor who'd rather write than call has an address that
  // isn't the shared inbox. The orderer is also CC'd on the send (see the send
  // route), which is what makes replying to this address actually work.
  {
    const contactBits = [vars.contact_name, vars.contact_phone, vars.contact_email]
      .map((v) => (v ?? "").trim())
      .filter(Boolean);
    if (contactBits.length > 0) {
      sections.push("");
      sections.push("QUESTIONS ABOUT THIS ORDER");
      sections.push(contactBits.join(" · "));
    }
  }
  sections.push("");
  sections.push(outro.trim());
  sections.push("");
  sections.push(signoff);

  // Compute the Material Type allowlist for THIS WO's context — same logic
  // the customer-form picker uses. Modal passes this down to its per-color
  // override picker so admin can't pick "Aura Interior" for an exterior WO.
  // filterMaterialTypesForWorkOrder returns groups `{label, options[]}`; we
  // flatten to a single list of allowed string values.
  const woliProductNames = input.woliRows
    .map((li) => li.productName ?? "")
    .filter((s) => s.length > 0);
  const allowedMaterialTypeValues = filterMaterialTypesForWorkOrder({
    workTypeName: input.workOrder.workTypeName ?? null,
    lineItemProductNames: woliProductNames,
  }).flatMap((g) => g.options);

  return {
    poNumber,
    subject,
    body: sections.join("\n"),
    lineItems,
    gallonEstimates,
    skippedSurfaces,
    // Kate #25: default Color Notes text (customer notes + opted-out surfaces) —
    // the modal pre-fills its editable Color Notes field with this.
    colorNotesDefault,
    noColorsPicked: lineItems.length === 0,
    unresolvedAddress: input.fulfillmentMethod === "delivery" && !deliveryAddress,
    deliveryAddress,
    requiredByDate,
    sentToEmail: settings.orderEmail,
    pppAccountNumber: settings.pppAccountNumber,
    pickupLocations: settings.pickupLocations,
    phoneOnly: settings.phoneOnly,
    phoneNumber: settings.phoneNumber,
    pickupDefault: settings.pickupDefault,
    allowedMaterialTypeValues,
    // R5.3 — what the email decided, handed back so the screen can show it.
    resolvedMaterialType: materialType,
    resolvedMaterialTypeOverrides: Object.fromEntries(derivedMaterialTypeOverrides),
    exteriorMaterialType: exteriorLine || null,
  };
}
