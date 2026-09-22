import { describe, it, expect } from "vitest";
import { routeLead, type RoutableWorkspace } from "@/lib/messaging/routing";

/** The real Phase 1 set, plus the inactive ones that matter to the rules. */
const WS: RoutableWorkspace[] = [
  ["NY LI Nassau Leads", true, "+15163448418"],
  ["NY LI Suffolk Leads", true, "+16315276864"],
  ["NY NYC Leads", true, "+19293352212"],
  ["NY Queens Leads", true, "+13476577035"],
  ["NY Wstch Leads", true, "+19144156860"],
  ["NY LI Meta", true, "+15165852881"],
  ["NYC Meta", true, "+19295656501"],
  ["AM - NY", true, "+15167885933"],
  ["NJ Leads", true, "+12019039790"],
  ["NJ Meta", true, "+19733709440"],
  ["FL Broward Leads", true, "+19544194564"],
  ["FL Miami Leads", true, "+17868768407"],
  ["SoFlo Meta", true, "+17545474310"],
  ["Google LSA", false, "+15162269404"],   // seeded inactive pending scope
  ["Thumbtack", false, null],              // no number at all
  ["CA LA Leads", false, "+13235290930"],  // later phase
  ["CT Leads", false, "+14758897507"],
].map(([name, is_active, phone_e164], i) => ({ id: `w${i}`, name, is_active, phone_e164 } as RoutableWorkspace));

const route = (source: string | null, state: string | null, locality: string | null = null) =>
  routeLead({ source, state, locality }, WS);

describe("routeLead — source beats region", () => {
  it("sends a Meta lead in Nassau to NY LI Meta, not NY LI Nassau Leads", () => {
    // The Meta workspaces exist so Meta traffic is separable. Region-first
    // would defeat the reason PPP created them.
    const r = route("Meta Ad", "NY", "Garden City");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workspaceName).toBe("NY LI Meta");
  });

  it("sends a non-Meta Nassau lead to NY LI Nassau Leads", () => {
    const r = route("Referral", "NY", "Garden City");
    if (r.ok) expect(r.workspaceName).toBe("NY LI Nassau Leads");
    else throw new Error(r.detail);
  });

  it("recognises Facebook and Instagram as Meta", () => {
    for (const s of ["Facebook", "Instagram Lead Ad", "FB Ads"]) {
      const r = route(s, "NJ");
      if (r.ok) expect(r.workspaceName).toBe("NJ Meta");
      else throw new Error(`${s}: ${r.detail}`);
    }
  });
});

describe("routeLead — locality beats state", () => {
  it("separates the five New York workspaces by locality", () => {
    const cases: [string, string][] = [
      ["Hicksville", "NY LI Nassau Leads"],
      ["Sayville", "NY LI Suffolk Leads"],
      ["Astoria", "NY Queens Leads"],
      ["Yonkers", "NY Wstch Leads"],
      ["Brooklyn", "NY NYC Leads"],
    ];
    for (const [locality, expected] of cases) {
      const r = route("Referral", "NY", locality);
      if (r.ok) expect(r.workspaceName).toBe(expected);
      else throw new Error(`${locality}: ${r.detail}`);
    }
  });

  it("falls back to the state when the locality is unknown", () => {
    const r = route("Referral", "NJ", "somewhere unlisted");
    if (r.ok) expect(r.workspaceName).toBe("NJ Leads");
    else throw new Error(r.detail);
  });
});

describe("routeLead — never routes a new lead to account management", () => {
  it("does not pick AM - NY when lead workspaces also match", () => {
    const r = route("Referral", "NY", "Garden City");
    if (r.ok) expect(r.workspaceName).not.toBe("AM - NY");
    else throw new Error(r.detail);
  });

  it("REFUSES rather than using an AM workspace when it is the only match", () => {
    // Account management is a different team from new leads. A lead landing
    // there is in front of the wrong people with nothing to say so, and an
    // unrouted lead going to triage is the better failure.
    //
    // Named to match the region exactly, because that is now the only way the
    // guard is reached at all: region fragments are specific ("NY LI Nassau")
    // and the real AM workspaces are coarse ("AM - NY"), so they no longer
    // collide by accident. The guard is belt-and-braces; this proves it holds.
    const amOnly: RoutableWorkspace[] = [
      { id: "am", name: "AM - NY LI Nassau", is_active: true, phone_e164: "+15167885933" },
    ];
    const r = routeLead({ source: "Referral", state: "NY", locality: "Garden City" }, amOnly);
    expect(r.ok).toBe(false);
  });
});

describe("routeLead — refusals name the right problem", () => {
  it("distinguishes 'not switched on' from 'no number'", () => {
    // Different fixes, different people. A rollout decision is not a data gap.
    const lsa = route("Google LSA", null);
    expect(lsa.ok).toBe(false);
    if (!lsa.ok) expect(lsa.reason).toBe("matched_inactive");

    const tt = route("Thumbtack", null);
    expect(tt.ok).toBe(false);
    if (!tt.ok) expect(["matched_inactive", "matched_no_number"]).toContain(tt.reason);
  });

  it("a Texas lead matches NOTHING, because PPP left Texas", () => {
    // Not "matched something inactive" — there is no Texas workspace in the
    // routable set at all. The distinction matters: an inactive match is a
    // rollout decision waiting to be flipped, and this is a region that is
    // never coming back. Landing in no_match is what sends it to triage
    // instead of to a queue somebody expects to drain.
    const r = route("Referral", "TX", "Dallas");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_match");
  });

  it("refuses when there is nothing to go on at all", () => {
    const r = route(null, null, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_match");
  });

  it("a California lead does not leak into the NY/NJ/FL phase", () => {
    // The whole point of Phase 1 being three states. With the zip resolved,
    // it names the real problem: the LA workspace exists and is switched off.
    const r = routeLead(
      { source: "Referral", state: "CA", locality: "Los Angeles",
        territory: { serviced: true, territory: "CA Los Angeles East", workspaceFragment: "CA LA" } },
      WS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("matched_inactive");
  });

  it("refuses a California lead with no zip rather than guessing LA", () => {
    // Every CA lead used to land on CA LA Leads, San Diego included, because
    // "CA LA" was simply the first fragment listed for the state.
    const r = route("Referral", "CA", "San Diego");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous_region");
  });
});

describe("routeLead — every result is explainable", () => {
  it("says why it chose what it chose", () => {
    const r = route("Meta", "FL", "Fort Lauderdale");
    if (r.ok) {
      expect(r.why).toContain("Meta");
      expect(r.workspaceName).toBe("SoFlo Meta");
    } else throw new Error(r.detail);
  });
});

/**
 * ROUTING ON THE ZIP, which is what PPP actually maintains.
 *
 * Measured against 2,000 real leads from the last 90 days on 2026-09-22:
 * PostalCode is present on 99.5% of them, a city on 85.3%, and the hardcoded
 * city list recognised 24.8% of those. So three quarters of leads with a city
 * were routed by STATE ALONE — which took the first sub-region listed, and for
 * New York that is Nassau.
 */
const serviced = (territory: string, workspaceFragment: string) =>
  ({ serviced: true as const, territory, workspaceFragment });

describe("routeLead — the zip decides", () => {
  it("sends a Suffolk zip to Suffolk, not to Nassau", () => {
    // Port Jefferson Station: a real Suffolk town, in the unrecognised list,
    // and handed to Nassau every single time before this.
    const r = routeLead(
      { source: "Referral", state: "NY", locality: "Port Jefferson Station",
        territory: serviced("NY Suffolk North", "NY LI Suffolk") },
      WS
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workspaceName).toBe("NY LI Suffolk Leads");
  });

  it("sends a Nassau zip to Nassau", () => {
    const r = routeLead(
      { source: "Referral", state: "NY", locality: "Massapequa",
        territory: serviced("NY Nassau South", "NY LI Nassau") },
      WS
    );
    if (r.ok) expect(r.workspaceName).toBe("NY LI Nassau Leads");
    else throw new Error(r.detail);
  });

  it("beats a city name that says otherwise", () => {
    // The zip is the curated answer; the free-text city is what somebody typed
    // into a web form. Farmingdale straddles the Nassau/Suffolk line and is a
    // real example of the two disagreeing.
    const r = routeLead(
      { source: "Referral", state: "NY", locality: "Huntington",
        territory: serviced("NY Nassau North", "NY LI Nassau") },
      WS
    );
    if (r.ok) expect(r.workspaceName).toBe("NY LI Nassau Leads");
    else throw new Error(r.detail);
  });

  it("still lets the channel win over the region", () => {
    // Meta traffic is separable on purpose, and the zip does not change that.
    const r = routeLead(
      { source: "Meta Ad", state: "NY", locality: "Massapequa",
        territory: serviced("NY Nassau South", "NY LI Nassau") },
      WS
    );
    if (r.ok) expect(r.workspaceName).toBe("NY LI Meta");
    else throw new Error(r.detail);
  });
});

describe("routeLead — a lead we cannot place goes to a person", () => {
  it("refuses a New York lead whose city nobody recognises", () => {
    // Buffalo. Four hundred miles from Nassau, and Nassau got it.
    const r = route("Referral", "NY", "Buffalo");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous_region");
      expect(r.detail).toMatch(/several teams/i);
    }
  });

  it("refuses a New York lead with no city at all", () => {
    expect(route("Referral", "NY", null).ok).toBe(false);
  });

  it("still routes a state one team covers outright", () => {
    // NJ is four Salesforce territories and one phone number, so the state on
    // its own is enough and there is nothing to guess between.
    const r = route("Referral", "NJ", "Piscataway");
    if (r.ok) expect(r.workspaceName).toBe("NJ Leads");
    else throw new Error(r.detail);
  });
});

describe("routeLead — Kate's rule A2, serviceability", () => {
  const notServiced = (why: string) => ({ serviced: false as const, why, territory: null });

  it("does not route a lead outside the states PPP covers", () => {
    const r = routeLead(
      { source: "Referral", state: "TX", locality: "Austin", territory: notServiced("TX is outside the states PPP covers") },
      WS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_serviced");
  });

  it("does not route an Out of Area zip", () => {
    const r = routeLead(
      { source: "Referral", state: "NY", locality: "Somewhere", territory: notServiced("that zip is marked Out of Area") },
      WS
    );
    if (!r.ok) expect(r.reason).toBe("not_serviced");
    else throw new Error("routed an Out of Area lead");
  });

  it("does not route an inactive territory", () => {
    const r = routeLead(
      { source: "Referral", state: "FL", locality: "Orlando", territory: notServiced("FL Orlando is not an active territory") },
      WS
    );
    if (!r.ok) expect(r.reason).toBe("not_serviced");
    else throw new Error("routed an inactive territory");
  });

  it("refuses an active territory nobody here covers, rather than guessing", () => {
    // CA Orange is real: 87 zips, active in Salesforce, and no Connect Hub
    // workspace at all. Guessing "CA LA Leads" texts an Orange County customer
    // from a Los Angeles number.
    const r = routeLead(
      { source: "Referral", state: "CA", locality: "Irvine",
        territory: notServiced("CA Orange is active in Salesforce but no workspace covers it") },
      WS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/no workspace covers it/);
  });

  it("checks serviceability before anything else, including the channel", () => {
    // A Meta lead in Texas is still a lead in Texas.
    const r = routeLead(
      { source: "Meta Ad", state: "TX", locality: "Dallas", territory: notServiced("TX is outside the states PPP covers") },
      WS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_serviced");
  });
});

describe("routeLead — a channel workspace is never borrowed from another region", () => {
  it("sends a Fort Lauderdale Meta lead to SoFlo Meta", () => {
    // Meta workspaces are cut coarser than lead workspaces: Broward and Miami
    // share SoFlo Meta. Getting this wrong sent it to NY LI Meta — a Florida
    // customer texted from a New York number.
    const r = route("Meta", "FL", "Fort Lauderdale");
    if (r.ok) expect(r.workspaceName).toBe("SoFlo Meta");
    else throw new Error(r.detail);
  });

  it("does not hand a region with no Meta workspace to another region's", () => {
    // Westchester has no Meta workspace. The regional LEADS workspace is the
    // right team and the right area code; NY LI Meta is neither.
    const r = route("Meta", "NY", "Yonkers");
    if (r.ok) {
      expect(r.workspaceName).toBe("NY Wstch Leads");
      expect(r.workspaceName).not.toMatch(/Meta/);
    } else throw new Error(r.detail);
  });

  it("does not pick a Meta workspace at all when the region is unknown", () => {
    // The bug underneath: step 2 matched every workspace containing "Meta" and
    // took whichever the array yielded first, so row order in a query with no
    // ORDER BY decided which number a customer saw.
    const r = route("Meta Ad", "NY", "Buffalo");
    expect(r.ok).toBe(false);
  });

  it("still uses a genuinely national channel workspace", () => {
    // Google LSA and Thumbtack have no region in the name and cover everywhere.
    const live: RoutableWorkspace[] = [
      { id: "lsa", name: "Google LSA", is_active: true, phone_e164: "+15162269404" },
    ];
    const r = routeLead({ source: "Google LSA", state: "NY", locality: "Buffalo" }, live);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workspaceName).toBe("Google LSA");
  });
});
