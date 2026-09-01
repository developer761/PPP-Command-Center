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
    const r = route("Referral", "NY", null);
    if (r.ok) expect(r.workspaceName).not.toBe("AM - NY");
    else throw new Error(r.detail);
  });

  it("REFUSES rather than using AM - NY when it is the only match", () => {
    // The version above passes even without the guard, because the lead
    // workspaces happen to sort first — it looks like coverage and is not.
    // This is the case that actually exercises it: strip every NY lead
    // workspace and leave only account management. Routing a new lead there
    // puts it in front of the wrong team and nothing would say so, and an
    // unrouted lead going to triage is the better failure.
    const amOnly = WS.filter((w) => w.name === "AM - NY");
    const r = routeLead({ source: "Referral", state: "NY", locality: null }, amOnly);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_match");
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
    // The whole point of Phase 1 being three states.
    const r = route("Referral", "CA", "Los Angeles");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("matched_inactive");
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
