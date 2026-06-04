/**
 * NYC 5-borough ZIP code ranges — used by the supplier-order modal to
 * default fulfillment to "pickup" for delivery addresses inside NYC.
 *
 * Confirmed by Katie 2026-06-04: "5 boroughs only." Westchester / LIC outside
 * the official borough boundaries / Yonkers don't get the default. Admin can
 * still toggle to delivery on any order — this is a SUGGESTION, not a lock.
 *
 * Source: USPS ZIP code assignments + cross-checked against
 * https://zipcode-data.com/blog/nyc-zip-codes-guide (2025 snapshot).
 *
 * Ranges intentionally cover small gaps (e.g. Manhattan 10001-10292 includes
 * unassigned slivers like 10260s; those zips just never match anyway).
 * Better to slightly over-include than miss real NYC zips.
 */

type ZipRange = readonly [min: number, max: number];

export const NYC_ZIP_RANGES: readonly ZipRange[] = [
  // Manhattan
  [10001, 10292],
  // Staten Island
  [10301, 10314],
  // Bronx
  [10451, 10475],
  // Queens (split across 4 non-contiguous chunks)
  [11004, 11005],
  [11101, 11120],
  [11351, 11697],
  // Brooklyn
  [11201, 11239],
];

/** True when the given postal code (in any common format) falls inside an
 *  NYC 5-borough ZIP range.
 *
 *  Accepts:
 *    "10001"      → true (Manhattan)
 *    "10001-1234" → true (ZIP+4 — strips suffix)
 *    "10001 1234" → true (non-standard separator)
 *    " 10001 "    → true (whitespace tolerated)
 *    "K1A 0B1"    → false (Canadian postal code)
 *    "abc"        → false
 *    null/""      → false
 *    "11200"      → false (between Bronx + Brooklyn ranges)
 */
export function isNycZip(zip: string | null | undefined): boolean {
  if (!zip) return false;
  // Match the FIRST 5 digit run anywhere in the string. Tolerates ZIP+4
  // (`11201-1234`), space-separated (`11201 1234`), surrounding whitespace.
  // Rejects strictly-non-numeric inputs like Canadian K1A or UK postcodes.
  const m = String(zip).trim().match(/^(\d{5})\b/);
  if (!m) return false;
  const z = parseInt(m[1], 10);
  return NYC_ZIP_RANGES.some(([min, max]) => z >= min && z <= max);
}

/** True when the delivery address (with its postalCode field) is in NYC. */
export function isNycAddress(address: { postalCode?: string | null } | null | undefined): boolean {
  if (!address) return false;
  return isNycZip(address.postalCode);
}
