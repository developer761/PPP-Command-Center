import { describe, it, expect } from "vitest";
import {
  territoryFor, zipIndex, normalizeZip, TERRITORY_WORKSPACE, SERVICED_STATES,
  type ZipRow,
} from "@/lib/messaging/territory";

const row = (over: Partial<ZipRow> = {}): ZipRow => ({
  zip: "11530", territoryName: "NY Nassau North", territoryActive: true,
  state: "NY", city: "Garden City", county: "Nassau", ...over,
});

/**
 * Kate's rule A2, which this implements:
 *
 *   "Serviceability is a LOOKUP, not a judgement, and it runs in this ORDER:
 *    (1) the state must be one of NJ, CA, CT, FL, NY, CO; (2) the zip must
 *    resolve to a Zip_Code__c row; (3) that row's Service_Territory__r.IsActive
 *    must be TRUE and the territory must not be named 'Out of Area'."
 */
describe("A2 — is this zip serviced", () => {
  it("services an active territory in a covered state", () => {
    const v = territoryFor(row());
    expect(v.serviced).toBe(true);
    if (v.serviced) expect(v.workspaceFragment).toBe("NY LI Nassau");
  });

  it("refuses a zip that is not in the map at all", () => {
    const v = territoryFor(null);
    expect(v.serviced).toBe(false);
    if (!v.serviced) expect(v.why).toMatch(/not in the service map/);
  });

  it("refuses a state PPP does not cover, whatever the row says", () => {
    // A2 step 1 is first for a reason: a Texas row with an active territory is
    // still Texas.
    const v = territoryFor(row({ state: "TX", territoryName: "TX Dallas Collin", territoryActive: true }));
    expect(v.serviced).toBe(false);
    if (!v.serviced) expect(v.why).toMatch(/TX is outside/);
  });

  it("refuses Out of Area by name", () => {
    const v = territoryFor(row({ territoryName: "Out of Area", territoryActive: true }));
    expect(v.serviced).toBe(false);
    if (!v.serviced) expect(v.why).toMatch(/Out of Area/);
  });

  it("refuses an inactive territory", () => {
    const v = territoryFor(row({ territoryName: "FL Orlando", territoryActive: false, state: "FL" }));
    expect(v.serviced).toBe(false);
    if (!v.serviced) expect(v.why).toMatch(/not an active territory/);
  });

  it("refuses a zip with no territory at all", () => {
    expect(territoryFor(row({ territoryName: null })).serviced).toBe(false);
  });

  it("says Orange County is commercial work, not an unfilled gap", () => {
    // Kate, 2026-09-22: Orange is active only because Evan had commercial
    // projects there, and commercial does not qualify for the residential bot.
    // "Nobody covers this" would send somebody off to fix a thing that is
    // working as intended.
    const v = territoryFor(row({ territoryName: "CA Orange", state: "CA", territoryActive: true }));
    expect(v.serviced).toBe(false);
    if (!v.serviced) {
      expect(v.why).toMatch(/commercial/i);
      expect(v.why).not.toMatch(/no workspace covers it/);
    }
  });

  it("still reports a genuine gap as a gap", () => {
    // A territory that IS ours and simply has no workspace must not be quietly
    // absorbed into the deliberate list.
    const v = territoryFor(row({ territoryName: "NY Albany", state: "NY", territoryActive: true }));
    expect(v.serviced).toBe(false);
    if (!v.serviced) expect(v.why).toMatch(/no workspace covers it/);
  });

  it("covers exactly the six states Kate lists", () => {
    expect([...SERVICED_STATES].sort()).toEqual(["CA", "CO", "CT", "FL", "NJ", "NY"]);
  });
});

/**
 * Marketing_Active__c is the field that looks like the right one and is not.
 * Kate, in red: "🔴 Marketing_Active__c IS NOT A SERVICEABILITY TEST."
 */
describe("A2 — marketing-inactive is still serviced", () => {
  it("has no way to read Marketing_Active__c at all", () => {
    // Structural rather than remembered: ZipRow has no field for it, so no
    // amount of later editing can accidentally start filtering on it.
    expect(Object.keys(row())).not.toContain("marketingActive");
    expect(JSON.stringify(row())).not.toMatch(/marketing/i);
  });
});

describe("the territory → workspace map", () => {
  it("sends both Nassau territories to one workspace", () => {
    expect(TERRITORY_WORKSPACE["NY Nassau North"]).toBe("NY LI Nassau");
    expect(TERRITORY_WORKSPACE["NY Nassau South"]).toBe("NY LI Nassau");
  });

  it("sends all three Suffolk territories to one workspace", () => {
    for (const t of ["NY Suffolk North", "NY Suffolk South", "NY Suffolk East"]) {
      expect(TERRITORY_WORKSPACE[t], t).toBe("NY LI Suffolk");
    }
  });

  it("keeps Nassau and Suffolk apart, which is the whole point", () => {
    expect(TERRITORY_WORKSPACE["NY Nassau North"]).not.toBe(TERRITORY_WORKSPACE["NY Suffolk North"]);
  });

  it("sends the four boroughs that are not Queens to NY NYC", () => {
    for (const t of ["NY Manhattan North", "NY Manhattan South", "NY Brooklyn", "NY Bronx Staten Island"]) {
      expect(TERRITORY_WORKSPACE[t], t).toBe("NY NYC");
    }
    expect(TERRITORY_WORKSPACE["NY Queens"]).toBe("NY Queens");
  });

  it("sends all four New Jersey territories to one workspace", () => {
    for (const t of ["NJ Bergen", "NJ Passaic Essex", "NJ Union Middlesex", "NJ Middlesex Monmouth"]) {
      expect(TERRITORY_WORKSPACE[t], t).toBe("NJ");
    }
  });

  it("leaves CA Orange unmapped on purpose", () => {
    // If somebody adds it, they should do so because a decision was made about
    // Orange County — not because a test told them the map looked incomplete.
    expect(TERRITORY_WORKSPACE["CA Orange"]).toBeUndefined();
  });

  it("maps every territory to a fragment, never to a full workspace name", () => {
    // The rest of routing.ts matches on fragments. A value like
    // "NY LI Nassau Leads" would silently miss the channel lookup, which is
    // how a Fort Lauderdale Meta lead once reached NY LI Meta.
    for (const [t, frag] of Object.entries(TERRITORY_WORKSPACE)) {
      expect(frag, t).not.toMatch(/Leads$/);
    }
  });
});

describe("matching a lead's zip to the map", () => {
  it("reads a plain five-digit zip", () => {
    expect(normalizeZip("11530")).toBe("11530");
  });

  it("reads ZIP+4, which is what Salesforce leads often carry", () => {
    expect(normalizeZip("11530-1234")).toBe("11530");
  });

  it("tolerates surrounding whitespace", () => {
    expect(normalizeZip(" 07030 ")).toBe("07030");
  });

  it("keeps a leading zero", () => {
    // New Jersey's zips all start with 0. Parsing as a number loses it and
    // routes every NJ lead to nowhere.
    expect(normalizeZip("07030")).toBe("07030");
  });

  it("refuses anything that is not a zip", () => {
    for (const v of ["", "  ", "1234", "123456", "ABCDE", "11530-12", null, undefined]) {
      expect(normalizeZip(v as string), String(v)).toBeNull();
    }
  });

  it("indexes rows on the normalised zip", () => {
    const ix = zipIndex([row({ zip: "11530-9999" }), row({ zip: "11024", territoryName: "NY Nassau North" })]);
    expect(ix.get("11530")?.city).toBe("Garden City");
    expect(ix.get("11024")).toBeTruthy();
  });

  it("keeps the first row when a zip appears twice", () => {
    const ix = zipIndex([
      row({ zip: "11530", territoryName: "NY Nassau North" }),
      row({ zip: "11530", territoryName: "NY Suffolk North" }),
    ]);
    expect(ix.get("11530")?.territoryName).toBe("NY Nassau North");
  });

  it("skips rows with an unusable zip rather than indexing junk", () => {
    expect(zipIndex([row({ zip: "" }), row({ zip: "nope" })]).size).toBe(0);
  });
});
