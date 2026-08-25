/**
 * One shape for every way a room can get measured.
 *
 * The point of the tool is versatility: whoever is standing in front of the
 * problem should be able to answer it with whatever they have — a tape, a
 * phone camera, an address, or nothing but PPP's own history. Downstream
 * (the UI, the estimator, the supplier order) must not care which was used,
 * only how much to trust it.
 */

export type MeasureSource =
  /** Someone measured the room. */
  | "dimensions"
  /** A photo, read for scale against known objects. */
  | "photo"
  /** Whole-house square footage from property records, distributed. */
  | "address"
  /** Comparable rooms on PPP's past jobs. */
  | "history"
  /** Typed straight in, no dimensions. */
  | "manual";

/**
 * How much to trust it. This drives what the UI says and whether the vendor
 * email treats the number as a quantity or a starting point — a distributed
 * whole-house figure should never look as solid as a tape measurement.
 */
export type MeasureConfidence = "high" | "medium" | "low";

export type MeasureSuggestion = {
  source: MeasureSource;
  confidence: MeasureConfidence;
  /** Floor area. The value the estimator has always consumed. */
  sqft: number;
  /** Present when the source knows the shape, not just the area. */
  lengthFt?: number | null;
  widthFt?: number | null;
  ceilingFt?: number | null;
  /** Real perimeter, when derivable. Beats the square-room fallback. */
  perimeterLf?: number | null;
  /** One line a worker can sanity-check the number against. */
  rationale: string;
  /** Provider payload kept for auditing a number that later looks wrong. */
  detail?: Record<string, unknown>;
};

export const CONFIDENCE_LABEL: Record<MeasureConfidence, string> = {
  high: "Measured",
  medium: "Estimated",
  low: "Rough",
};

export const SOURCE_LABEL: Record<MeasureSource, string> = {
  dimensions: "Tape measurement",
  photo: "From a photo",
  address: "From property records",
  history: "From similar PPP jobs",
  manual: "Typed in",
};

/**
 * Whether a suggestion is solid enough to send a vendor a firm quantity.
 *
 * Low-confidence numbers still beat nothing — they turn "we don't know" into
 * "about this much" — but the order should keep asking the vendor to confirm,
 * because a distributed whole-house figure is a guess wearing a number.
 */
export function isFirmEnoughToOrder(c: MeasureConfidence): boolean {
  return c === "high" || c === "medium";
}
