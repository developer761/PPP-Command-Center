import "server-only";
import { createClient } from "@supabase/supabase-js";
import { COVERAGE_CONFIG, type CoverageConfig } from "./estimate-gallons";
import { mergeCoverageConfig } from "./coverage-validation";

/** Re-export the pure validation helpers so callers keep importing from one
 *  module. The actual logic lives in `coverage-validation.ts` so it can be
 *  loaded by verify scripts that don't run in a Next runtime. */
export {
  isValidCoverageValue,
  mergeCoverageConfig,
  STRICT_POSITIVE_KEYS,
  MAX_COVERAGE_VALUES,
} from "./coverage-validation";

/**
 * Load the paint-coverage config, merging admin overrides (paint_coverage_config
 * row key='default') OVER the code defaults. Fail-safe: a missing table,
 * unreachable DB, junk value, or any error falls back to COVERAGE_CONFIG — the
 * calculator always has a valid config, so this never breaks an order.
 *
 * Every fallback path logs a console.warn so a misconfigured environment
 * surfaces in Vercel logs instead of silently shipping the wrong gallons.
 *
 * Only known numeric keys are accepted, and only finite values within the
 * STRICT_POSITIVE / MAX_COVERAGE_VALUES bounds — bufferPct allows 0 (no buffer)
 * so it's the one key where 0 is valid.
 *
 * PERF (2026-06-11): wrapped in a module-scope cache (5min TTL). Coverage
 * constants change rarely (admin tunes them maybe once a month). Every
 * supplier-order draft fetch + every materials page load called this →
 * repeated Supabase round-trips for the same data. Cache eliminates them
 * in the hot path. Safe to cache because misses fall through to code
 * defaults which are also static.
 */
let cachedConfig: { value: CoverageConfig; expiresAt: number } | null = null;
const COVERAGE_CACHE_MS = 5 * 60 * 1000;

export async function loadCoverageConfig(): Promise<CoverageConfig> {
  const now = Date.now();
  if (cachedConfig && cachedConfig.expiresAt > now) return cachedConfig.value;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.warn("[coverage-config] Supabase env vars missing — using code defaults (admin coverage settings won't apply)");
    cachedConfig = { value: COVERAGE_CONFIG, expiresAt: now + COVERAGE_CACHE_MS };
    return COVERAGE_CONFIG;
  }
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await sb
      .from("paint_coverage_config")
      .select("config")
      .eq("key", "default")
      .maybeSingle();
    if (error) {
      console.warn("[coverage-config] DB query failed — using code defaults:", error.message);
      cachedConfig = { value: COVERAGE_CONFIG, expiresAt: now + COVERAGE_CACHE_MS };
      return COVERAGE_CONFIG;
    }
    if (!data) {
      cachedConfig = { value: COVERAGE_CONFIG, expiresAt: now + COVERAGE_CACHE_MS };
      return COVERAGE_CONFIG; // no override row → defaults (normal, no warn)
    }
    if (!data.config || typeof data.config !== "object") {
      console.warn("[coverage-config] stored row has no/invalid config — using code defaults");
      cachedConfig = { value: COVERAGE_CONFIG, expiresAt: now + COVERAGE_CACHE_MS };
      return COVERAGE_CONFIG;
    }
    const merged = mergeCoverageConfig(data.config as Record<string, unknown>);
    cachedConfig = { value: merged, expiresAt: now + COVERAGE_CACHE_MS };
    return merged;
  } catch (err) {
    console.warn("[coverage-config] unexpected load error — using code defaults:", err instanceof Error ? err.message : String(err));
    cachedConfig = { value: COVERAGE_CONFIG, expiresAt: now + COVERAGE_CACHE_MS };
    return COVERAGE_CONFIG;
  }
}

/** Invalidate the module-scope cache. Call when admin updates the override
 *  via PUT /api/admin/coverage-config so the next loadCoverageConfig() call
 *  re-reads. Used by the admin route's PUT handler. */
export function invalidateCoverageConfigCache(): void {
  cachedConfig = null;
}
