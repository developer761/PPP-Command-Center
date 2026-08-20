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

/* ─── Paint LINES (Kate round-3 #09) ────────────────────────────────────────
 *
 * Kate: "The product line picker should list the line only — Ultra Spec, Regal
 * Select, Ben, Aura — not the line plus finish. The finish is already captured
 * at the surface level when colors are entered, so carrying it here asks the
 * same question twice and lets the two answers disagree."
 *
 * She's right, and the disagreement was real: a customer could pick "Regal
 * Select Eggshell" as the job's product line and then choose Semi-Gloss on the
 * walls, and nothing reconciled the two.
 *
 * The finish-bearing values above are NOT deleted. They stay as the legacy
 * vocabulary so:
 *   - work orders already carrying "Regal Select Eggshell" still validate,
 *   - the picker can show them as their line rather than blanking out.
 *
 * ⚠️ WorkOrder.MaterialType__c is a Salesforce PICKLIST. If it is a RESTRICTED
 * picklist, the line-only values have to be added there before writes with them
 * will stick. Flagged for Katie.
 */
export const PAINT_LINES: ReadonlyArray<MaterialType> = [
  { value: "Ultra Spec", group: "Benjamin Moore", category: "any" },
  { value: "Regal Select", group: "Benjamin Moore", category: "interior" },
  { value: "Ben", group: "Benjamin Moore", category: "interior" },
  { value: "Aura", group: "Benjamin Moore", category: "any" },
  { value: "Mooreglo", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "Mooregard", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "Moore Life", group: "Benjamin Moore — Exterior", category: "exterior" },
  { value: "SW Emerald", group: "Sherwin Williams", category: "any" },
  { value: "SW Duration", group: "Sherwin Williams", category: "any" },
  { value: "SW Super Paint", group: "Sherwin Williams", category: "any" },
  { value: "Other", group: "Other", category: "any" },
];

export const PAINT_LINE_VALUES: ReadonlySet<string> = new Set(PAINT_LINES.map((l) => l.value));

/**
 * Collapse a stored value to its paint line.
 *
 * Handles the three things that can be in the field today: a new line-only
 * value (returned as-is), a legacy line+finish value ("Ultra Spec Interior
 * Eggshell" → "Ultra Spec"), and anything unrecognised (returned untouched, so
 * an odd hand-typed Salesforce value still shows rather than vanishing).
 *
 * Longest-first matching matters: "Moore Life" and "Mooreglo" both start with
 * "Moore", and "Ultra Spec Exterior Primer" must not be read as "Ultra Spec".
 */
export function paintLineFromValue(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (PAINT_LINE_VALUES.has(v)) return v;
  // Primers are their own thing — never collapse one into a topcoat line.
  if (PRIMER_MATERIAL_VALUES.has(v)) return v;
  const candidates = [...PAINT_LINE_VALUES]
    .filter((line) => line !== "Other")
    .sort((a, b) => b.length - a.length);
  for (const line of candidates) {
    if (v === line || v.startsWith(`${line} `)) return line;
  }
  return v;
}

/** Set of every valid value — used by the submit handler's tampered-input
 *  guard. Accepts BOTH the line-only vocabulary and the legacy line+finish
 *  values, so reshaping the picker can't reject a work order that was filled
 *  in last month. Generated once at module load so the lookup is O(1). */
export const VALID_MATERIAL_TYPE_VALUES: ReadonlySet<string> = new Set([
  ...MATERIAL_TYPES.map((m) => m.value),
  ...PAINT_LINES.map((l) => l.value),
]);

/** Kate round-2 #22: primers are a separate purchase from the topcoat product
 *  line — they belong in Extras, not the color's "product line" dropdown.
 *  Exported so the Order Materials modal can filter them out of the line
 *  pickers and offer them as add-on extras instead. */
export const PRIMER_MATERIAL_VALUES: ReadonlySet<string> = new Set(
  MATERIAL_TYPES.filter((m) => /primer/i.test(m.group)).map((m) => m.value)
);
export const PRIMER_MATERIAL_TYPES: ReadonlyArray<MaterialType> = MATERIAL_TYPES.filter(
  (m) => /primer/i.test(m.group)
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

/** Filter the paint-line picklist for a specific WO context. Returns ALL
 *  options when the job has both interior + exterior areas (mixed jobs need the
 *  full set so admin / customer can pick per surface). Returns interior+any when
 *  the job is interior-only; exterior+any when exterior-only. Empty WO context
 *  returns everything (safe default).
 *
 *  Kate round-3 #08 + #09: this drives every product-line picker — the customer
 *  form, the internal AM form and the order builder. It walks PAINT_LINES, so
 *  it lists LINES only (no finishes) and contains no primers. Primers are
 *  add-on Extras on the order screen, not a topcoat line; leaving them in this
 *  list is what kept them in the Internal Entry dropdown after round 2 removed
 *  them from the order page.
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
  // Group → ordered options. Iterate PAINT_LINES once so the source order
  // becomes the user-visible order.
  const groups: Array<{ label: string; options: string[] }> = [];
  for (const m of PAINT_LINES) {
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


/* ─── Salesforce picklist mapping ───────────────────────────────────────────
 *
 * WorkOrder.MaterialType__c is a RESTRICTED picklist, and its vocabulary is
 * neither what we used to send nor what we send now. Read from the live org:
 *
 *   Ultra Spec Interior · Regal Select Interior · Aura Interior
 *   Ultra Spec Exterior · Regal Select Exterior · Aura Exterior
 *   SW Emerald · SW Duration · SW Super Paint · Other
 *
 * It is LINE + SCOPE. The old app values carried a FINISH ("Regal Select
 * Eggshell") and the new ones carry no scope ("Regal Select"), so BOTH are
 * rejected — every MaterialType__c write had been failing with
 * INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST since at least 2026-07-14, visible
 * only in sf_writes_audit.
 *
 * Kate's #09 is still right for the UI: a human picks a line, and the finish is
 * asked per surface. The scope isn't a question for a human at all — the work
 * order already knows whether it's interior or exterior work. So we ask for the
 * line and derive the rest.
 */

/** Exactly what the org accepts today. If Salesforce's picklist changes, this
 *  must change with it — a value not in here is never sent. */
export const SF_MATERIAL_TYPE_VALUES: ReadonlySet<string> = new Set([
  "Ultra Spec Interior", "Regal Select Interior", "Aura Interior",
  "Ultra Spec Exterior", "Regal Select Exterior", "Aura Exterior",
  "SW Emerald", "SW Duration", "SW Super Paint", "Other",
]);

/** Lines the org expresses as "<line> Interior" / "<line> Exterior". */
const SCOPED_SF_LINES = ["Ultra Spec", "Regal Select", "Aura"];

/**
 * Translate an app paint line into a value Salesforce will accept, using the
 * work order's own interior/exterior context for the scope.
 *
 * Returns null when there is no valid mapping — the caller MUST then skip the
 * write rather than send something the picklist will reject. Silently sending
 * a doomed value is what hid this for a month.
 */
export function toSalesforceMaterialType(
  appValue: string | null | undefined,
  context: { workTypeName?: string | null; lineItemProductNames?: ReadonlyArray<string | null> }
): string | null {
  const line = paintLineFromValue(appValue);
  if (!line) return null;
  // Already speaks Salesforce (SW grades, "Other", or a legacy scoped value).
  if (SF_MATERIAL_TYPE_VALUES.has(line)) return line;
  if (SF_MATERIAL_TYPE_VALUES.has(appValue ?? "")) return appValue as string;

  if (SCOPED_SF_LINES.includes(line)) {
    const interior = isInteriorWorkOrder(context);
    const exterior = isExteriorWorkOrder(context);
    // A mixed or unknown job can't be resolved to one scope. Interior is the
    // overwhelming majority of PPP's work, so it's the safer default — but only
    // when there's no exterior signal at all.
    const scope = exterior && !interior ? "Exterior" : "Interior";
    const candidate = `${line} ${scope}`;
    return SF_MATERIAL_TYPE_VALUES.has(candidate) ? candidate : null;
  }

  // Ben, Mooreglo, Mooregard, Moore Life have no equivalent in the org's
  // picklist. Don't guess "Other" — that would silently record the wrong paint
  // for a real job. Skip the write and let the caller say so.
  return null;
}

/* ─── Interior vs exterior product lines (R4.3) ─────────────────────────────
 *
 * Kate: "Benjamin Moore uses different product lines for interior and
 * exterior. On a job with both interior and exterior work, one line can't
 * cover it."
 *
 * `filterMaterialTypesForWorkOrder` already narrows by scope, but on a MIXED
 * job it falls back to showing everything in ONE list — which is precisely the
 * case Kate is describing, and the one where a single answer is wrong. So a
 * mixed job gets two pickers, each scoped to its own side.
 */

export type PaintLineLists = {
  /** Null when the job has no interior work — don't render the picker at all. */
  interior: Array<{ label: string; options: string[] }> | null;
  /** Null when the job has no exterior work. */
  exterior: Array<{ label: string; options: string[] }> | null;
  /** True when both are rendered — the caller shows two labelled pickers. */
  isSplit: boolean;
};

function groupsFor(categories: ReadonlyArray<MaterialTypeCategory>): Array<{ label: string; options: string[] }> {
  const groups: Array<{ label: string; options: string[] }> = [];
  for (const m of PAINT_LINES) {
    if (!categories.includes(m.category)) continue;
    let bucket = groups.find((g) => g.label === m.group);
    if (!bucket) {
      bucket = { label: m.group, options: [] };
      groups.push(bucket);
    }
    bucket.options.push(m.value);
  }
  return groups;
}

export function paintLineListsFor(context: {
  workTypeName?: string | null;
  lineItemProductNames?: ReadonlyArray<string | null>;
}): PaintLineLists {
  const hasInterior = isInteriorWorkOrder(context);
  const hasExterior = isExteriorWorkOrder(context);

  // "any" lines (Ultra Spec, Aura, the SW range, Other) belong on BOTH lists —
  // they're sold in interior and exterior variants, and Salesforce carries the
  // scope separately, so the scope is ours to derive rather than theirs to pick.
  const interior = groupsFor(["interior", "any"]);
  const exterior = groupsFor(["exterior", "any"]);

  // No signal at all (no work type, no product names): show both rather than
  // guessing. A wrong single list would hide the line the estimator needs.
  if (!hasInterior && !hasExterior) {
    return { interior, exterior, isSplit: true };
  }
  return {
    interior: hasInterior ? interior : null,
    exterior: hasExterior ? exterior : null,
    isSplit: hasInterior && hasExterior,
  };
}

/**
 * Which of the two chosen lines goes to Salesforce.
 *
 * `WorkOrder.MaterialType__c` is a single restricted picklist — one value per
 * work order — so a job with both an interior and an exterior line cannot be
 * represented there. Verified against the live org: the field's whole
 * vocabulary is line+scope, and WorkOrderLineItem.MaterialType__c is a
 * different, older grade vocabulary ("Ben Moore Contractor", "Standard Grade")
 * that isn't interchangeable.
 *
 * Rather than drop one silently, the rule is explicit and the UI says so:
 * interior wins when both are set, because it's the bulk of PPP's work. BOTH
 * lines are kept in the Command Center and BOTH reach the vendor order, which
 * is where they actually matter.
 */
export function salesforceLineFor(
  interiorLine: string | null | undefined,
  exteriorLine: string | null | undefined
): { chosen: string | null; dropped: string | null } {
  const int = (interiorLine ?? "").trim();
  const ext = (exteriorLine ?? "").trim();
  if (int && ext) return { chosen: int, dropped: ext };
  return { chosen: int || ext || null, dropped: null };
}
