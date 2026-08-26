/**
 * What counts as a ZIP code, for the whole Commercial platform.
 *
 * One definition on purpose. This lived in two places — `tax/constants` and
 * `teams/zip-territory` — with byte-identical bodies and separate comments, and
 * those two are the ONLY consumers that matter: one decides what sales tax a
 * job carries, the other decides which crew executes it. Both key off the same
 * address. Two copies meant a single edit to either could route the same job to
 * the right tax and the wrong team, and nothing would have flagged it.
 *
 * Client-safe: pure, no imports, no I/O.
 */

/** Normalize a raw ZIP to its 5-digit base ("11201-1234" → "11201").
 *  Null for anything that isn't a usable US ZIP. */
export function normalizeZip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}
