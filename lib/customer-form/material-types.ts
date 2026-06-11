/**
 * Material Type (paint product line) picklist — shared source of truth for
 * the customer form picker, the server-side allowlist (submit validation),
 * and the admin per-surface override dropdown in the supplier-order modal.
 *
 * Each entry carries a `category` flag — "interior" / "exterior" / "any" —
 * so the customer form (and admin modal) can filter dynamically. Per
 * Katie 2026-06-05: "Woodluxe is for decks (exterior only); interior flat
 * white would never be used on an exterior." When the WO clearly has only
 * interior areas, exterior products hide; vice versa. Mixed jobs show all.
 *
 * Adding a new product (when Katie sends the expanded list):
 *   1. Append the entry below with the correct category.
 *   2. Customer + admin pickers + the submit allowlist all pick it up
 *      automatically — no other code changes needed.
 *
 * The order within a group preserves the customer-facing dropdown order
 * (Ultra Spec → Regal Select → Aura mirrors BM's price ladder).
 */

export type MaterialTypeCategory = "interior" | "exterior" | "any";

export type MaterialType = {
  /** Value sent to SF / stored on the token / written to WorkOrder.MaterialType__c. */
  value: string;
  /** Group label for the optgroup in the picker. */
  group: string;
  /** Determines whether this product shows up for interior, exterior, or
   *  both kinds of work. "any" = always shows (use for "Other"). */
  category: MaterialTypeCategory;
};

// Katie's expanded list shipped 2026-06-10 ("Products Short List
// (categorized).xlsx"). Three groups: Primer, Interior, Exterior. Source
// order preserved so the dropdown matches her spreadsheet for handoff /
// training. Sherwin Williams entries kept (SW is in PPP's vendor list
// even though Katie's primary supplier is BM) until Katie sends an SW
// breakdown; mark them "any" since the SW grades are dual-use.
export const MATERIAL_TYPES: ReadonlyArray<MaterialType> = [
  // Benjamin Moore — Primer (universal unless explicitly exterior)
  { value: "Fresh Start Latex 046", group: "Benjamin Moore — Primer", category: "any" },
  { value: "Fresh Start Oil 094", group: "Benjamin Moore — Primer", category: "any" },
  { value: "Ultra Spec Exterior Primer", group: "Benjamin Moore — Primer", category: "exterior" },
  { value: "Coverstain Primer", group: "Benjamin Moore — Primer", category: "any" },
  { value: "Stix Primer", group: "Benjamin Moore — Primer", category: "any" },
  // Benjamin Moore — Interior (finish-specific per Katie's spreadsheet)
  { value: "Ultra Spec Interior Flat", group: "Benjamin Moore — Interior", category: "interior" },
  { value: "Ultra Spec Interior Eggshell", group: "Benjamin Moore — Interior", category: "interior" },
  { value: "Ultra Spec Interior Semi Gloss", group: "Benjamin Moore — Interior", category: "interior" },
  { value: "Regal Select Flat", group: "Benjamin Moore — Interior", category: "interior" },
  { value: "Regal Select Matte", group: "Benjamin Moore — Interior", category: "interior" },
  { value: "Regal Select Eggshell", group: "Benjamin Moore — Interior", category: "interior" },
  { value: "Regal Select Semi Gloss", group: "Benjamin Moore — Interior", category: "interior" },
  { value: "Aura Bath & Spa Matte", group: "Benjamin Moore — Interior", category: "interior" },
  // Benjamin Moore — Exterior
  { value: "Ultra Spec Exterior Low Sheen", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "Ultra Spec Exterior Satin", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "Ultra Spec Exterior Soft Gloss", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "Mooreglo", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "Mooregard", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "Moore Life", group: "Benjamin Moore — Exterior", category: "exterior" },
  // Sherwin Williams — kept until Katie sends an SW finish breakdown
  { value: "SW Emerald", group: "Sherwin Williams", category: "any" },
  { value: "SW Duration", group: "Sherwin Williams", category: "any" },
  { value: "SW Super Paint", group: "Sherwin Williams", category: "any" },
  // Other — keep so the form is never empty for an unusual job.
  { value: "Other", group: "Other", category: "any" },
];

/** Set of every valid value — used by the submit handler's tampered-input
 *  guard. Generated once at module load so the lookup is O(1). */
export const VALID_MATERIAL_TYPE_VALUES: ReadonlySet<string> = new Set(
  MATERIAL_TYPES.map((m) => m.value)
);

/** True when this WO has any interior surfaces. Used to filter exterior-only
 *  products out of the picker when there's no exterior work on the job.
 *  Heuristic: WO.WorkType.Name OR WOLI.ProductName__c contains "interior". */
export function isInteriorWorkOrder(input: {
  workTypeName?: string | null;
  lineItemProductNames?: ReadonlyArray<string | null>;
}): boolean {
  if (input.workTypeName && /interior/i.test(input.workTypeName)) return true;
  return (input.lineItemProductNames ?? []).some((n) => n && /interior/i.test(n));
}

/** True when this WO has any exterior surfaces. Same heuristic, "exterior". */
export function isExteriorWorkOrder(input: {
  workTypeName?: string | null;
  lineItemProductNames?: ReadonlyArray<string | null>;
}): boolean {
  if (input.workTypeName && /exterior/i.test(input.workTypeName)) return true;
  return (input.lineItemProductNames ?? []).some((n) => n && /exterior/i.test(n));
}

/** Filter the picklist for a specific WO context. Returns ALL options when
 *  the job has both interior + exterior areas (mixed jobs need the full set
 *  so admin / customer can pick per surface). Returns interior+any when the
 *  job is interior-only; exterior+any when exterior-only. Empty WO context
 *  returns everything (safe default).
 *
 *  Group structure preserved for the optgroup-rendered picker. */
export function filterMaterialTypesForWorkOrder(
  context: {
    workTypeName?: string | null;
    lineItemProductNames?: ReadonlyArray<string | null>;
  }
): Array<{ label: string; options: string[] }> {
  const hasInterior = isInteriorWorkOrder(context);
  const hasExterior = isExteriorWorkOrder(context);
  // Both (mixed) OR neither (no signal) → return everything.
  const showAll = (hasInterior && hasExterior) || (!hasInterior && !hasExterior);
  const allow = (c: MaterialTypeCategory): boolean => {
    if (showAll) return true;
    if (c === "any") return true;
    if (hasInterior && c === "interior") return true;
    if (hasExterior && c === "exterior") return true;
    return false;
  };
  // Group → ordered options. Iterate MATERIAL_TYPES once so the source order
  // becomes the user-visible order.
  const groups: Array<{ label: string; options: string[] }> = [];
  for (const m of MATERIAL_TYPES) {
    if (!allow(m.category)) continue;
    let bucket = groups.find((g) => g.label === m.group);
    if (!bucket) {
      bucket = { label: m.group, options: [] };
      groups.push(bucket);
    }
    bucket.options.push(m.value);
  }
  return groups;
}
