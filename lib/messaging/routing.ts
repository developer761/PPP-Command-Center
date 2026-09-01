/**
 * Which workspace does a lead belong to?
 *
 * Pure. No database, no Salesforce — the caller passes the workspaces and the
 * lead. Every branch is testable, and the rules are inspectable rather than
 * buried in a query.
 *
 * PPP segments workspaces three ways at once, which is why this is not a
 * lookup table:
 *   region + service area   NY LI Nassau Leads, CO Denver Leads
 *   lead source / channel   NY LI Meta, Google LSA, Thumbtack
 *   AM- prefix              a separate account-management surface
 *
 * A Meta lead in Nassau could match "NY LI Nassau Leads" on region and
 * "NY LI Meta" on source. Source wins, because that is how PPP has arranged
 * them: the Meta workspaces exist precisely so Meta traffic is separable.
 */

export type RoutableWorkspace = {
  id: string;
  name: string;
  is_active: boolean;
  phone_e164: string | null;
};

export type RoutableLead = {
  /** Salesforce LeadSource, verbatim. */
  source: string | null;
  /** Two-letter state, when known. */
  state: string | null;
  /** Free-text city or county, when known. */
  locality: string | null;
};

export type RoutingResult =
  | { ok: true; workspaceId: string; workspaceName: string; why: string }
  | { ok: false; reason: "no_match" | "matched_inactive" | "matched_no_number"; detail: string };

/** Source patterns → the workspace-name fragment PPP uses for that channel. */
const SOURCE_CHANNEL: { match: RegExp; fragment: string; label: string }[] = [
  { match: /meta|facebook|instagram|fb\b/i, fragment: "Meta", label: "Meta" },
  { match: /google\s*lsa|local\s*services/i, fragment: "Google LSA", label: "Google LSA" },
  { match: /thumbtack/i, fragment: "Thumbtack", label: "Thumbtack" },
];

/** State → the region fragments PPP uses in workspace names, most specific first. */
const STATE_REGION: Record<string, string[]> = {
  NY: ["NY LI Nassau", "NY LI Suffolk", "NY Queens", "NY Wstch", "NY NYC", "NY LI", "NY"],
  NJ: ["NJ"],
  FL: ["FL Broward", "FL Miami", "SoFlo", "FL"],
  CT: ["WC CT", "CT"],
  CA: ["CA LA", "CA San Diego", "CA"],
  CO: ["CO Denver", "CO"],
};

/** Locality → the most specific region fragment it implies. */
const LOCALITY_REGION: { match: RegExp; fragment: string }[] = [
  { match: /nassau|garden city|hempstead|mineola|hicksville|levittown/i, fragment: "NY LI Nassau" },
  { match: /suffolk|sayville|huntington|islip|babylon|patchogue/i, fragment: "NY LI Suffolk" },
  { match: /queens|astoria|flushing|jamaica/i, fragment: "NY Queens" },
  { match: /westchester|yonkers|white plains|new rochelle/i, fragment: "NY Wstch" },
  { match: /manhattan|brooklyn|bronx|new york city|nyc/i, fragment: "NY NYC" },
  { match: /broward|fort lauderdale|plantation|pompano/i, fragment: "FL Broward" },
  { match: /miami|coral gables|hialeah/i, fragment: "FL Miami" },
];

export function routeLead(lead: RoutableLead, workspaces: RoutableWorkspace[]): RoutingResult {
  const channel = SOURCE_CHANNEL.find((c) => c.match.test(lead.source ?? ""));

  // Most specific region fragment we can justify: locality beats state.
  const localityFrag = LOCALITY_REGION.find((l) => l.match.test(lead.locality ?? ""))?.fragment;
  const stateFrags = STATE_REGION[(lead.state ?? "").toUpperCase()] ?? [];
  const regionFrags = [localityFrag, ...stateFrags].filter(Boolean) as string[];

  const byName = (frag: string, alsoChannel?: string) =>
    workspaces.filter((w) =>
      w.name.toLowerCase().includes(frag.toLowerCase()) &&
      (alsoChannel ? w.name.toLowerCase().includes(alsoChannel.toLowerCase()) : true));

  const candidates: { ws: RoutableWorkspace; why: string }[] = [];

  // 1. Channel AND region, e.g. a Meta lead in Nassau -> "NY LI Meta".
  if (channel) {
    for (const frag of regionFrags) {
      for (const w of byName(frag, channel.fragment)) {
        candidates.push({ ws: w, why: `${channel.label} lead in ${frag}` });
      }
    }
    // 2. Channel alone. Google LSA and Thumbtack are national workspaces with
    //    no region in the name at all.
    for (const w of byName(channel.fragment)) {
      if (!candidates.some((c) => c.ws.id === w.id)) {
        candidates.push({ ws: w, why: `${channel.label} lead, no regional ${channel.label} workspace` });
      }
    }
  }

  // 3. Region alone. Deliberately excludes AM- workspaces: those are account
  //    management, a different job from a new lead, and routing a lead there
  //    puts it in front of the wrong team.
  for (const frag of regionFrags) {
    for (const w of byName(frag)) {
      if (w.name.startsWith("AM - ")) continue;
      if (SOURCE_CHANNEL.some((c) => w.name.toLowerCase().includes(c.fragment.toLowerCase()))) continue;
      if (!candidates.some((c) => c.ws.id === w.id)) {
        candidates.push({ ws: w, why: `region ${frag}` });
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: "no_match", detail: `source=${lead.source ?? "—"} state=${lead.state ?? "—"} locality=${lead.locality ?? "—"}` };
  }

  const live = candidates.find((c) => c.ws.is_active && c.ws.phone_e164);
  if (live) return { ok: true, workspaceId: live.ws.id, workspaceName: live.ws.name, why: live.why };

  // Matched something, but it cannot send. Say WHICH problem it is: a region
  // not yet switched on is a rollout decision, a workspace with no number is a
  // data gap, and they need different people to fix them.
  const inactive = candidates.find((c) => !c.ws.is_active);
  if (inactive) {
    return { ok: false, reason: "matched_inactive", detail: `${inactive.ws.name} is not switched on yet` };
  }
  return { ok: false, reason: "matched_no_number", detail: `${candidates[0].ws.name} has no phone number` };
}
