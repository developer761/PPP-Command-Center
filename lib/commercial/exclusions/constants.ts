/**
 * Phase F.0 Exclusions Library — enums + display helpers.
 *
 * Two categories:
 *   - standard  : auto-added to every new proposal (the 2 canonical Tomco
 *                 bullets that appear on every proposal per Katie's spec).
 *   - optional  : hand-picked per proposal via <ExclusionPicker>.
 *
 * Stored as TEXT (not Postgres enum) so admins can add new categories
 * from the UI without a schema change if the taxonomy grows.
 */

export const EXCLUSION_CATEGORIES = ["standard", "optional"] as const;
export type ExclusionCategory = (typeof EXCLUSION_CATEGORIES)[number];

const CATEGORY_LABELS: Record<ExclusionCategory, string> = {
  standard: "Standard",
  optional: "Optional",
};

export function exclusionCategoryLabel(c: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[c] ?? c;
}
