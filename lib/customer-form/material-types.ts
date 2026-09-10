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

/**
 * The seven generic sheens, offered when a product declares no list of its own.
 *
 * Lived in customer-form-view.tsx as FINISH_OPTIONS while the server kept its
 * own hand-typed VALID_FINISHES. Two lists, maintained by hand, that had to
 * agree: on 2026-09-09 they stopped, because Jason's answers added Pearl and
 * Velvet to the picker and the server still rejected both with a 400. Now the
 * picker and the validator are computed from the SAME source.
 */
export const BASE_FINISHES: readonly string[] = [
  "Flat",
  "Matte",
  "Eggshell",
  "Satin",
  "Semi-Gloss",
  "Gloss",
  "High-Gloss",
];

/** Legacy combined labels — kept accepted so a form filled in before the
 *  Flat/Matte and Gloss/High-Gloss splits still submits. */
const LEGACY_FINISHES: readonly string[] = ["Flat / Matte", "Gloss / High-Gloss"];

/** Finishes a product is sold in, split when the interior and exterior
 *  versions of the same line differ (all three Sherwin Williams grades do). */
export type FinishesByScope = {
  interior?: readonly string[];
  exterior?: readonly string[];
};

export type MaterialType = {
  /** Value sent to SF / stored on the token / written to WorkOrder.MaterialType__c. */
  value: string;
  /** Group label for the optgroup in the picker. */
  group: string;
  /** Determines whether this product shows up for interior, exterior, or
   *  both kinds of work. "any" = always shows (use for "Other"). */
  category: MaterialTypeCategory;
  /**
   * The finishes this product is ACTUALLY sold in (Jason, 2026-09-09).
   *
   * Before this, every product offered the same seven sheens, which is how a
   * rear deck got ordered in eggshell. Absent = fall back to the generic list;
   * present = this is the whole truth for that product.
   */
  finishes?: readonly string[] | FinishesByScope;
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
  // Jason §4, 2026-09-09. These are ADDITIONS, not renames: every value here is
  // also accepted vocabulary for work orders already carrying it, so renaming
  // "Ultra Spec Exterior Primer" would make existing jobs fail validation. He
  // clarified it as the MASONRY primer; both names now resolve.
  { value: "Ultra Spec Exterior Masonry Primer", group: "Benjamin Moore — Primer", category: "exterior" },
  { value: "Ultra Spec Interior Latex Primer", group: "Benjamin Moore — Primer", category: "interior" },
  // "Bin primer (interior and exterior shellac based)".
  { value: "BIN Primer", group: "Benjamin Moore — Primer", category: "any" },
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
  { value: "Mooreglo", group: "Benjamin Moore — Exterior", category: "exterior", finishes: ["Soft Gloss"] },
  { value: "Mooregard", group: "Benjamin Moore — Exterior", category: "exterior", finishes: ["Low Lustre"] },
  { value: "Moore Life", group: "Benjamin Moore — Exterior", category: "exterior", finishes: ["Flat"] },
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
  // Finishes per product from Jason's completed sheet, 2026-09-09. His rule for
  // EXTERIOR overall: add Low Lustre + Soft Gloss, drop Matte / Eggshell /
  // Semi-Gloss / High-Gloss. That removal is exterior-only — his own interior
  // answers (§6) keep matte, eggshell and semigloss — so the exterior lists
  // below simply never contain them.
  {
    value: "Ultra Spec", group: "Benjamin Moore", category: "any",
    // §6: "Ultra spec satin" was missing from the interior line.
    finishes: {
      interior: ["Flat", "Eggshell", "Satin", "Semi-Gloss"],
      exterior: ["Low Lustre", "Satin", "Soft Gloss"],
    },
  },
  {
    value: "Regal Select", group: "Benjamin Moore", category: "interior",
    // §6: "Regal select satin/pearl". Stays INTERIOR — Jason's exterior answer
    // is a DIFFERENT product ("Regal select high build"), listed below, so
    // widening this one would put it on exterior jobs it is not sold for.
    finishes: ["Flat", "Matte", "Eggshell", "Satin", "Pearl", "Semi-Gloss"],
  },
  {
    value: "Ben", group: "Benjamin Moore", category: "interior",
    // §6: "Ben matte, eggshell, satin/pearl, semigloss".
    finishes: ["Matte", "Eggshell", "Satin", "Pearl", "Semi-Gloss"],
  },
  {
    value: "Aura", group: "Benjamin Moore", category: "any",
    // Bath & Spa is a Salesforce finish value in its own right, which is how
    // the old "Aura Bath & Spa Matte" product encoded the same thing.
    finishes: {
      interior: ["Matte", "Eggshell", "Satin", "Semi-Gloss", "Bath & Spa (Aura)"],
      exterior: ["Low Lustre", "Satin", "Soft Gloss"],
    },
  },
  // Jason's Short List, 2026-09-10: "rename mooreglo soft gloss / rename
  // mooreguard low lustre / rename moorlife flat". His spelling, and his call —
  // these are named the way the supplier lists them. Each still declares the
  // single finish it is sold in, so the name and the finish agree by
  // construction rather than by anyone remembering to keep them in step.
  //
  // The OLD values are NOT deleted: they remain in MATERIAL_TYPES, now carrying
  // the same finish list, so a work order already saying "Mooregard" still
  // validates AND still offers only Low Lustre instead of dropping to the
  // generic exterior list.
  { value: "Mooreglo Soft Gloss", group: "Benjamin Moore — Exterior", category: "exterior", finishes: ["Soft Gloss"] },
  { value: "Mooreguard Low Lustre", group: "Benjamin Moore — Exterior", category: "exterior", finishes: ["Low Lustre"] },
  { value: "Moorlife Flat", group: "Benjamin Moore — Exterior", category: "exterior", finishes: ["Flat"] },
  // §2 "Missing from this list: Regal select high build in flat, low lustre,
  // soft gloss."
  {
    value: "Regal Select High Build", group: "Benjamin Moore — Exterior", category: "exterior",
    finishes: ["Flat", "Low Lustre", "Soft Gloss"],
  },
  // §5 — all three SW grades are sold in BOTH scopes with DIFFERENT sheens,
  // which is why they were wrong as a single "any" list.
  {
    value: "SW Emerald", group: "Sherwin Williams", category: "any",
    finishes: {
      interior: ["Flat", "Matte", "Satin", "Semi-Gloss"],
      exterior: ["Flat", "Satin", "Gloss"],
    },
  },
  {
    value: "SW Emerald Urethane Trim/Cabinets", group: "Sherwin Williams", category: "interior",
    finishes: ["Satin", "Semi-Gloss", "Gloss"],
  },
  {
    value: "SW Duration", group: "Sherwin Williams", category: "any",
    finishes: {
      interior: ["Flat", "Matte", "Satin", "Semi-Gloss"],
      exterior: ["Flat", "Low Lustre", "Satin", "Gloss"],
    },
  },
  {
    value: "SW Super Paint", group: "Sherwin Williams", category: "any",
    // ⚠ "Velvet" (interior) and "High-Gloss" (exterior) are NOT values on
    // Salesforce's restricted Finish*__c picklists. Kept because Jason is the
    // authority on what PPP paints with and hiding a real sheen makes the
    // picker wrong — but until Katie adds them in Salesforce, choosing one
    // saves the color and drops the sheen. `npm run check:sf-picklists` names
    // them on every run so this cannot go quiet.
    finishes: {
      interior: ["Flat", "Satin", "Velvet", "Semi-Gloss"],
      exterior: ["Flat", "Low Lustre", "Satin", "Gloss", "High-Gloss"],
    },
  },
    // ── Stains (Jason §3, 2026-09-09) ────────────────────────────────────────
  // "There is no stain product in the system anywhere. This is what caused the
  // rear-deck error." A stain is sold by OPACITY, not by sheen, so its opacity
  // list goes in `finishes` — the per-product machinery does not care what the
  // options mean, only that this product is sold in exactly these.
  //
  // Base (water vs oil) is carried by the PRODUCT rather than mixed into the
  // opacity list, because that is how it is bought and because Jason's one
  // exception is a base rule: "all can be water based or oil with exception of
  // solid which is water only" — so Solid simply does not appear on the oil
  // product. It also keeps the dropdown at five short options, not nine
  // hyphenated ones, which matters for the crews using this.
  {
    value: "Woodluxe Water-Based Stain", group: "Stains — Exterior", category: "exterior",
    finishes: ["Transparent", "Translucent", "Semi-Transparent", "Semi-Solid", "Solid"],
  },
  {
    value: "Woodluxe Oil-Based Stain", group: "Stains — Exterior", category: "exterior",
    // No Solid — Jason: solid is water only.
    finishes: ["Transparent", "Translucent", "Semi-Transparent", "Semi-Solid"],
  },
  {
    value: "SW SuperDeck Stain", group: "Stains — Exterior", category: "exterior",
    // "Sw super deck exterior stain similar to woodluxe." Same opacity ladder;
    // he did not split its base, so it is left un-split rather than invented.
    finishes: ["Transparent", "Translucent", "Semi-Transparent", "Semi-Solid", "Solid"],
  },
  {
    value: "Minwax Stain", group: "Stains — Interior", category: "interior",
    // "Interior = minwax or old masters typically all semi transparent — the
    // finish comes from the clear you put on top, usually poly or spar
    // varnish." So the stain offers one opacity; the sheen belongs to a
    // topcoat product PPP has not given us yet.
    finishes: ["Semi-Transparent"],
  },
  {
    value: "Old Masters Stain", group: "Stains — Interior", category: "interior",
    finishes: ["Semi-Transparent"],
  },
  { value: "Other", group: "Other", category: "any" },
];

export const PAINT_LINE_VALUES: ReadonlySet<string> = new Set(PAINT_LINES.map((l) => l.value));

/**
 * Every finish value the app can legitimately produce — the union of the
 * generic sheens, every per-product list (both scopes), and the legacy labels.
 *
 * The submit route validates against THIS, so adding a finish to a product can
 * never again be rejected by a server list somebody forgot to update. That is
 * not hypothetical: it happened the same day the per-product lists landed.
 */
export const ALL_FINISH_VALUES: ReadonlySet<string> = new Set([
  ...BASE_FINISHES,
  ...LEGACY_FINISHES,
  ...[...PAINT_LINES, ...MATERIAL_TYPES].flatMap((m) => {
    const f = m.finishes;
    if (!f) return [];
    if (Array.isArray(f)) return [...f];
    const scoped = f as FinishesByScope;
    return [...(scoped.interior ?? []), ...(scoped.exterior ?? [])];
  }),
]);

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
export function isValidMaterialTypeValue(value: string): boolean {
  // A deliberate "Other: <product>" is valid however it is spelled — that is
  // the whole point of the free-text option. Everything else must be a known
  // value, so a tampered payload still cannot inject an arbitrary product.
  if (value.startsWith(OTHER_PREFIX) && value.slice(OTHER_PREFIX.length).trim().length > 0) {
    return true;
  }
  return VALID_MATERIAL_TYPE_VALUES.has(value);
}

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

/**
 * "Other" as a paint line, with the product a worker actually typed.
 *
 * Katie item 11, 2026-09-08: "Other should always let me manually put stuff in,
 * it should never default as Other." Picking Other used to store the literal
 * word, and that is what reached the vendor — a paint counter cannot fill an
 * order for "Other".
 *
 * Stored as `Other: Behr Premium Plus`. The prefix is what lets the submit
 * guard tell a deliberate free-text entry from a tampered value: the guard
 * checks membership in VALID_MATERIAL_TYPE_VALUES, so a bare hand-typed product
 * would be rejected outright.
 */
export const OTHER_PREFIX = "Other: ";

export function makeOtherValue(text: string): string {
  return `${OTHER_PREFIX}${text.trim()}`;
}

/** True for "Other" itself and for any "Other: …" free-text value. */
export function isOtherValue(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v === "Other" || v.startsWith(OTHER_PREFIX);
}

/** The product a worker typed, or "" when they picked Other and typed nothing. */
export function otherValueText(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v.startsWith(OTHER_PREFIX) ? v.slice(OTHER_PREFIX.length).trim() : "";
}

/**
 * What a VENDOR should read for this product line.
 *
 * An "Other: …" value prints the typed product alone — the prefix is our
 * bookkeeping, not something a supplier needs to see. Everything else prints
 * as-is. Returns "" for a bare "Other" with nothing typed, so the caller omits
 * the line rather than printing a placeholder.
 */
export function materialTypeForVendor(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (v === "Other") return "";
  if (v.startsWith(OTHER_PREFIX)) return otherValueText(v);
  return v;
}

/**
 * Finishes a given product can actually be bought in.
 *
 * Katie item 19, 2026-09-08: "one of the items was rear deck and it defaulted
 * as eggshell, and stain doesn't come in eggshell."
 *
 * Stain is sold by opacity, not by sheen — the interior sheens are not
 * available in it at any price, so offering them produces an order a supplier
 * cannot fill. This REMOVES the impossible options rather than inventing PPP's
 * stain vocabulary: the real list of stain products and their finishes is
 * coming from Jason (item 21), and guessing it here would be a worse error than
 * the one being fixed.
 */
const INTERIOR_ONLY_SHEENS: ReadonlySet<string> = new Set(["Flat", "Matte", "Eggshell"]);

/**
 * Sheens that only exist on exterior product lines.
 *
 * Kate 2026-09-09: "the team need Low Lustre and Soft Gloss as available
 * finishes for exterior line items." Both were already ACTIVE values on
 * Salesforce's FinishWall__c / FinishCeiling__c / FinishTrim__c / FinishFloor__c
 * restricted picklists — the app simply never offered them, so an estimator
 * ordering Ultra Spec Exterior Soft Gloss had no way to say so. They are kept
 * OFF the interior list because that is where they would be wrong: BM sells
 * them on the exterior range only.
 */
const EXTERIOR_ONLY_SHEENS: readonly string[] = ["Low Lustre", "Soft Gloss"];

/** Sheens Jason struck off the EXTERIOR list (§1). They stay on interior. */
const INTERIOR_ONLY_EXTERIOR_DROPS: ReadonlySet<string> = new Set([
  "Matte", "Eggshell", "Semi-Gloss", "High-Gloss",
]);

/**
 * True when this product line is sold as an exterior product.
 *
 * Checks the RAW value before `paintLineFromValue`, which deliberately
 * collapses to the short line vocabulary — "Ultra Spec Exterior Soft Gloss"
 * becomes "Ultra Spec", whose category is "any", and the exterior-ness is
 * exactly the information that collapse throws away.
 */
export function isExteriorProduct(materialType: string | null | undefined): boolean {
  const raw = (materialType ?? "").trim();
  if (!raw) return false;
  const lookup = (v: string) =>
    MATERIAL_TYPES.find((m) => m.value === v) ?? PAINT_LINES.find((m) => m.value === v);
  if (lookup(raw)?.category === "exterior") return true;
  // A scoped value the picker built ("Ultra Spec Exterior") names its own side.
  if (/\bexterior\b/i.test(raw)) return true;
  return lookup(paintLineFromValue(raw))?.category === "exterior";
}

/** True when this product line is a stain rather than a paint. */
export function isStainProduct(materialType: string | null | undefined): boolean {
  return /\bstain(s|ed|ing)?\b/i.test(materialType ?? "");
}

/** The product entry for a value, raw first then collapsed to its line. */
function productFor(materialType: string | null | undefined): MaterialType | undefined {
  const raw = (materialType ?? "").trim();
  if (!raw) return undefined;
  const find = (v: string) =>
    PAINT_LINES.find((m) => m.value === v) ?? MATERIAL_TYPES.find((m) => m.value === v);
  return find(raw) ?? find(paintLineFromValue(raw));
}

/**
 * Finishes to offer for a product.
 *
 * Jason's sheet (2026-09-09) gave the real per-product lists, so a product that
 * declares its finishes is authoritative — that is the whole point of asking:
 * "each product will only offer the finishes you list for it, so a stain can
 * never be ordered in eggshell again."
 *
 * `scope` matters because all three Sherwin Williams grades are sold in both
 * interior and exterior versions with DIFFERENT sheens (SW Duration is matte
 * inside and low lustre outside). Without it they were one merged list that was
 * wrong for both.
 *
 * Products with no declared list fall back to the previous generic behaviour,
 * so an unanswered product keeps working rather than losing every option.
 */
export function finishOptionsFor(
  allOptions: readonly string[],
  materialType: string | null | undefined,
  scope?: "interior" | "exterior" | null
): string[] {
  const product = productFor(materialType);
  const declared = product?.finishes;
  if (declared) {
    if (Array.isArray(declared)) return [...declared];
    const byScope = declared as FinishesByScope;
    const wanted = scope === "exterior" ? byScope.exterior : scope === "interior" ? byScope.interior : null;
    if (wanted) return [...wanted];
    // No scope signal. Default to INTERIOR, which is the rule this file already
    // applies in materialTypeToSf: "Interior is the overwhelming majority of
    // PPP's work, so it's the safer default." Offering the union instead would
    // put Low Lustre on an ordinary interior job, and a wrong sheen becomes a
    // wrong order rather than a wrong dropdown.
    return [...(byScope.interior ?? byScope.exterior ?? allOptions)];
  }

  // ── Fallback for products Jason did not list ──────────────────────────────
  // §1 is a rule about EXTERIOR generally, not about one product: "Finishes we
  // should add: low lustre, soft gloss. Finishes we should remove: matte,
  // eggshell, semi gloss, high gloss." Removal is exterior-only — his own §6
  // interior answers keep all three — so an exterior product with no list of
  // its own gets the exterior vocabulary rather than the interior one plus two.
  const base = isExteriorProduct(materialType) || scope === "exterior"
    ? [...allOptions.filter((f) => !INTERIOR_ONLY_EXTERIOR_DROPS.has(f)),
       ...EXTERIOR_ONLY_SHEENS.filter((f) => !allOptions.includes(f))]
    : [...allOptions];
  if (!isStainProduct(materialType)) return base;
  return base.filter((f) => !INTERIOR_ONLY_SHEENS.has(f));
}
