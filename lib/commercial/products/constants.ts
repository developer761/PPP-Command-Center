/**
 * Phase D Product Library enums + display helpers.
 *
 * Categories + units are stored as TEXT in the DB (not a Postgres enum)
 * so admins can add new categories from the UI without a schema change.
 * These constants are the authoritative source at the application layer.
 */

export const PRODUCT_CATEGORIES = [
  "paint",
  "sundry",
  "labor",
  "other",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_UNITS = [
  "gallon",
  "hour",
  "each",
  "linear_foot",
  "square_foot",
  "linear_yard",
] as const;

export type ProductUnit = (typeof PRODUCT_UNITS)[number];

const CATEGORY_LABELS: Record<ProductCategory, string> = {
  paint: "Paint",
  sundry: "Sundry",
  labor: "Labor",
  other: "Other",
};

const UNIT_LABELS: Record<ProductUnit, string> = {
  gallon: "gallon",
  hour: "hour",
  each: "each",
  linear_foot: "linear ft",
  square_foot: "sq ft",
  linear_yard: "linear yd",
};

export function productCategoryLabel(c: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[c] ?? c;
}

export function productUnitLabel(u: string): string {
  return (UNIT_LABELS as Record<string, string>)[u] ?? u;
}
