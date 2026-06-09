import { COVERAGE_CONFIG, type CoverageConfig } from "./estimate-gallons";

/**
 * Pure validation + merge helpers for the paint-coverage config. No I/O, no
 * `server-only`, so verify scripts + the admin API + the loader can all share
 * a single source of truth for what counts as a valid config value.
 */

/** Keys that MUST be > 0 (0 would divide-by-zero, infinite-loop, or mean "no
 *  paint"). Everything else (buffer, opening counts, deductions, casings,
 *  height) may legitimately be 0. */
export const STRICT_POSITIVE_KEYS = new Set<string>([
  "coverageSqftPerGallon",
  "bucketSizeGallons",
  "bucketThresholdGallons",
  "defaultCoats",
]);

/** Upper-bound sanity caps. Stops a typo (1000 buffer → 11× order, 999 coats,
 *  etc.) from shipping insane gallons. Tuned to be permissive — any realistic
 *  PPP setting fits comfortably under these. Keys not listed have no cap. */
export const MAX_COVERAGE_VALUES: Record<string, number> = {
  bufferPct: 1.0,                  // 100% buffer max (display 100). Realistic is 5-20%.
  coverageSqftPerGallon: 1000,     // realistic 200-600.
  defaultCoats: 10,                // realistic 1-3.
  defaultHeightFt: 30,             // 30 ft ceilings are atriums; anything higher is a typo.
  defaultDoorsPerRoom: 20,
  defaultWindowsPerRoom: 20,
  defaultClosetsPerRoom: 20,
  deductDoorSqft: 200,
  deductWindowSqft: 200,
  deductClosetSqft: 200,
  casingDoorLf: 100,
  casingWindowLf: 100,
  casingClosetLf: 100,
  trimWidthFt: 5,
  doorFaceSqft: 200,
  bucketSizeGallons: 100,
  bucketThresholdGallons: 100,
};

/** Is a value valid for a given config key? */
export function isValidCoverageValue(key: string, v: number): boolean {
  if (!Number.isFinite(v)) return false;
  const minOk = STRICT_POSITIVE_KEYS.has(key) ? v > 0 : v >= 0;
  if (!minOk) return false;
  const max = MAX_COVERAGE_VALUES[key];
  if (max !== undefined && v > max) return false;
  return true;
}

/** Merge a partial override object over the code defaults (pure — also used by
 *  the API to validate + echo back the effective config). */
export function mergeCoverageConfig(override: Record<string, unknown>): CoverageConfig {
  const merged: Record<string, number> = { ...COVERAGE_CONFIG };
  for (const key of Object.keys(COVERAGE_CONFIG) as Array<keyof CoverageConfig>) {
    const v = override[key as string];
    if (typeof v === "number" && isValidCoverageValue(key as string, v)) merged[key as string] = v;
  }
  // Double-cast defeats the `as const` layer on CoverageConfig — each key
  // there has a literal-number type. Runtime shape is correct (we spread
  // the full default in + only overwrite known keys with validated numbers).
  return merged as unknown as CoverageConfig;
}
