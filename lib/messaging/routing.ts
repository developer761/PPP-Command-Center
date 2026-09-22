import type { TerritoryVerdict } from "./territory";

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
  /**
   * The service territory this lead's ZIP resolves to, already looked up
   * against PPP's own Zip_Code__c map — see territory.ts.
   *
   * THE PRIMARY SIGNAL, and present on 99.5% of real leads. Everything below
   * it is a fallback for the half-percent, and a deliberately timid one.
   */
  territory?: TerritoryVerdict | null;
};

export type RoutingResult =
  | { ok: true; workspaceId: string; workspaceName: string; why: string }
  | {
      ok: false;
      reason: "no_match" | "matched_inactive" | "matched_no_number" | "not_serviced" | "ambiguous_region";
      detail: string;
    };

/** Source patterns → the workspace-name fragment PPP uses for that channel. */
const SOURCE_CHANNEL: { match: RegExp; fragment: string; label: string }[] = [
  { match: /meta|facebook|instagram|fb\b/i, fragment: "Meta", label: "Meta" },
  { match: /google\s*lsa|local\s*services/i, fragment: "Google LSA", label: "Google LSA" },
  { match: /thumbtack/i, fragment: "Thumbtack", label: "Thumbtack" },
];

/**
 * States where ONE workspace covers the whole state, so the state alone is
 * enough to route on.
 *
 * NY, FL and CA are deliberately absent. Each is split across several
 * workspaces, and a state-only match there is a coin toss dressed up as a
 * decision — the old code listed their sub-regions "most specific first" and
 * then, with no locality to go on, took the first one. Every unrecognised NY
 * city went to Nassau, including the Suffolk ones. A lead we cannot place
 * inside a split state goes to a person now.
 */
const WHOLE_STATE_REGION: Record<string, string> = {
  NJ: "NJ",
  CT: "CT",
  CO: "CO",
};

/** States split across several workspaces: never routed on the state alone. */
const SPLIT_STATES = new Set(["NY", "FL", "CA"]);

/**
 * A region fragment → the COARSER fragment its channel workspaces use.
 *
 * PPP's Meta workspaces are cut broader than its lead workspaces: Nassau and
 * Suffolk share "NY LI Meta", and Broward and Miami share "SoFlo Meta". So a
 * Meta lead in Fort Lauderdale needs "SoFlo", not "FL Broward", to find its
 * workspace.
 *
 * The old code got this by accident — "SoFlo" happened to sit in the list of
 * NY/FL state fragments it walked. Removing that list to stop the Nassau
 * guessing took this with it, and a Fort Lauderdale Meta lead started landing
 * on NY LI Meta. Stated explicitly now, so it cannot be lost the same way.
 *
 * A region with no entry has no channel workspace, and that is fine: the lead
 * falls through to its regional LEADS workspace, which is the right team and
 * the right area code. Losing the channel split is a reporting cost; texting
 * from another state's number is a customer-facing one.
 */
const CHANNEL_REGION: Record<string, string> = {
  "NY LI Nassau": "NY LI",
  "NY LI Suffolk": "NY LI",
  "NY NYC": "NYC",
  "NY Queens": "NYC",
  "NJ": "NJ",
  "FL Broward": "SoFlo",
  "FL Miami": "SoFlo",
  "CA LA": "CA",
  "CA San Diego": "CA",
  // NY Wstch, CT and CO Denver have no channel workspace. Deliberately absent.
};

/**
 * Locality → the most specific region fragment it implies.
 *
 * A FALLBACK NOW, not the mechanism. The zip map in territory.ts answers
 * 99.5% of real leads; this catches the rest, and only where the name is
 * unambiguous. It is not worth extending: the answer to "which of these forty
 * Long Island towns is Suffolk" already exists in Salesforce as 2,194 curated
 * rows, and a second hand-maintained copy of it here would drift from the
 * first the week after somebody edited one.
 */
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

  // NOT SERVICED IS AN ANSWER, and it comes before everything.
  //
  // Kate's rule A2: a zip outside NJ/CA/CT/FL/NY/CO, or one whose territory is
  // inactive or named "Out of Area", is not bookable — a person checks with
  // the estimator rather than the bot promising coverage. Routing it anywhere
  // means texting somebody we cannot send an estimator to.
  //
  // This also catches an ACTIVE territory with no workspace, which is a real
  // case today: CA Orange has 87 zips and nobody here covers it.
  if (lead.territory && !lead.territory.serviced) {
    return { ok: false, reason: "not_serviced", detail: lead.territory.why };
  }

  // THE REGION, in descending order of how much we actually know.
  //
  //   1. the zip's own service territory — PPP's curated map, 99.5% of leads
  //   2. a city name we recognise for certain
  //   3. the state, but ONLY where one workspace covers the whole of it
  //
  // What is deliberately NOT here is the old step: "otherwise take the first
  // sub-region listed for the state". That is how every unplaceable New York
  // lead became a Nassau lead.
  const territoryFrag = lead.territory?.serviced ? lead.territory.workspaceFragment : undefined;
  const localityFrag = LOCALITY_REGION.find((l) => l.match.test(lead.locality ?? ""))?.fragment;
  const state = (lead.state ?? "").toUpperCase();
  const wholeStateFrag = WHOLE_STATE_REGION[state];
  const regionFrags = [territoryFrag, localityFrag, wholeStateFrag].filter(Boolean) as string[];

  const byName = (frag: string, alsoChannel?: string) =>
    workspaces.filter((w) =>
      w.name.toLowerCase().includes(frag.toLowerCase()) &&
      (alsoChannel ? w.name.toLowerCase().includes(alsoChannel.toLowerCase()) : true));

  const candidates: { ws: RoutableWorkspace; why: string }[] = [];

  // 1. Channel AND region, e.g. a Meta lead in Nassau -> "NY LI Meta".
  //    The region's own fragment first, then the coarser one its channel
  //    workspaces use — "FL Broward" has no Meta workspace, "SoFlo" does.
  if (channel) {
    for (const frag of regionFrags) {
      for (const f of [frag, CHANNEL_REGION[frag]].filter(Boolean) as string[]) {
        for (const w of byName(f, channel.fragment)) {
          if (!candidates.some((c) => c.ws.id === w.id)) {
            candidates.push({ ws: w, why: `${channel.label} lead in ${f}` });
          }
        }
      }
    }
    // 2. A NATIONAL channel workspace, and only a national one.
    //
    //    Google LSA and Thumbtack have no region in the name; their workspaces
    //    are called exactly that. Meta's are not — there are four of them, one
    //    per region — and this step used to match all four and take whichever
    //    the workspace array happened to yield first. A Fort Lauderdale lead
    //    could be texted from a New York number because of row order in a
    //    query with no ORDER BY.
    //
    //    So the match is EXACT on the channel name. A regional channel
    //    workspace can only be reached through step 1, where the region was
    //    actually established.
    for (const w of workspaces) {
      if (w.name.trim().toLowerCase() !== channel.fragment.toLowerCase()) continue;
      if (!candidates.some((c) => c.ws.id === w.id)) {
        candidates.push({ ws: w, why: `${channel.label} lead, handled nationally` });
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
    // A state we cover, split across several workspaces, and nothing told us
    // which. Named separately from a plain no-match because it needs a person
    // for ten seconds, not a configuration change — and because the number of
    // these is the measure of how well the zip map is working.
    if (SPLIT_STATES.has(state)) {
      return {
        ok: false,
        reason: "ambiguous_region",
        detail: `${state} is covered by several teams and nothing said which: zip did not resolve, city=${lead.locality ?? "—"}`,
      };
    }
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
