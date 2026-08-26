/**
 * Which team covers this address?
 *
 * Brendan 2026-08-25: *"the location of the job will determine the team who
 * will execute the project."*
 *
 * Deliberately the same shape as `resolveTaxForZip` — longest-prefix match over
 * a `zip_prefixes` array. That function already answers "which thing owns this
 * address", Katie already maintains its data, and having two zip mechanisms
 * that behave differently would mean two mental models for one question.
 *
 * Pure and client-safe: no database, no server-only import, so the same
 * function decides the default on the server and can preview it in a form.
 */

export type TeamTerritory = {
  id: string;
  name: string;
  /** e.g. ["117", "11722"]. Empty means the team covers no territory. */
  zip_prefixes: string[];
  /** Tie-break: the older team wins, so the answer is stable rather than
   *  whichever row the database happened to return first. */
  created_at?: string | null;
};

// The SAME definition the sales-tax resolver uses. Both decide something about
// a job from its address, so they must agree on what the address is.
import { normalizeZip } from "@/lib/commercial/zip";
export { normalizeZip };

/**
 * The team whose territory best covers `zip`, or null.
 *
 * LONGEST PREFIX WINS: "11722" beats "117", so one town can belong to a
 * different crew than the county around it. Overlap is allowed on purpose —
 * Salesforce's one-owner-per-zip rule is the thing Mac named as breaking on new
 * hires, and refusing overlap here would rebuild that limitation.
 *
 * Returns `runnersUp` so the UI can say "Coastal Crew also covers 117" instead
 * of silently picking one. A person who can see the ambiguity can resolve it;
 * a silent winner is how the wrong crew ends up on a job.
 */
export function resolveTeamForZip(
  zip: string | null | undefined,
  teams: ReadonlyArray<TeamTerritory>
): { team: TeamTerritory; matchedPrefix: string; runnersUp: TeamTerritory[] } | null {
  const z = normalizeZip(zip);
  if (!z) return null;

  const matches: Array<{ team: TeamTerritory; prefix: string }> = [];
  for (const t of teams) {
    let longest = "";
    for (const raw of t.zip_prefixes ?? []) {
      const pref = (raw ?? "").replace(/\D/g, "");
      if (pref && z.startsWith(pref) && pref.length > longest.length) longest = pref;
    }
    if (longest) matches.push({ team: t, prefix: longest });
  }
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (b.prefix.length !== a.prefix.length) return b.prefix.length - a.prefix.length;
    // Same specificity → oldest team wins. Any stable rule beats an arbitrary
    // one; "whoever had the territory first" is the one a person can predict.
    return (a.team.created_at ?? "").localeCompare(b.team.created_at ?? "");
  });

  const [best, ...rest] = matches;
  return {
    team: best.team,
    matchedPrefix: best.prefix,
    // Only genuine ambiguity — a team matching a SHORTER prefix is not a rival,
    // it is the broader territory this one sits inside.
    runnersUp: rest.filter((m) => m.prefix.length === best.prefix.length).map((m) => m.team),
  };
}

/** Split a textarea/comma list into clean prefixes. "117, 11722 " → ["117","11722"] */
export function parseZipPrefixes(raw: string): string[] {
  return [...new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => s.replace(/\D/g, ""))
      // A prefix longer than a zip cannot match anything; 1 digit covers a
      // tenth of the country and is never what someone meant.
      .filter((s) => s.length >= 2 && s.length <= 5)
  )];
}
