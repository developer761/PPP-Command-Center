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

export function isPurchaseCategory(v: string): v is PurchaseCategory {
  return (PURCHASE_CATEGORIES as readonly string[]).includes(v);
}

export const PURCHASE_CATEGORY_META: Record<
  PurchaseCategory,
  { label: string; plural: string; tone: "cc-brand" | "ppp-blue" | "amber" | "emerald" | "charcoal" }
> = {
  materials: { label: "Materials", plural: "Materials", tone: "cc-brand" },
  labor: { label: "Labor", plural: "Labor", tone: "ppp-blue" },
  subcontractor: { label: "Subcontractor", plural: "Subcontractors", tone: "amber" },
  equipment: { label: "Equipment", plural: "Equipment", tone: "emerald" },
  permit: { label: "Permit", plural: "Permits", tone: "charcoal" },
  other: { label: "Other", plural: "Other", tone: "charcoal" },
};

export function purchaseCategoryLabel(c: string): string {
  return isPurchaseCategory(c) ? PURCHASE_CATEGORY_META[c].label : "Other";
}
