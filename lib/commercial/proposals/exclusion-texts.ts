import "server-only";

import { listExclusions } from "@/lib/commercial/exclusions/db";
import type { CommercialProposal } from "./db";

/**
 * Resolve a proposal's exclusion ids + custom lines into the ordered text list
 * the PDF renders.
 *
 * This existed twice already — once in the PDF download route, once in the
 * send-to-GC path — and filing the estimating report would have made three.
 * Three copies of "which exclusions print, in what order, capped at what
 * length" is three chances for the document a GC receives to differ from the
 * one we archived.
 *
 * `activeOnly: false` on purpose: deactivating a library exclusion is not
 * deleting it, and a proposal already carrying one must keep printing it.
 */
export async function resolveProposalExclusionTexts(
  proposal: Pick<CommercialProposal, "id" | "exclusion_ids" | "custom_exclusions">
): Promise<string[]> {
  let libraryTexts: string[] = [];
  if (proposal.exclusion_ids.length > 0) {
    const all = await listExclusions({ activeOnly: false });
    const byId = new Map(all.map((e) => [e.id, e.text] as const));
    // The proposal's own id order drives the sequence — not the library's.
    libraryTexts = proposal.exclusion_ids
      .map((id) => byId.get(id))
      .filter((t): t is string => Boolean(t && t.trim()));
    if (libraryTexts.length !== proposal.exclusion_ids.length) {
      console.warn(
        `[proposal-exclusions] proposal ${proposal.id} references ${proposal.exclusion_ids.length} exclusion ids but only ${libraryTexts.length} resolved — some may be soft-deleted.`
      );
    }
  }
  // Cap at render time as well as on save: the save action trims, but a direct
  // DB write could bypass it, and a 10KB blob would blow the PDF layout.
  const customTexts = (proposal.custom_exclusions ?? [])
    .filter((t) => t && t.trim())
    .map((t) => (t.length > 500 ? t.slice(0, 500) + "…" : t));
  // Custom lines print AFTER the library-resolved ones, in the order they were
  // added.
  return [...libraryTexts, ...customTexts];
}
