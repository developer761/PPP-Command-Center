import "server-only";

import { createClient } from "@supabase/supabase-js";
import { loadSupplierTemplate, render } from "@/lib/supplier-order/templates";
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
  sqft: number;             // From WOLI.Sq_Footage__c (or wallSurfaceArea fallback)
  coats: number;            // From WOLI.of_Coats__c (default 2)
  gallons: number;          // ceil(sqft × coats / coveragePerGallon)
  sourceWoliId: string;
  roomLabel: string;        // "Master Bedroom" / "Living Room"
};

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
  // Fallback: timestamp-based PO. Not race-safe across machines but works
  // for solo QA + the modal preview before the DB sequence is wired.
  return `PPP-WO${woNumber}-${code}-${String(Date.now()).slice(-6)}`;
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
 *  Prefers customer-submitted picks; falls back to existing WOLI fields. */
function resolveLineItems(input: BuildSupplierOrderInput): SupplierOrderLineItem[] {
  const out: SupplierOrderLineItem[] = [];
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
      const colorId = customerPick?.colorId ?? slot.existingColorId;
      if (!colorId) continue;
      const color = input.paintColorsById.get(colorId);
      if (!color) continue;
      // Only include if this color is from the target supplier
      if (color.manufacturerId !== input.supplierAccountId) continue;

      const surfaceCoverage = coats * sqft;
      const gallons = surfaceCoverage > 0 ? Math.ceil(surfaceCoverage / 350) : 1;
      out.push({
        surface: slot.surfaceLabel,
        colorId,
        colorName: color.name,
        colorCode: color.code,
        manufacturerName: input.supplierAccount.name,
        finish: customerPick?.finish ?? null,
        sqft,
        coats,
        gallons,
        sourceWoliId: woli.id,
        roomLabel,
      });
    }
  }

  return out;
}

/** Resolve the delivery address with the fallback chain:
 *  1. Customer-confirmed address from the form (most current, customer-verified)
 *  2. SF Account BillingAddress (PPP's CRM source of truth)
 *  3. null + unresolvedAddress=true (admin needs to enter manually)
 */
function resolveDeliveryAddress(input: BuildSupplierOrderInput): DeliveryAddress | null {
  if (input.fulfillmentMethod === "pickup") return null;

  const customerName = input.customerAccount?.name ?? "(unknown customer)";

  const submitted = input.customerSubmittedPayload?.deliveryAddress;
  if (submitted && submitted.street?.trim()) {
    return {
      name: submitted.name?.trim() || customerName,
      street: submitted.street.trim(),
      city: submitted.city?.trim() || "",
      state: submitted.state?.trim() || "",
      postalCode: submitted.postalCode?.trim() || "",
      source: "customer_form",
    };
  }

  const acct = input.customerAccount;
  if (acct?.billingStreet?.trim()) {
    return {
      name: customerName,
      street: acct.billingStreet.trim(),
      city: acct.billingCity?.trim() || "",
      state: acct.billingState?.trim() || "",
      postalCode: acct.billingPostalCode?.trim() || "",
      source: "sf_account",
    };
  }

  return null;
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

/** Group line items by room → formatted multi-line block. */
function formatLineItemsBlock(items: SupplierOrderLineItem[]): string {
  if (items.length === 0) return "(no colors picked yet — customer has not submitted the color form)";
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
      blocks.push(`  - ${r.surface} — ${r.colorName}${code}${finish} × ${r.gallons} gal`);
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

/** Read supplier_settings row for the target supplier (best-effort). */
async function loadSupplierSettings(supplierAccountId: string): Promise<{
  orderEmail: string | null;
  pppAccountNumber: string | null;
}> {
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data } = await sb
      .from("supplier_settings")
      .select("order_email, ppp_account_number")
      .eq("supplier_account_id", supplierAccountId)
      .maybeSingle();
    return {
      orderEmail: (data?.order_email as string | null) ?? null,
      pppAccountNumber: (data?.ppp_account_number as string | null) ?? null,
    };
  } catch (err) {
    console.warn(`[supplier-order/builder] loadSupplierSettings failed:`, err);
    return { orderEmail: null, pppAccountNumber: null };
  }
}

/* ─── Public entry point ─── */

export async function buildSupplierOrderDraft(
  input: BuildSupplierOrderInput
): Promise<SupplierOrderDraft> {
  // Per-supplier email template (DB override or code default)
  const { template } = await loadSupplierTemplate(input.supplierAccountId);

  // Per-supplier config (order email + PPP account #)
  const settings = await loadSupplierSettings(input.supplierAccountId);

  // Resolve everything that goes into the email
  const lineItems = resolveLineItems(input);
  const deliveryAddress = resolveDeliveryAddress(input);
  const requiredByDate = computeRequiredByDate(input.workOrder, input.requiredByDate);
  const poNumber = await nextPoNumber(input.workOrder.workOrderNumber ?? input.workOrder.id.slice(-6), input.supplierAccount.name);

  const customerName = input.customerAccount?.name ?? "(unknown customer)";
  const customerFirst = customerName.split(/\s+/)[0] || "there";

  const vars: Record<string, string> = {
    supplier_name: input.supplierAccount.name,
    ppp_account_number: settings.pppAccountNumber || "[set in Settings → Suppliers]",
    po_number: poNumber,
    customer_name: customerName,
    customer_first: customerFirst,
    wo_number: input.workOrder.workOrderNumber ?? "",
    required_by_date: readableDate(requiredByDate),
    fulfillment_method: input.fulfillmentMethod,
    fulfillment_block: formatFulfillmentBlock(input.fulfillmentMethod, deliveryAddress, input.pickupLocation),
    delivery_address_block: deliveryAddress ? formatAddressBlock(deliveryAddress) : "",
    pickup_location: input.pickupLocation ?? "",
    line_items_block: formatLineItemsBlock(lineItems),
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
    "COLORS",
    formatLineItemsBlock(lineItems),
  ];
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
    noColorsPicked: lineItems.length === 0,
    unresolvedAddress: input.fulfillmentMethod === "delivery" && !deliveryAddress,
    deliveryAddress,
    requiredByDate,
    sentToEmail: settings.orderEmail,
    pppAccountNumber: settings.pppAccountNumber,
  };
}
