import "server-only";

import { commercialDb } from "./db";

/**
 * Read/write helpers for `commercial_settings` (global tunables).
 *
 * Seeded keys (per migration 019):
 *   - fiscal_year_start_month: number (1-12)
 *   - retainage_default_pct: number (e.g. 5)
 *   - invoice_number_prefix: string (e.g. "PPP-COM")
 *   - mvp_phase_target: string (e.g. "phase_0")
 *
 * Module-scope cache (1h TTL) keeps the hot-path lookup cheap. Admin writes
 * invalidate the cache so changes take effect on the next page load within
 * the same Vercel instance.
 */

const SETTINGS_CACHE_MS = 60 * 60 * 1000;
let cache: { value: Map<string, unknown>; expiresAt: number } | null = null;

async function loadAll(): Promise<Map<string, unknown>> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const sb = commercialDb();
  const { data, error } = await sb.from("commercial_settings").select("key, value");
  if (error) {
    console.warn("[commercial/settings] load failed:", error.message);
    return new Map(); // empty map — callers fall through to defaults
  }

  const m = new Map<string, unknown>();
  for (const row of data ?? []) {
    m.set(row.key as string, row.value);
  }
  cache = { value: m, expiresAt: now + SETTINGS_CACHE_MS };
  return m;
}

/** Read a setting, returning the default when not set. */
export async function getCommercialSetting<T>(key: string, defaultValue: T): Promise<T> {
  const all = await loadAll();
  return (all.get(key) as T) ?? defaultValue;
}

/** Write a setting (admin-only at the route layer; this fn doesn't gate). */
export async function setCommercialSetting(key: string, value: unknown, userId?: string | null): Promise<void> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_settings")
    .upsert(
      { key, value, updated_at: new Date().toISOString(), updated_by_user_id: userId ?? null },
      { onConflict: "key" }
    );
  if (error) {
    console.warn("[commercial/settings] write failed:", error.message);
    throw new Error(error.message);
  }
  cache = null;
}

export function invalidateCommercialSettingsCache(): void {
  cache = null;
}
