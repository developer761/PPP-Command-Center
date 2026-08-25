import "server-only";

import type { MeasureSuggestion } from "@/lib/measure/types";

/**
 * What PPP's own past jobs say a room like this measures.
 *
 * This is the source that gets better every time the crew uses the tool, and
 * it costs the worker nothing — it's already there when the page opens.
 *
 * A CAVEAT MEASURED, NOT ASSUMED. I checked the real distribution on 2026-08-25
 * before building this: across filled line items, room labels are largely
 * junk fragments ("main", "nd floor", "st floor" — truncated), and the spread
 * within a label is enormous. "main" has a median of 120 sqft with a p25 of 84
 * and a p75 of 192 — a 2× range inside one name.
 *
 * So a history median is NOT a measurement, and this reports low confidence and
 * shows the range rather than a lone number. Its honest job is to stop a worker
 * staring at an empty box: "past jobs like this ran 84–192, usually about 120"
 * is a starting point they can adjust in seconds.
 *
 * It gets sharper as `wo_li_sqft_overrides` fills with real tape measurements,
 * because those carry clean labels and a known source.
 */

export type HistorySample = { sqft: number; label: string };

/** Strip the noise PPP's area labels carry so "Master Bed 2" and "master
 *  bedroom" land in the same bucket. */
export function normaliseRoomLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The room TYPE, which is what actually predicts size — the specific name
 *  ("Dave's office") does not generalise, "office" does.
 *
 *  Matched as word PREFIXES, not whole words. PPP writes "Bathroom" and
 *  "Bedroom" as single words, and `\bbath\b` does not match "bathroom" — the
 *  boundary fails mid-word. That silently typed every bathroom as unknown,
 *  which is exactly the kind of miss that makes a feature look like it just
 *  doesn't work. */
const TYPES: Array<{ key: string; match: RegExp }> = [
  { key: "bathroom", match: /\b(bath|powder|wc|ensuite)/ },
  { key: "kitchen", match: /\bkitchen/ },
  { key: "dining", match: /\bdining/ },
  { key: "living", match: /\b(living|family|great|lounge|den)\b/ },
  { key: "master", match: /\b(master|primary)/ },
  { key: "bedroom", match: /\b(bed|bdrm|guest|nursery)/ },
  { key: "office", match: /\b(office|study)/ },
  { key: "hall", match: /\b(hall|stair|entry|foyer|landing|corridor)/ },
  { key: "closet", match: /\b(closet|pantry|wardrobe)/ },
  { key: "laundry", match: /\b(laundry|mud|utility)/ },
  { key: "basement", match: /\b(basement|cellar|lower)/ },
  { key: "garage", match: /\bgarage/ },
];

export function roomType(label: string): string | null {
  const n = normaliseRoomLabel(label);
  for (const t of TYPES) if (t.match.test(n)) return t.key;
  return null;
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * Build a suggestion from comparable rooms.
 *
 * Requires a real sample. Two past bathrooms is not evidence, and offering a
 * number off two rows would teach the crew the tool guesses — after which they
 * stop trusting the good sources too.
 */
export const MIN_SAMPLES = 6;

export function suggestFromHistory(
  roomLabel: string,
  samples: HistorySample[]
): MeasureSuggestion | null {
  const type = roomType(roomLabel);
  if (!type) return null;

  const matching = samples
    .filter((s) => roomType(s.label) === type)
    .map((s) => s.sqft)
    .filter((n) => Number.isFinite(n) && n > 0 && n < 5000);

  if (matching.length < MIN_SAMPLES) return null;

  const sorted = [...matching].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);

  return {
    source: "history",
    // Never above low: the measured spread inside a single room type is ~2×.
    confidence: "low",
    sqft: Math.round(median),
    rationale: `${matching.length} past ${type} rooms ran ${p25}–${p75} sq ft, usually about ${Math.round(median)}. Adjust if this one looks different.`,
    detail: { type, sampleCount: matching.length, p25, median, p75 },
  };
}
