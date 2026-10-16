import type { ExclusionKind } from "@/lib/commercial/exclusions/constants";

/** A resolved line plus which PDF section it belongs under (migration 164). */
export type ResolvedExclusion = { text: string; kind: ExclusionKind };

/** The comparison key: case, spacing and a trailing full stop do not make a
 *  line a different line. */
function exclusionKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.;,]+$/, "");
}

/**
 * Library lines first, then custom lines, each printed ONCE.
 *
 * A proposal can carry the same sentence twice — ticked from the library and
 * pasted into the custom box, or pasted twice. Measured: 1 of 26 live
 * proposals printed "Sales Tax, unless applicable." twice in its Exclusions,
 * which reads to a GC as a document nobody proofread. The first occurrence
 * wins, so a library line keeps its section (exclusion vs qualification) and
 * its position; the later copy is dropped.
 */
export function mergeProposalExclusions(
  library: ResolvedExclusion[],
  custom: ResolvedExclusion[]
): ResolvedExclusion[] {
  const seen = new Set<string>();
  const out: ResolvedExclusion[] = [];
  for (const e of [...library, ...custom]) {
    const k = exclusionKey(e.text);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
