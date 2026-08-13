import { derivedOppName } from "@/lib/commercial/opportunities/db";

/**
 * What to call a job on screen.
 *
 * Stephanie 2026-08-13: *"Why am I not seeing the job name once it is
 * converted into a project? Only the GC and the address?"*
 *
 * Because `derivedOppName` recomposes "{account} - {client} - {street}" and
 * only falls back to the opportunity's own `title` when it can't build two
 * parts. Any job with a builder and an address therefore displays as the
 * builder and the address — and the name somebody actually typed disappears.
 *
 * Production data (checked, not assumed) shows titles come in two kinds:
 *
 *   Real names, typed by a person:
 *     "Motor Mindz, Babylon" · "Pacos Tacos" · "test title LMJ 123 Main"
 *   Auto-composed boilerplate from AutoOpportunityTitle:
 *     "08-13-2026 Karan Test 1 - Karan's Escape Room - 1500 Old Country Rd"
 *     "08-12-2026 DuCon Construction Co. Inc - DuCon Construction Co. Inc - 4 Henry Street"
 *
 * The first kind is exactly what Stephanie means by the job name, and it is
 * the thing being hidden. The second is noise: it already contains the builder
 * and the street, un-deduplicated, behind a date that means nothing to anyone
 * reading a project list. Showing THAT raw would be worse than today.
 *
 * So: a hand-typed title wins; an auto-composed one falls through to the
 * derived name, which at least dedupes "DuCon - DuCon".
 *
 * The marker is the date prefix, which AutoOpportunityTitle always writes
 * ("MM-DD-YYYY ..."). It is a heuristic, and deliberately a conservative one —
 * misreading a real name as boilerplate only returns today's behaviour, while
 * the reverse would put a date stamp on every project card.
 */

/** "08-13-2026" or "08-13-2026 Something - Else" — the auto-composed shape. */
const AUTO_COMPOSED = /^\d{2}-\d{2}-\d{4}(\s|$)/;

export function isAutoComposedTitle(title: string | null | undefined): boolean {
  return AUTO_COMPOSED.test((title ?? "").trim());
}

export function jobDisplayName(
  opp: {
    title?: string | null;
    title_override?: string | null;
    client_name?: string | null;
    property_street?: string | null;
  },
  accountName: string | null | undefined
): string {
  // Somebody typed an explicit display name. It always wins (Katie 2026-07-20).
  const override = opp.title_override?.trim();
  if (override) return override;

  const title = opp.title?.trim();
  if (title && !isAutoComposedTitle(title)) return title;

  const derived = derivedOppName(
    {
      title: opp.title ?? "",
      client_name: opp.client_name ?? null,
      property_street: opp.property_street,
      title_override: opp.title_override,
    },
    accountName
  );

  // derivedOppName's own last resort is `opp.title`, so a job created before
  // anything else was filled in comes back as the bare date it was stamped
  // with — "08-13-2026", which reads as a name and isn't one. (Found by a test
  // against a real production row, not imagined.) Say what is true instead:
  // this job has no name yet.
  if (!derived.trim() || isAutoComposedTitle(derived)) return "Untitled job";
  return derived;
}
