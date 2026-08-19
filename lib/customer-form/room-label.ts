/**
 * The room name for a work-order line item (R4.20).
 *
 * `AreaLabel__c` is the intended home for it, but on real work orders it is
 * often simply empty — WO 00306643 has all three line items with a null
 * AreaLabel__c, so every screen read "Untitled Area" three times and nobody
 * could tell the rooms apart.
 *
 * The names do exist; they're in `ProductName__c`, which PPP formats as
 * `{Family}: {Product}: {AreaLabel}`:
 *
 *     "Interior Painting: Living Room: Living Room"  → "Living Room"
 *     "Interior Painting: Bathroom"                  → "Bathroom"
 *
 * So the last non-empty colon-separated segment is the room. Kate confirmed
 * that reading, and both two- and three-segment forms occur in production.
 *
 * One guard: when the last segment is just the product family repeated
 * ("Interior Painting"), it isn't a room name — that's the shape of a line item
 * that genuinely has no area, and inventing "Interior Painting" as a room would
 * be worse than admitting we don't know.
 */

/** Families that are scope descriptions, never room names. */
const FAMILY_WORDS = /^(interior|exterior)\s+painting$/i;

export function roomLabelFrom(
  areaLabel: string | null | undefined,
  productName: string | null | undefined,
  fallback = "Untitled area"
): string {
  const area = (areaLabel ?? "").trim();
  if (area) return area;

  const segments = (productName ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    // Skip the family, whether it's the only segment or a trailing repeat.
    if (FAMILY_WORDS.test(seg)) continue;
    return seg;
  }
  return fallback;
}
