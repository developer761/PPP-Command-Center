import { derivedOppName } from "@/lib/commercial/opportunities/db";

/**
 * The PROJECT line on a proposal.
 *
 * Stephanie 2026-08-13: *"Proposals autofills the GC/Builders name, not the
 * opportunity/project name. The proposal follows the opportunity."*
 *
 * The old order fell through to `derivedOppName`, which composes
 * "{account} - {client} - {street}" — so PROJECT opened with the builder's
 * name. That is redundant as well as wrong: the builder is already printed
 * directly above it as `gc_company`. PROJECT means the job, so it reads client
 * and address, and the GC appears exactly once on the page.
 *
 * Lives outside `hydrate.ts` (which is `server-only`) so the rule can be
 * tested directly — it decides what a customer sees on every proposal PDF,
 * which is too much to leave uncovered.
 */
export function proposalProjectName(
  opp: {
    title?: string | null;
    title_override?: string | null;
    client_name?: string | null;
    property_street?: string | null;
  },
  accountName: string | null | undefined
): string {
  // 1. Someone typed an explicit name. It always wins, everywhere.
  const override = opp.title_override?.trim();
  if (override) return override;

  // 2. The job itself: who it's for, and where.
  const jobParts = [opp.client_name?.trim(), opp.property_street?.trim()].filter(
    (p): p is string => Boolean(p)
  );
  if (jobParts.length > 0) return jobParts.join(" - ");

  // 3. Last resort, so a bare deal still prints something rather than blank.
  return derivedOppName(
    { title: opp.title ?? "", client_name: opp.client_name ?? null, property_street: opp.property_street, title_override: opp.title_override },
    accountName
  );
}
