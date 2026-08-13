/**
 * Rating codes and their fallback meanings — pure data, NO server-only import.
 *
 * Split from `rating-labels.ts` for the reason this codebase has learned twice
 * already (`document-categories.ts`, `contacts/roles.ts`): the rating pill is a
 * client-rendered component, and a list it cannot import is a list it will end
 * up copying.
 */

export const RATING_CODES = ["A", "B", "C"] as const;
export type RatingCode = (typeof RATING_CODES)[number];

export type RatingLabel = {
  label: string;
  description: string | null;
};

/**
 * Used until someone edits them in Settings, and whenever the settings read
 * fails. Deliberately plain, because nobody has told us what Tomco's A/B/C
 * actually mean — these are a starting point to be overwritten, not a claim.
 */
export const FALLBACK_RATING_LABELS: Record<RatingCode, RatingLabel> = {
  A: { label: "Preferred", description: "Bid everything they send. Pays on time, runs clean jobs." },
  B: { label: "Standard", description: "Bid selectively — normal terms, nothing unusual either way." },
  C: { label: "Caution", description: "Bid carefully. Slow payment, difficult sites, or thin margins." },
};

export function isRatingCode(v: string): v is RatingCode {
  return (RATING_CODES as readonly string[]).includes(v);
}
