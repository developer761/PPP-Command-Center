/**
 * Project purchases / job-cost categories (Phase 2).
 *
 * The cost side of a project — money OUT, tagged to a deal. Kept entirely
 * separate from invoicing (what we charge the customer never changes with cost).
 * These categories drive the per-category P&L breakdown + tones.
 */

export const PURCHASE_CATEGORIES = [
  "materials",
  "labor",
  "subcontractor",
  "equipment",
  "permit",
  "other",
] as const;

export type PurchaseCategory = (typeof PURCHASE_CATEGORIES)[number];

/**
 * The categories anyone can actually CHOOSE.
 *
 * Katie, 2026-09-16, having had to ask what the difference was: "just have
 * subcontract labor because that's what we use." She was right to ask — Tomco
 * pay labor companies for people's time, which is `labor`; `subcontractor` is
 * for a trade company quoting a scope, and they have never booked one. Zero
 * rows, and a category whose only effect is to make somebody ask what it means
 * is costing more than it earns.
 *
 * It stays VALID in PURCHASE_CATEGORIES — the DB CHECK allows it, and a row
 * that ever carried it must keep rendering its label rather than failing
 * validation. It is simply no longer offered. Same treatment `estimating` and
 * `solicitation` got on the opportunity sub-statuses.
 */
export const OFFERED_PURCHASE_CATEGORIES = PURCHASE_CATEGORIES.filter(
  (c) => c !== "subcontractor"
) as readonly PurchaseCategory[];

export function isPurchaseCategory(v: string): v is PurchaseCategory {
  return (PURCHASE_CATEGORIES as readonly string[]).includes(v);
}

export const PURCHASE_CATEGORY_META: Record<
  PurchaseCategory,
  { label: string; plural: string; tone: "cc-brand" | "ppp-blue" | "amber" | "emerald" | "charcoal" }
> = {
  materials: { label: "Materials", plural: "Materials", tone: "cc-brand" },
  // "labor" = manual 1099 / day-labor purchases (individual workers). In-house
  // W-2 crew cost is the separate auto "Crew labor" line (Option A, from time
  // entries), so this is disambiguated as "Subcontract labor".
  labor: { label: "Subcontract labor", plural: "Subcontract labor", tone: "ppp-blue" },
  subcontractor: { label: "Subcontractor", plural: "Subcontractors", tone: "amber" },
  equipment: { label: "Equipment", plural: "Equipment", tone: "emerald" },
  permit: { label: "Permit", plural: "Permits", tone: "charcoal" },
  other: { label: "Other", plural: "Other", tone: "charcoal" },
};

export function purchaseCategoryLabel(c: string): string {
  return isPurchaseCategory(c) ? PURCHASE_CATEGORY_META[c].label : "Other";
}
