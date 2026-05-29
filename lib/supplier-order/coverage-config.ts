import "server-only";
import { createClient } from "@supabase/supabase-js";
import { COVERAGE_CONFIG, type CoverageConfig } from "./estimate-gallons";

/**
 * Load the paint-coverage config, merging admin overrides (paint_coverage_config
 * row key='default') OVER the code defaults. Fail-safe: a missing table,
 * unreachable DB, junk value, or any error falls back to COVERAGE_CONFIG — the
 * calculator always has a valid config, so this never breaks an order.
 *
 * Only known numeric keys are accepted, and only finite, positive values (a
 * stored 0 / negative / NaN is ignored in favor of the default) — bufferPct
 * allows 0 (no buffer) so it's the one key where 0 is valid.
 */
export async function loadCoverageConfig(): Promise<CoverageConfig> {
  try {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return COVERAGE_CONFIG;
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
    if (error || !data?.config || typeof data.config !== "object") return COVERAGE_CONFIG;
    return mergeCoverageConfig(data.config as Record<string, unknown>);
  } catch {
    return COVERAGE_CONFIG;
  }
}

/** Keys that MUST be > 0 (0 would divide-by-zero, infinite-loop, or mean "no
 *  paint"). Everything else (buffer, opening counts, deductions, casings,
 *  height) may legitimately be 0. */
export const STRICT_POSITIVE_KEYS = new Set<string>([
  "coverageSqftPerGallon",
  "bucketSizeGallons",
  "bucketThresholdGallons",
  "defaultCoats",
]);

/** Is a value valid for a given config key? */
export function isValidCoverageValue(key: string, v: number): boolean {
  if (!Number.isFinite(v)) return false;
  return STRICT_POSITIVE_KEYS.has(key) ? v > 0 : v >= 0;
}

/** Merge a partial override object over the code defaults (pure — also used by
 *  the API to validate + echo back the effective config). */
export function mergeCoverageConfig(override: Record<string, unknown>): CoverageConfig {
  const merged: Record<string, number> = { ...COVERAGE_CONFIG };
  for (const key of Object.keys(COVERAGE_CONFIG) as Array<keyof CoverageConfig>) {
    const v = override[key as string];
    if (typeof v === "number" && isValidCoverageValue(key as string, v)) merged[key as string] = v;
  }
  return merged as unknown as CoverageConfig;
}
