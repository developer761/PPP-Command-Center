import { UUID_RE } from "./uuid";

/**
 * Shared search-param + form-data helpers for Commercial CC pages.
 *
 * `pickFirst` handles Next.js' string | string[] | undefined searchParams
 * shape. `pickSelectedUuids` extracts a bulk-action UUID list from
 * formData with hard-cap + per-value validation.
 */

/** Reduce Next.js' searchParams entry to a single string (or undefined).
 *  Arrays collapse to the first element — the URL spec allows repeated
 *  keys but our pages never write them, so first-wins is safe. */
export function pickFirst(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

/** Extract a list of UUIDs from formData.getAll(field). Drops any
 *  value that isn't a valid UUID + caps at `max` so a runaway request
 *  can't lock the DB. Used by bulk-action server actions. */
export function pickSelectedUuids(
  formData: FormData,
  field: string,
  max: number
): string[] {
  const raw = formData.getAll(field);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    if (!UUID_RE.test(v)) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
