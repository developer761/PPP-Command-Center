/**
 * Which PPP service territory a lead is in, and which workspace texts them.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * routing.ts guessed. It carried a list of about thirty city names per region
 * and, when a lead's city was not one of them, fell back to the FIRST region
 * fragment for the state — which for NY is "NY LI Nassau". Measured against
 * 2,000 real leads from the last 90 days on 2026-09-22:
 *
 *   PostalCode present on           99.5%
 *   City present on                 85.3%
 *   cities the hardcoded list knew  24.8%
 *
 * So three quarters of leads with a city were routed by state alone, and every
 * one of those NY leads was handed to Nassau. Massapequa, Syosset, Wantagh,
 * Valley Stream, New Hyde Park and Locust Valley are all Nassau and it got
 * those right by luck; Port Jefferson Station, Lindenhurst and Farmingdale are
 * SUFFOLK and it got those wrong. Every California lead went to LA, San Diego
 * included. The customer sees a 516 number for a job two counties away, and
 * replies to a team that does not cover them.
 *
 * Meanwhile PPP already maintains the answer: 2,194 Zip_Code__c rows in
 * Salesforce, each pointing at a ServiceTerritory, each carrying the city,
 * county and state. Kate's rule A2 is written against exactly this lookup.
 * Guessing from a regex when the company curates a zip map is the bug.
 *
 * ── KATE'S RULE A2, WHICH THIS IMPLEMENTS ────────────────────────────────
 *
 *   "Serviceability is a LOOKUP, not a judgement, and it runs in this ORDER:
 *    (1) the state must be one of NJ, CA, CT, FL, NY, CO; (2) the zip must
 *    resolve to a Zip_Code__c row; (3) that row's Service_Territory__r.IsActive
 *    must be TRUE and the territory must not be named 'Out of Area'."
 *
 *   "🔴 Marketing_Active__c IS NOT A SERVICEABILITY TEST. A zip whose
 *    TERRITORY is active is bookable whether Marketing_Active__c is TRUE or
 *    FALSE."
 *
 * Both are honoured below, including the second — it is the kind of field that
 * looks like the right one to filter on and is not.
 *
 * Pure. The caller does the Salesforce lookup and passes the row in.
 */

/** A Zip_Code__c row, as the poll reads it. */
export type ZipRow = {
  zip: string;
  territoryName: string | null;
  territoryActive: boolean;
  state: string | null;
  city: string | null;
  county: string | null;
};

export type TerritoryVerdict =
  | { serviced: true; territory: string; workspaceFragment: string }
  | { serviced: false; why: string; territory: string | null };

/** Kate A2 step 1: outside these, nothing is serviced whatever the row says. */
export const SERVICED_STATES = new Set(["NJ", "CA", "CT", "FL", "NY", "CO"]);

/**
 * Salesforce territory → the Connect Hub workspace that texts it.
 *
 * MANY TERRITORIES TO ONE WORKSPACE, because Salesforce splits finer than PPP
 * staffs phone numbers: Nassau is North and South in Salesforce and one number
 * here. Values are the workspace-name FRAGMENT the rest of routing.ts matches
 * on, not a full workspace name, so the channel and region lookups share one
 * vocabulary. Written out rather than derived from the names, because "NY Manhattan
 * South → NY NYC" is a business decision and no string rule produces it.
 *
 * Every active territory in the org on 2026-09-22 is listed. If Salesforce
 * gains one and this does not, the lead goes to TRIAGE and says why — it is
 * never quietly handed to whichever workspace happens to match a substring,
 * which is the whole failure this file replaces.
 */
export const TERRITORY_WORKSPACE: Record<string, string> = {
  // Long Island — two Salesforce territories per county, one number each.
  "NY Nassau North": "NY LI Nassau",
  "NY Nassau South": "NY LI Nassau",
  "NY Suffolk North": "NY LI Suffolk",
  "NY Suffolk South": "NY LI Suffolk",
  "NY Suffolk East": "NY LI Suffolk",

  "NY Queens": "NY Queens",
  // Westchester also covers 14 Connecticut zips in Salesforce. That is the
  // territory's own definition, so those leads belong to the Westchester team
  // even though the customer is in CT.
  "NY Westchester": "NY Wstch",

  // The five boroughs bar Queens are one workspace here.
  "NY Manhattan North": "NY NYC",
  "NY Manhattan South": "NY NYC",
  "NY Brooklyn": "NY NYC",
  "NY Bronx Staten Island": "NY NYC",

  // New Jersey is four territories and one number.
  "NJ Bergen": "NJ",
  "NJ Passaic Essex": "NJ",
  "NJ Union Middlesex": "NJ",
  "NJ Middlesex Monmouth": "NJ",

  "FL Broward": "FL Broward",
  "FL Broward Palm": "FL Broward",
  "FL Miami": "FL Miami",

  "CT New Haven": "CT",
  "CO Denver": "CO Denver",

  "CA Los Angeles East": "CA LA",
  "CA Los Angeles South": "CA LA",
  "CA San Diego": "CA San Diego",

  // "CA Orange" IS DELIBERATELY ABSENT — see NOT_OURS below.
};

/**
 * Territories that are active in Salesforce and deliberately NOT ours.
 *
 * "No workspace covers this" and "this is not our work" look identical from
 * the outside and need opposite responses: the first is a gap somebody should
 * close, the second is correct and should be left alone. Saying which spares
 * whoever works the triage queue from trying to fix something that is not
 * broken.
 */
export const NOT_OURS: Record<string, string> = {
  // Kate, 2026-09-22, asked why Orange County was active at all:
  //
  //   "Dave handled it for a short time, and I think that's only active
  //    because Evan had some commercial projects there, which don't qualify
  //    for Hatch. It likely hasn't had much if any activity since there's been
  //    no marketing budget since the beginning of the FY, so should be
  //    self-gen only."
  //
  // The territory is active for COMMERCIAL work, and this is the residential
  // SMS bot. Its sibling CA Orange North was deactivated in February 2025
  // alongside CA Los Angeles West and CA San Diego North; Orange itself was
  // kept and modified again in April 2026, which is why it does not read as an
  // oversight. It is not one.
  //
  // Two leads arrived from Orange County zips in the 90 days to 2026-09-22,
  // against 224 Californian leads overall — consistent with self-gen only.
  "CA Orange": "Orange County is active for commercial work only, which the residential bot does not cover",
};

/** Territories that mean "we do not cover this", whatever else the row says. */
const NOT_SERVICED_NAME = /^out of area$/i;

/**
 * Is this zip serviced, and by whom?
 *
 * Order is Kate's, and it matters: a zip in Texas is not serviced even if a
 * row exists for it, and an inactive territory is not serviced even if the
 * state is one we cover.
 */
export function territoryFor(row: ZipRow | null | undefined): TerritoryVerdict {
  // A2 step 2, checked first in practice because a missing row tells us
  // nothing about the state either.
  if (!row) return { serviced: false, why: "that zip is not in the service map", territory: null };

  const state = (row.state ?? "").trim().toUpperCase();
  if (state && !SERVICED_STATES.has(state)) {
    return { serviced: false, why: `${state} is outside the states PPP covers`, territory: row.territoryName };
  }

  const name = (row.territoryName ?? "").trim();
  if (!name) return { serviced: false, why: "that zip has no service territory", territory: null };
  if (NOT_SERVICED_NAME.test(name)) {
    return { serviced: false, why: "that zip is marked Out of Area", territory: name };
  }
  // A2 step 3. NOT Marketing_Active__c — see the note at the top of this file.
  if (!row.territoryActive) {
    return { serviced: false, why: `${name} is not an active territory`, territory: name };
  }

  // Active, and deliberately somebody else's work. Distinguished from the gap
  // below because the two need opposite responses: this one is correct.
  const notOurs = NOT_OURS[name];
  if (notOurs) return { serviced: false, why: notOurs, territory: name };

  const fragment = TERRITORY_WORKSPACE[name];
  if (!fragment) {
    // Known, active, ours to cover, and nobody here does. A real gap. Said
    // plainly rather than guessed at, because the guess texts a real person
    // from a wrong number.
    return { serviced: false, why: `${name} is active in Salesforce but no workspace covers it`, territory: name };
  }

  return { serviced: true, territory: name, workspaceFragment: fragment };
}

/** Index a batch of zip rows for lookup. Zips are compared on their first 5
 *  digits — Salesforce holds "11024" and leads arrive as "11024-1234". */
export function zipIndex(rows: ZipRow[]): Map<string, ZipRow> {
  const m = new Map<string, ZipRow>();
  for (const r of rows) {
    const k = normalizeZip(r.zip);
    if (k && !m.has(k)) m.set(k, r);
  }
  return m;
}

/** "11024-1234" → "11024". " 07030 " → "07030". Anything else → null. */
export function normalizeZip(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  const m = /^(\d{5})(?:-\d{4})?$/.exec(t);
  return m ? m[1] : null;
}
