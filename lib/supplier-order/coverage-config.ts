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
 */
export async function loadCoverageConfig(): Promise<CoverageConfig> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.warn("[coverage-config] Supabase env vars missing — using code defaults (admin coverage settings won't apply)");
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
      return COVERAGE_CONFIG;
    }
    if (!data) return COVERAGE_CONFIG; // no override row → defaults (normal, no warn)
    if (!data.config || typeof data.config !== "object") {
      console.warn("[coverage-config] stored row has no/invalid config — using code defaults");
      return COVERAGE_CONFIG;
    }
    return mergeCoverageConfig(data.config as Record<string, unknown>);
  } catch (err) {
    console.warn("[coverage-config] unexpected load error — using code defaults:", err instanceof Error ? err.message : String(err));
    return COVERAGE_CONFIG;
  }
}
