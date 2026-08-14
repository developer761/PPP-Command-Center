import type { PaintUnit, QuantityOverride } from "@/lib/supplier-order/estimate-gallons";
import type { CustomColorItem, SupplierOrderExtra } from "@/lib/supplier-order/builder";

/**
 * The committed "what to buy" payload — everything the ORDER BUILDING step
 * decides, in one object (Kate round-3 #18).
 *
 * This is the contract between the two halves of the split:
 *
 *   /dashboard/materials/[woId]/order              → writes it
 *   /dashboard/materials/[woId]/order/[supplierId] → reads it, never writes it
 *
 * Fulfilment deliberately has no way to change any field in here. That is the
 * whole point of the split: before it, editing a delivery address re-derived the
 * draft and wiped the worker's typed quantities.
 */
export type OrderBuildPayload = {
  /** Job-level paint line. Every colour defaults to it. */
  mainMaterialType: string;
  /** Per-colour paint-line overrides, keyed `${colorId}::${finish ?? ""}`. */
  materialTypeOverrides: Record<string, string>;
  /** Per-colour quantities the worker typed, same key shape. */
  quantities: Record<string, QuantityOverride>;
  /** Catalogue extras + primers + custom sundry items. */
  extras: SupplierOrderExtra[];
  /** Worker-typed colour lines — stain, plaster, colour matches (#28). */
  customColorItems: CustomColorItem[];
  /** Edited Color Notes; null = use the builder's default. */
  colorNotes: string | null;
};

export function emptyBuildPayload(): OrderBuildPayload {
  return {
    mainMaterialType: "",
    materialTypeOverrides: {},
    quantities: {},
    extras: [],
    customColorItems: [],
    colorNotes: null,
  };
}

const UNITS: ReadonlySet<string> = new Set<PaintUnit>(["gal", "qt"]);

/**
 * Coerce anything that came off the wire (or out of an older jsonb row) into a
 * payload the rest of the code can trust. Every field is rebuilt rather than
 * spread, so a malformed row can't smuggle unexpected keys into the builder,
 * and a payload written before a field existed still loads.
 */
export function normalizeBuildPayload(raw: unknown): OrderBuildPayload {
  const out = emptyBuildPayload();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.mainMaterialType === "string") out.mainMaterialType = r.mainMaterialType;
  if (typeof r.colorNotes === "string") out.colorNotes = r.colorNotes;

  if (r.materialTypeOverrides && typeof r.materialTypeOverrides === "object") {
    for (const [k, v] of Object.entries(r.materialTypeOverrides as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out.materialTypeOverrides[k] = v;
    }
  }

  if (r.quantities && typeof r.quantities === "object") {
    for (const [k, v] of Object.entries(r.quantities as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const q = v as Record<string, unknown>;
      const buckets = Math.max(0, Math.min(99, Math.floor(Number(q.buckets) || 0)));
      const cans = Math.max(0, Math.min(99, Math.floor(Number(q.cans) || 0)));
      const unit = typeof q.unit === "string" && UNITS.has(q.unit) ? (q.unit as PaintUnit) : "gal";
      out.quantities[k] = { buckets, cans, unit };
    }
  }

  if (Array.isArray(r.extras)) {
    for (const e of r.extras) {
      if (!e || typeof e !== "object") continue;
      const x = e as Record<string, unknown>;
      const extraId = typeof x.extraId === "string" ? x.extraId : "";
      const name = typeof x.name === "string" ? x.name.trim() : "";
      if (!extraId || !name) continue;
      out.extras.push({
        extraId,
        name,
        unit: typeof x.unit === "string" && x.unit.trim() ? x.unit.trim() : "each",
        qty: Math.max(1, Math.min(99, Math.floor(Number(x.qty) || 1))),
      });
    }
  }

  if (Array.isArray(r.customColorItems)) {
    for (const c of r.customColorItems) {
      if (!c || typeof c !== "object") continue;
      const x = c as Record<string, unknown>;
      const label = typeof x.label === "string" ? x.label.trim() : "";
      if (!label) continue;
      out.customColorItems.push({
        id: typeof x.id === "string" && x.id ? x.id : `cc-${out.customColorItems.length}`,
        label: label.slice(0, 300),
        qty: Math.max(1, Math.min(99, Math.floor(Number(x.qty) || 1))),
        unit: typeof x.unit === "string" && x.unit.trim() ? x.unit.trim() : "gal",
      });
    }
  }

  return out;
}
