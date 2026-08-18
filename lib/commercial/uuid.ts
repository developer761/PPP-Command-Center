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

// Strict 8-4-4-4-12 shape. The previous pattern matched any 36-char run of hex
// digits and dashes (even all-dashes), letting malformed ids reach Postgres as
// opaque cast errors. Real Supabase UUIDs are always canonical, so this only
// rejects junk. (2026-08 cleanup.)
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
