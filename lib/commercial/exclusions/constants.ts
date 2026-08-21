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

// ────────────── exclusion vs qualification (migration 164) ──────────────

/**
 * Stephanie 2026-08-17: "Qualifications should be its own section after
 * exclusions, not grouped in with alternates."
 *
 * Two different statements on a Tomco proposal:
 *   exclusion     — work we are NOT doing ("Excludes drywall repair")
 *   qualification — a condition the PRICE DEPENDS ON ("Assumes one
 *                   mobilisation", "Assumes clear and unobstructed access")
 *
 * One list printed under one "Exclusions:" heading meant a qualification either
 * read as a refusal, or got typed into the alternate notes to stay out of it —
 * which is how it ended up sitting with the alternates on the page.
 */
export const EXCLUSION_KINDS = ["exclusion", "qualification"] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];

const KIND_LABELS: Record<ExclusionKind, string> = {
  exclusion: "Exclusion",
  qualification: "Qualification",
};

export function exclusionKindLabel(k: ExclusionKind): string {
  return KIND_LABELS[k];
}

export function isExclusionKind(v: unknown): v is ExclusionKind {
  return typeof v === "string" && (EXCLUSION_KINDS as readonly string[]).includes(v);
}
