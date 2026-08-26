/**
 * Sales-tax resolver (client-safe pure functions). Rates live in the DB
 * (commercial_tax_jurisdictions) — never hardcoded — so this only does the ZIP
 * → jurisdiction matching + rate/percent conversions.
 *
 * Rates are stored as THOUSANDTHS OF A PERCENT (8.625% = 8625) so common NY
 * combined rates keep full precision as integers with no float drift.
 */

export type TaxJurisdictionLite = {
  id: string;
  name: string;
  combined_rate_thou: number;
  zip_prefixes: string[];
  verified: boolean;
  active: boolean;
};

/** Thousandths-of-a-percent → percent (8625 → 8.625). */
export function thouToPct(thou: number): number {
  return Math.round(thou) / 1000;
}

// One definition, in lib/commercial/zip — see the note there. Re-exported so
// every existing `import { normalizeZip } from ".../tax/constants"` keeps
// working rather than being churned across the codebase.
import { normalizeZip } from "@/lib/commercial/zip";
export { normalizeZip };

/**
 * Resolve the tax jurisdiction for a ZIP via LONGEST-prefix match across active
 * jurisdictions (so a specific 5-digit ZIP entry beats a broad 3-digit prefix,
 * and NYC's '112' beats a hypothetical '11'). Returns null when nothing matches
 * — the invoice form then leaves the rate for manual entry.
 */
export function resolveTaxForZip(
  zip: string | null | undefined,
  jurisdictions: ReadonlyArray<TaxJurisdictionLite>
): { jurisdiction: TaxJurisdictionLite; rateThou: number } | null {
  const z = normalizeZip(zip);
  if (!z) return null;
  let best: { jurisdiction: TaxJurisdictionLite; prefixLen: number } | null = null;
  for (const j of jurisdictions) {
    if (!j.active) continue;
    for (const p of j.zip_prefixes) {
      const pref = (p ?? "").replace(/\D/g, "");
      if (pref && z.startsWith(pref) && (!best || pref.length > best.prefixLen)) {
        best = { jurisdiction: j, prefixLen: pref.length };
      }
    }
  }
  return best ? { jurisdiction: best.jurisdiction, rateThou: best.jurisdiction.combined_rate_thou } : null;
}
