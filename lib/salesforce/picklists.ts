import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Which values a Salesforce picklist will actually accept, read from the org.
 *
 * WHY THIS EXISTS (2026-09-10). `WorkOrderLineItem.Finish*__c` are RESTRICTED
 * picklists, so a value the org does not hold is REJECTED — the write fails,
 * it is not coerced. Our app-label → SF-value mapping is a hardcoded switch,
 * which leaves two bad options whenever the vocabulary grows:
 *
 *   · map a value before the admin adds it  → every write with it fails
 *   · wait, and hardcode after              → the admin's work does nothing
 *     until a developer notices and deploys
 *
 * Katie is adding Velvet, High-Gloss and the five stain opacities right now.
 * Asking the org removes the coordination entirely: each value starts saving
 * the moment it exists, with no deploy, and until then the caller records it
 * in the notes instead of failing the write.
 *
 * Cached per instance — schema does not change at runtime, and a describe is a
 * ~300-500ms round trip that would otherwise sit on every form submission.
 */
const TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { values: Set<string>; expiresAt: number }>();

export function clearPicklistCache(): void {
  cache.clear();
}

/**
 * Active values for one picklist field, lower-cased for comparison alongside
 * the original spelling. Returns null when the org cannot be reached — callers
 * must treat that as "unknown", NOT as "empty", or a transient outage would
 * silently stop writing every finish.
 */
export async function activePicklistValues(
  sobject: string,
  field: string
): Promise<Set<string> | null> {
  const key = `${sobject}.${field}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.values;

  try {
    const conn = await getSalesforceClient();
    const desc = await conn.sobject(sobject).describe();
    const f = desc.fields.find((x) => x.name.toLowerCase() === field.toLowerCase());
    if (!f?.picklistValues?.length) return null;
    const values = new Set(
      f.picklistValues.filter((v) => v.active).map((v) => String(v.value))
    );
    cache.set(key, { values, expiresAt: Date.now() + TTL_MS });
    return values;
  } catch (err) {
    console.warn(`[SF] could not read ${key} picklist: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The value to write for a finish, or null to leave the field alone.
 *
 * `mapped` is the hardcoded translation (Semi-Gloss → "Semigloss"); `label` is
 * what the person picked. A value the org holds under its own name — every one
 * Katie is adding — needs no translation at all.
 */
export function resolveFinishValue(
  label: string | null | undefined,
  mapped: string | null,
  allowed: Set<string> | null
): string | null {
  const raw = (label ?? "").trim();
  if (!raw) return null;
  // Org unreachable: trust the hardcoded mapping only. Never guess a value
  // into a restricted picklist on the strength of a failed lookup.
  if (!allowed) return mapped;
  if (mapped && allowed.has(mapped)) return mapped;
  const exact = [...allowed].find((v) => v.toLowerCase() === raw.toLowerCase());
  return exact ?? null;
}
