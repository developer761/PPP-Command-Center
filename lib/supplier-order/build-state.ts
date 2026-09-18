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
  /** Job-level paint line. Every color defaults to it. */
  mainMaterialType: string;
  /** Per-color paint-line overrides, keyed `${colorId}::${finish ?? ""}`. */
  materialTypeOverrides: Record<string, string>;
  /** Per-color quantities the worker typed, same key shape. */
  quantities: Record<string, QuantityOverride>;
  /** Catalogue extras + primers + custom sundry items. */
  extras: SupplierOrderExtra[];
  /** Worker-typed color lines — stain, plaster, color matches (#28). */
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

const UNITS: ReadonlySet<string> = new Set<PaintUnit>(["gal", "qt", "bucket"]);

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
      // A pail line keeps its PAIL COUNT in `cans`; `buckets` is the older
      // gallon-line shape ("2 buckets + 3 gal"). A pail row stored the other
      // way round — the count in `buckets`, nothing in `cans` — read as ZERO
      // everywhere that matters: the stepper, the line total, the job total
      // and the vendor's email all ask `cans`. Moved here so a stored order
      // can never be silently worth nothing.
      //
      // Only that shape. A row with BOTH set is genuinely ambiguous (is it 3
      // pails, or a pail and 2 gallons mislabelled?), it already reads as
      // something rather than nothing, and guessing would change orders that
      // are currently right.
      out.quantities[k] =
        unit === "bucket" && buckets > 0 && cans === 0
          ? { buckets: 0, cans: buckets, unit }
          : { buckets, cans, unit };
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

/**
 * Keep what the estimator typed while the saved order was still loading.
 *
 * The order page fetches this vendor's saved payload when the vendor is
 * chosen, and the buy-list rows come from a SEPARATE request. Either can win.
 * When the rows arrived first, every quantity stepped in that window was
 * overwritten the moment the fetch returned — silently, and most destructively
 * on a brand-new order, where the saved payload is empty. Karan, 2026-09-17:
 * "sometimes I add like gallons and stuff and it didn't like save to the
 * email."
 *
 * So the load MERGES rather than replaces: the saved payload is the base, and
 * anything the estimator has already touched wins over it. Per key for the two
 * maps, so a quantity typed for one color cannot wipe a saved quantity for
 * another — and per ID for the lists, so adding one extra in the race window
 * does not drop every extra the order already had.
 *
 * Union is safe precisely BECAUSE this runs only on load: a row the estimator
 * removes later is removed from a list that already holds the saved items, and
 * no merge happens after that.
 */
export function mergeBuildPayloads(
  saved: OrderBuildPayload,
  edited: OrderBuildPayload
): OrderBuildPayload {
  return {
    mainMaterialType: edited.mainMaterialType || saved.mainMaterialType,
    materialTypeOverrides: { ...saved.materialTypeOverrides, ...edited.materialTypeOverrides },
    quantities: { ...saved.quantities, ...edited.quantities },
    extras: unionById(saved.extras, edited.extras, (x) => x.extraId),
    customColorItems: unionById(saved.customColorItems, edited.customColorItems, (x) => x.id),
    colorNotes: edited.colorNotes !== null ? edited.colorNotes : saved.colorNotes,
  };
}

/** Saved rows first, then anything typed in the race window; an id present in
 *  both keeps the typed version, which is the more recent decision. */
function unionById<T>(saved: T[], edited: T[], idOf: (x: T) => string): T[] {
  if (edited.length === 0) return saved;
  const byId = new Map<string, T>();
  for (const x of saved) byId.set(idOf(x), x);
  for (const x of edited) byId.set(idOf(x), x);
  return [...byId.values()];
}

/**
 * Retire per-color keys that no line on this order claims any more.
 *
 * The pre-split fallback lets a bathroom line read the plain `colorId::finish`
 * key when nothing else owns it. That is right for a draft saved before
 * 2026-09-17 — and wrong forever after, because nothing pruned the payload: if
 * the hall's color later changed, its saved 4 gal stayed in the row, stopped
 * being claimed, and the BATHROOM inherited it. Quantity and product, silently,
 * with the screen and the email agreeing on the wrong number.
 *
 * Runs when a draft arrives, against the keys that draft actually produced, so
 * a key is only dropped once we have seen the real line-up for this vendor.
 * Bathroom lines are migrated rather than dropped: their pre-split key still
 * carries what somebody typed.
 *
 * The `claimed` guard is BEST EFFORT, not a proof. It blocks the migration
 * while another live line still owns the plain key — but in the scenario above,
 * where the hall's color changed, the key stops being claimed at exactly that
 * moment and the bathroom can still inherit it. The ambiguity is real: a
 * bathroom saved before the split used that same key, and nothing in the row
 * says which it was. The guard catches the common shape (both lines live at
 * once); it does not make the migration safe in general.
 */
export function pruneToLiveKeys(
  payload: OrderBuildPayload,
  liveKeys: ReadonlyArray<{ key: string; legacyKey: string | null }>
): OrderBuildPayload {
  if (liveKeys.length === 0) return payload;
  // A plain key that ANOTHER live line owns is that line's, not a leftover.
  // Migrating it onto the bathroom copied the hall's quantity and product onto
  // a second row — 4 gallons nobody typed, on the wrong product, reaching the
  // vendor — which is exactly what claimedPlainKeys refuses everywhere else.
  const claimed = new Set(liveKeys.map((k) => k.key));
  const migrate = <T,>(rec: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const { key, legacyKey } of liveKeys) {
      const usable = legacyKey && !claimed.has(legacyKey) ? rec[legacyKey] : undefined;
      const v = rec[key] ?? usable;
      if (v !== undefined) out[key] = v;
    }
    return out;
  };
  const quantities = migrate(payload.quantities);
  const materialTypeOverrides = migrate(payload.materialTypeOverrides);
  // Nothing changed → return the SAME object, so this can run in an effect
  // without re-triggering every dependent of `payload`.
  const same =
    Object.keys(quantities).length === Object.keys(payload.quantities).length &&
    Object.keys(materialTypeOverrides).length === Object.keys(payload.materialTypeOverrides).length &&
    Object.entries(quantities).every(([k, v]) => payload.quantities[k] === v) &&
    Object.entries(materialTypeOverrides).every(([k, v]) => payload.materialTypeOverrides[k] === v);
  return same ? payload : { ...payload, quantities, materialTypeOverrides };
}
