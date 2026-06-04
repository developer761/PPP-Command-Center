import "server-only";

import { createClient } from "@supabase/supabase-js";
import { loadSupplierTemplate, render } from "@/lib/supplier-order/templates";
import { estimateOrderGallons, classifySurface, formatOrderQuantity, formatBucketsCans, summarizeOrder, type RoomTakeoff, type RoomSurface, type GallonEstimate } from "@/lib/supplier-order/estimate-gallons";
import { loadCoverageConfig } from "@/lib/supplier-order/coverage-config";
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
  /** True when the worker MANUALLY picked this supplier (a store), vs the
   *  supplier being auto-derived from a color's manufacturer. PPP buys paint of
   *  any brand from stores (Aboffs sells BM, SW, etc.), so a hand-picked store
   *  order includes EVERY color on the WO regardless of manufacturer — otherwise
   *  the order goes out empty/short. Auto-detected groups still filter by
   *  manufacturer (to split brands across their mapped suppliers). */
  includeAllColors?: boolean;
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
};

/* ─── Helpers ─── */

/** Per-supplier code suffix for PO numbers. BM → "BM", SW → "SW", else first 3 chars. */
function supplierCode(name: string): string {
  const stripped = name.replace(/[^a-zA-Z0-9]/g, "");
  // Common explicit codes — keep stable so PO numbers don't change if the
  // SF Account.Name gets reformatted.
  const lower = name.toLowerCase();
  if (lower.includes("benjamin moore")) return "BM";
  if (lower.includes("sherwin")) return "SW";
  if (lower.includes("ppg") || lower.includes("paint pickup")) return "PPG";
  return stripped.slice(0, 3).toUpperCase();
}

/**
 * Generate the next PO number using the dedicated DB sequence. Concurrent
 * inserts get distinct numbers (race-safe). Format:
 *   PPP-WO{wo_number}-{supplier_code}-{seq padded to 6}
 *
 * Uses nextval() via a raw SQL call. Falls back to a timestamp-suffixed
 * value if the sequence isn't reachable (migration not run yet) — that
 * way the draft modal still works for QA / copy-to-clipboard.
 */
async function nextPoNumber(woNumber: string, supplierName: string): Promise<string> {
  const code = supplierCode(supplierName);
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    // PostgREST exposes `nextval` via the `rpc` namespace once a function
    // wraps it. Until that's set up we call via a tiny RPC fallback below.
    const { data, error } = await sb.rpc("nextval_supplier_orders_po_seq");
    if (!error && typeof data === "number") {
      return `PPP-WO${woNumber}-${code}-${String(data).padStart(6, "0")}`;
    }
    if (error) console.warn("[supplier-order] PO sequence RPC failed:", error.message);
  } catch (err) {
    console.warn("[supplier-order] PO sequence unreachable:", err);
  }
  // Fallback (RPC unreachable): timestamp + short random suffix. The timestamp
  // alone could collide for two drafts of the same supplier+WO in the same
  // millisecond (the po_number UNIQUE constraint would then 409 the send as a
  // confusing "duplicate order"); the random suffix makes that effectively
  // impossible while staying human-readable.
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PPP-WO${woNumber}-${code}-${String(Date.now()).slice(-6)}${rand}`;
}

/** Compute required-by: WO close date if it's already 3+ days out, else today + 3 days. */
function computeRequiredByDate(workOrder: SnapshotWorkOrder, override?: string): string {
  if (override) return override;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const threeDaysOut = new Date(today.getTime() + 3 * 86_400_000);
  if (workOrder.closeDate) {
    const closeDate = new Date(workOrder.closeDate + "T00:00:00Z");
    if (!isNaN(closeDate.getTime()) && closeDate.getTime() > threeDaysOut.getTime()) {
      // WO close date is far enough out — use that minus 3 days.
      const target = new Date(closeDate.getTime() - 3 * 86_400_000);
      return target.toISOString().split("T")[0];
    }
  }
  // Either no close date or it's too soon — fall back to today + 3.
  return threeDaysOut.toISOString().split("T")[0];
}

/** Map WOLI surface field → label. Single source of truth used by the
 *  customer form on submit. Kept in sync with SURFACE_TO_FIELD on the
 *  submit endpoint. */
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
): { lineItems: SupplierOrderLineItem[]; rooms: RoomTakeoff[]; skippedSurfaces: Array<{ roomLabel: string; surface: string }> } {
  const out: SupplierOrderLineItem[] = [];
  // Per-room geometry + painted surfaces for the gallon estimator — only the
  // surfaces that made it onto THIS supplier's order (same filter as `out`),
  // so the rollup counts only colors actually being ordered here.
  const rooms: RoomTakeoff[] = [];
  const skipped: Array<{ roomLabel: string; surface: string }> = [];
  const customerByLineId = new Map<string, CustomerSubmittedPayload["lineItems"][number]>();
  if (input.customerSubmittedPayload) {
    for (const li of input.customerSubmittedPayload.lineItems) {
      customerByLineId.set(li.id, li);
    }
  }

  for (const woli of input.woliRows) {
    const roomLabel = woli.areaLabel || "Untitled area";
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

    type SurfaceSlot = { fieldKey: string; surfaceLabel: string; existingColorId: string | null };
    const slots: SurfaceSlot[] = [
      { fieldKey: "colorWallId",    surfaceLabel: "Walls",   existingColorId: woli.colorWallId },
      { fieldKey: "colorCeilingId", surfaceLabel: "Ceiling", existingColorId: woli.colorCeilingId },
      { fieldKey: "colorTrimId",    surfaceLabel: "Trim",    existingColorId: woli.colorTrimId },
      { fieldKey: "colorOtherId",   surfaceLabel: "Other",   existingColorId: woli.colorOtherId },
      { fieldKey: "colorFloorId",   surfaceLabel: "Floor",   existingColorId: woli.colorFloorId },
    ];

    for (const slot of slots) {
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
        finish: customerPick?.finish ?? null,
        sqft,
        coats,
        sourceWoliId: woli.id,
        roomLabel,
      });
      // Feed the gallon estimator — classify the surface into a paint bucket
      // (ceiling/walls/trim/floor/unsized). The estimator derives wall area,
      // trim linear feet, deductions, buffer + packaging from the room geometry.
      roomSurfaces.push({
        kind: classifySurface(slot.surfaceLabel),
        surfaceLabel: slot.surfaceLabel,
        colorId,
        colorName: color.name,
        colorCode: color.code,
        finish: customerPick?.finish ?? null,
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
        floorAreaSqft: woli.sqFootage,
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

  return { lineItems: out, rooms, skippedSurfaces: skipped };
}

/** Resolve the delivery address with the fallback chain:
 *  1. Customer-confirmed address from the form (most current, customer-verified)
 *  2. SF Account BillingAddress (PPP's CRM source of truth)
 *  3. null + unresolvedAddress=true (admin needs to enter manually)
 */
function resolveDeliveryAddress(input: BuildSupplierOrderInput): DeliveryAddress | null {
  if (input.fulfillmentMethod === "pickup") return null;

  const customerName = input.customerAccount?.name ?? "(unknown customer)";

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
 *  size from a floor measurement show a blank quantity + "PPP to confirm". */
function formatOrderSummaryBlock(estimates: GallonEstimate[]): string {
  if (estimates.length === 0) return "(no colors picked yet — customer has not submitted the color form)";
  const lines: string[] = [];
  for (const e of estimates) {
    const code = e.colorCode ? ` ${e.colorCode}` : "";
    const finish = e.finish ? ` · ${e.finish}` : "";
    const where = e.surfaces.length ? ` (${e.surfaces.join(", ")})` : "";
    if (e.buckets > 0 || e.cans > 0) {
      lines.push(`  ${formatOrderQuantity(e)} — ${e.colorName}${code}${finish}${where}`);
    } else {
      lines.push(`  ___ — ${e.colorName}${code}${finish}${where} (PPP to confirm quantity)`);
    }
  }
  // Job total line — a quick cross-check for purchasing ("grab this many total").
  const t = summarizeOrder(estimates);
  if (t.buckets > 0 || t.cans > 0) {
    lines.push(`  ─────`);
    lines.push(`  TOTAL: ${formatBucketsCans(t.buckets, t.cans)}${t.reviewColors > 0 ? ` (+ ${t.reviewColors} to confirm)` : ""}`);
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
  if (extras.length === 0) return "";
  const lines = ["EXTRAS (added by PPP worker)"];
  for (const e of extras) {
    lines.push(`- ${e.name} × ${e.qty}${e.unit && e.unit !== "each" ? ` ${e.unit}` : ""}`);
  }
  return lines.join("\n");
}

function formatFulfillmentBlock(
  fulfillmentMethod: FulfillmentMethod,
  address: DeliveryAddress | null,
  pickupLocation?: string
): string {
  if (fulfillmentMethod === "pickup") {
    return `PICKUP at ${pickupLocation ?? "(branch TBD — please confirm)"}`;
  }
  if (!address) {
    return "DELIVERY — address TBD (admin will confirm before send)";
  }
  return `DELIVERY to:\n${formatAddressBlock(address)}`;
}

function readableDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export type PickupLocation = { name: string; address: string };

/** Read supplier_settings row for the target supplier (best-effort). */
async function loadSupplierSettings(supplierAccountId: string): Promise<{
  orderEmail: string | null;
  pppAccountNumber: string | null;
  pickupLocations: PickupLocation[];
}> {
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data } = await sb
      .from("supplier_settings")
      .select("order_email, ppp_account_number, pickup_locations")
      .eq("supplier_account_id", supplierAccountId)
      .maybeSingle();
    const raw = data?.pickup_locations;
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
      orderEmail: (data?.order_email as string | null) ?? null,
      pppAccountNumber: (data?.ppp_account_number as string | null) ?? null,
      pickupLocations,
    };
  } catch (err) {
    console.warn(`[supplier-order/builder] loadSupplierSettings failed:`, err);
    return { orderEmail: null, pppAccountNumber: null, pickupLocations: [] };
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
      }
    : await loadSupplierSettings(input.supplierAccountId);

  // Resolve everything that goes into the email. General Supplies skips
  // paint colors entirely — none of the WO's PaintColors match the synthetic
  // manufacturer id so resolveLineItems returns empty, which is the right
  // shape (extras-only order).
  const { lineItems, rooms, skippedSurfaces } = resolveLineItems(input);
  // Tunable coverage config (Settings → Coverage); falls back to code defaults.
  const gallonEstimates = estimateOrderGallons(rooms, await loadCoverageConfig());
  const orderSummaryBlock = formatOrderSummaryBlock(gallonEstimates);
  const placementBlock = formatPlacementBlock(lineItems);
  const deliveryAddress = resolveDeliveryAddress(input);
  const requiredByDate = computeRequiredByDate(input.workOrder, input.requiredByDate);
  const poNumber = await nextPoNumber(
    input.workOrder.workOrderNumber ?? input.workOrder.id.slice(-6),
    isGeneral ? generalSuppliesLabel() : input.supplierAccount.name
  );

  const customerName = input.customerAccount?.name ?? "(unknown customer)";
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
    fulfillment_block: formatFulfillmentBlock(input.fulfillmentMethod, deliveryAddress, input.pickupLocation),
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
    "ORDER — WHAT TO BUY",
    orderSummaryBlock,
  ];
  // Katie 2026-06-03: COLOR PLACEMENT (where each color goes) removed from
  // the default email — vendor doesn't need PPP's internal room mapping.
  // Still rendered by templates that explicitly reference {{placement_block}}.
  // Customer-opted-out surfaces — surface explicitly so the supplier knows
  // the intent. Without this block the supplier would just see paint for
  // walls + trim and wonder if the ceiling color was forgotten. Only render
  // when at least one surface was actually opted out.
  if (skippedSurfaces.length > 0) {
    sections.push("");
    sections.push("CUSTOMER IS NOT PAINTING");
    for (const s of skippedSurfaces) {
      sections.push(`  - ${s.roomLabel} · ${s.surface}`);
    }
  }
  const extrasBlock = formatExtrasBlock(input.extras);
  if (extrasBlock) {
    sections.push("");
    sections.push(extrasBlock);
  }
  if (vars.special_instructions) {
    sections.push("");
    sections.push("SPECIAL INSTRUCTIONS");
    sections.push(vars.special_instructions);
  }
  sections.push("");
  sections.push(outro.trim());
  sections.push("");
  sections.push(signoff);

  return {
    poNumber,
    subject,
    body: sections.join("\n"),
    lineItems,
    gallonEstimates,
    skippedSurfaces,
    noColorsPicked: lineItems.length === 0,
    unresolvedAddress: input.fulfillmentMethod === "delivery" && !deliveryAddress,
    deliveryAddress,
    requiredByDate,
    sentToEmail: settings.orderEmail,
    pppAccountNumber: settings.pppAccountNumber,
    pickupLocations: settings.pickupLocations,
  };
}
