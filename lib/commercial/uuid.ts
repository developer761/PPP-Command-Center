/**
 * Shared UUID regex + helpers for the Commercial Command Center.
 *
 * Every server action that pulls an id out of formData should validate
 * it against UUID_RE before reaching the lib — malformed values must
 * fail fast (and not propagate to Postgres as opaque error strings).
 * Every dynamic [id] route does the same on the path segment.
 *
 * Extracted from app/commercial/accounts pages 2026-06-15 so Phase 2
 * (opportunities) can import the same constant.
 */

export const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Convenience predicate — slightly nicer to read in conditionals. */
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
