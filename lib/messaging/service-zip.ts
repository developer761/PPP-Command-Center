/**
 * Is this zip one we can promise to cover, right now, in a reply?
 *
 * ── THREE ANSWERS, NOT TWO ──────────────────────────────────────────────
 *
 * territoryFor answers serviced or not serviced, which is right at lead
 * intake because "not serviced" there means a human looks at it. In a REPLY
 * the same two answers are not enough, because one of the ways to get "not
 * serviced" is that the data did not load, and telling a customer we do not
 * cover them because our own lookup failed is the exact harm A2 exists to
 * prevent.
 *
 * So this returns three, and they map one to one onto what A2 says to do:
 *
 *   serviced        carry on, and never mention that a check happened
 *   out_of_state    A2 script 2, which names the zip and the state and ASKS
 *   needs_a_person  A2 script 1, "Just a moment, I'm checking availability",
 *                   then hand off
 *
 * needs_a_person covers the zip being absent, the territory being inactive or
 * named Out of Area, AND the table being stale or empty. Kate's script 1
 * already says a human must check before any coverage is promised, so "we
 * genuinely do not know" lands exactly where it should.
 *
 * ── WHY IT READS OUR DATABASE AND NOT SALESFORCE ────────────────────────
 *
 * The tick isolates Salesforce so replies keep going out when it is down, and
 * loadZipMap returns an EMPTY map on failure by design. An empty map makes
 * every zip unserviceable. That is safe at intake and unsafe in a reply, so
 * the reply path reads the table the poll writes and never calls Salesforce.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { territoryFor, normalizeZip, type ZipRow } from "./territory";

/**
 * How old the table may be before it stops being evidence.
 *
 * The poll refreshes hourly, so ordinary operation is minutes old. This is
 * deliberately generous: zips do not change often, and a few hours of
 * Salesforce being down is not a reason to send every conversation to a
 * person. A day without a successful poll is a real outage, and at that point
 * answering "we do not know" is honest.
 */
export const STALE_AFTER_MS = 24 * 60 * 60_000;

export type ServiceCheck =
  | { outcome: "serviced"; territory: string }
  | { outcome: "out_of_state"; zip: string; state: string }
  | { outcome: "needs_a_person"; why: string };

/**
 * Full state names, because "we don't currently service the state of DE"
 * reads like a machine and Kate's script does not.
 *
 * Only the fifty states plus DC. A code that is not here falls back to the
 * code itself, which is still better than nothing.
 */
const STATE_NAME: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "Washington DC",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export function stateName(code: string | null | undefined): string {
  const c = (code ?? "").trim().toUpperCase();
  return STATE_NAME[c] ?? c;
}

/** The six PPP covers. Kept here so the out-of-state branch can be decided
 *  without importing the set and re-deriving the same answer twice. */
const SERVICED = new Set(["NJ", "CA", "CT", "FL", "NY", "CO"]);

/**
 * Pure half, so the decision can be tested without a database.
 *
 * `freshness` is the newest refreshed_at in the table, or null when it is
 * empty. Passing it in rather than reading it here keeps this a function of
 * its inputs.
 */
export function checkServiceZip(
  zip: string | null | undefined,
  row: ZipRow | null,
  freshness: Date | null,
  now: Date = new Date()
): ServiceCheck {
  const normalized = normalizeZip(zip);
  if (!normalized) {
    return { outcome: "needs_a_person", why: "no usable zip was given" };
  }

  // THE STALENESS GUARD, BEFORE THE ROW IS READ. An empty or old table must
  // not be allowed to answer, whatever it happens to contain.
  if (!freshness) {
    return { outcome: "needs_a_person", why: "the service area map has never been loaded" };
  }
  const age = now.getTime() - freshness.getTime();
  if (age > STALE_AFTER_MS) {
    const hours = Math.round(age / 3_600_000);
    return { outcome: "needs_a_person", why: `the service area map was last refreshed ${hours} hours ago` };
  }

  // OUT OF STATE IS ITS OWN ANSWER, and it is the only one that gets a
  // definite "no" in front of a customer, because it is the only one we can
  // be sure about: the state is on the record and the six we cover are fixed.
  const state = (row?.state ?? "").trim().toUpperCase();
  if (state && !SERVICED.has(state)) {
    return { outcome: "out_of_state", zip: normalized, state: stateName(state) };
  }

  const verdict = territoryFor(row);
  if (verdict.serviced) return { outcome: "serviced", territory: verdict.territory };

  // Everything else is A2 script 1: absent zip, inactive territory, Out of
  // Area, a territory nobody staffs. All of them mean a person checks with
  // the estimator before coverage is promised.
  return { outcome: "needs_a_person", why: verdict.why };
}

/**
 * The database half. Two reads: the row, and how fresh the table is.
 *
 * Any failure answers needs_a_person. A reply path that cannot reach its own
 * database must not conclude anything about coverage.
 */
export async function serviceZipCheck(
  sb: SupabaseClient,
  zip: string | null | undefined,
  now: Date = new Date()
): Promise<ServiceCheck> {
  const normalized = normalizeZip(zip);
  if (!normalized) return { outcome: "needs_a_person", why: "no usable zip was given" };

  try {
    const [rowRes, freshRes] = await Promise.all([
      sb.from("sms_service_zips")
        .select("zip, state, city, county, territory_name, territory_active")
        .eq("zip", normalized).maybeSingle(),
      sb.from("sms_service_zips")
        .select("refreshed_at").order("refreshed_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (rowRes.error || freshRes.error) {
      return { outcome: "needs_a_person", why: "the service area map could not be read" };
    }

    const r = rowRes.data;
    const row: ZipRow | null = r
      ? {
          zip: r.zip as string,
          state: (r.state as string | null) ?? null,
          city: (r.city as string | null) ?? null,
          county: (r.county as string | null) ?? null,
          territoryName: (r.territory_name as string | null) ?? null,
          territoryActive: !!r.territory_active,
        }
      : null;

    const refreshed = freshRes.data?.refreshed_at as string | undefined;
    return checkServiceZip(normalized, row, refreshed ? new Date(refreshed) : null, now);
  } catch {
    return { outcome: "needs_a_person", why: "the service area map could not be read" };
  }
}
