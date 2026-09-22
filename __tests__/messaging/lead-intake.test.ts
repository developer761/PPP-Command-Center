import { describe, it, expect } from "vitest";
import { decideIntake, speedToLeadSeconds } from "@/lib/messaging/lead-intake";
import type { RoutableWorkspace } from "@/lib/messaging/routing";
import type { E164 } from "@/lib/messaging/phone";

const WS: RoutableWorkspace[] = [
  { id: "w1", name: "NY LI Nassau Leads", is_active: true,  phone_e164: "+15163448418" },
  { id: "w2", name: "NY LI Meta",         is_active: true,  phone_e164: "+15165852881" },
  { id: "w3", name: "CA LA Leads",        is_active: false, phone_e164: "+13235290930" },
  { id: "w4", name: "Thumbtack",          is_active: true,  phone_e164: null },
];
const ctx = { workspaces: WS };

describe("decideIntake — routing a good lead", () => {
  it("routes a Nassau lead to Nassau", () => {
    const d = decideIntake(
      { sfRecordId: "00Q1", phone: "(516) 892-3401", state: "NY", locality: "Garden City", leadSource: "Referral" },
      ctx
    );
    expect(d.action).toBe("route");
    if (d.action === "route") {
      expect(d.workspaceName).toBe("NY LI Nassau Leads");
      expect(d.phone).toBe("+15168923401"); // normalised on the way through
    }
  });

  it("sends a Meta lead to the Meta workspace, not the regional one", () => {
    const d = decideIntake(
      { sfRecordId: "00Q2", phone: "5168923401", state: "NY", locality: "Garden City", leadSource: "Meta Ad" },
      ctx
    );
    if (d.action === "route") expect(d.workspaceName).toBe("NY LI Meta");
    else throw new Error(JSON.stringify(d));
  });
});

describe("decideIntake — a lead with no usable phone is triage, not a routing failure", () => {
  it("triages a missing phone and says so", () => {
    const d = decideIntake({ sfRecordId: "00Q3", state: "NY" }, ctx);
    expect(d.action).toBe("triage");
    if (d.action === "triage") {
      expect(d.reason).toBe("no_contactable_phone");
      expect(d.detail).toContain("no phone");
    }
  });

  it("triages a phone we cannot text, quoting what arrived", () => {
    // Whoever works the queue needs to see the bad value, not just be told
    // something was wrong with it.
    const d = decideIntake({ sfRecordId: "00Q4", phone: "555-1234", state: "NY" }, ctx);
    if (d.action === "triage") {
      expect(d.reason).toBe("no_contactable_phone");
      expect(d.detail).toContain("555-1234");
    } else throw new Error("expected triage");
  });

  it("triages a number in the reserved 555-01XX block", () => {
    // The fictional range. Its presence in real lead data means a test fixture
    // has leaked into production input, which is worth surfacing rather than
    // texting. Found the hard way: the first draft of THIS file used 555-01XX
    // numbers throughout and every routing test failed, because the rule works.
    const d = decideIntake(
      { sfRecordId: "00Q11", phone: "(516) 555-0147", state: "NY", locality: "Garden City" }, ctx);
    expect(d.action).toBe("triage");
    if (d.action === "triage") expect(d.reason).toBe("no_contactable_phone");
  });

  it("checks the phone BEFORE routing", () => {
    // A lead with no phone and no routable region is a phone problem first.
    // Reporting it as a routing failure sends the wrong person to look.
    const d = decideIntake({ sfRecordId: "00Q5", phone: null, state: "ZZ" }, ctx);
    if (d.action === "triage") expect(d.reason).toBe("no_contactable_phone");
    else throw new Error("expected triage");
  });
});

describe("decideIntake — triage reasons stay distinguishable", () => {
  it("region not live is not the same as no match", () => {
    // Different fixes: one is a rollout decision, the other is a missing rule.
    //
    // Given the ZIP this names the real problem — CA LA Leads exists and is
    // switched off. Without one it is "region_unclear" instead, because
    // California is split between LA and San Diego and nothing said which;
    // that case is asserted on its own below.
    const inactive = decideIntake(
      { sfRecordId: "00Q6", phone: "3238923401", state: "CA", locality: "Los Angeles", postalCode: "90012" },
      { ...ctx, territoryFor: () => ({ serviced: true, territory: "CA Los Angeles East", workspaceFragment: "CA LA" }) });
    if (inactive.action === "triage") expect(inactive.reason).toBe("region_not_live");
    else throw new Error("expected triage");

    const unknown = decideIntake({ sfRecordId: "00Q7", phone: "5168923401", state: "ZZ" }, ctx);
    if (unknown.action === "triage") expect(unknown.reason).toBe("no_matching_workspace");
    else throw new Error("expected triage");
  });

  it("a workspace with no number is a data gap of its own", () => {
    const d = decideIntake(
      { sfRecordId: "00Q8", phone: "5168923401", leadSource: "Thumbtack" }, ctx);
    if (d.action === "triage") {
      expect(["workspace_has_no_number", "region_not_live"]).toContain(d.reason);
    } else throw new Error("expected triage");
  });
});

describe("decideIntake — suppression is checked at the door", () => {
  it("ignores a lead whose number opted out, without opening a thread", () => {
    // The gate would stop the send anyway. Checking here means no conversation
    // appears in the inbox that should never have existed.
    const d = decideIntake(
      { sfRecordId: "00Q9", phone: "5168923401", state: "NY", locality: "Garden City" },
      { ...ctx, isSuppressed: () => true }
    );
    expect(d.action).toBe("ignore");
    if (d.action === "ignore") expect(d.reason).toContain("opted out");
  });

  it("checks suppression against the NORMALISED number", () => {
    // If it were checked against the raw value, "(516) 892-3401" would miss a
    // suppression stored as +15168923401 — the exact reason toE164 exists.
    let seen: string | null = null;
    decideIntake(
      { sfRecordId: "00Q10", phone: "(516) 892-3401", state: "NY", locality: "Garden City" },
      { ...ctx, isSuppressed: (p: E164) => { seen = p; return false; } }
    );
    expect(seen).toBe("+15168923401");
  });
});

describe("speedToLeadSeconds — the number PPP is buying", () => {
  it("measures from Salesforce creation to first message", () => {
    expect(speedToLeadSeconds("2026-09-07T10:00:00Z", "2026-09-07T10:00:45Z")).toBe(45);
  });

  it("returns null, not 0, when a measurement is missing", () => {
    // A missing measurement and an instant reply must not look the same.
    expect(speedToLeadSeconds(null, "2026-09-07T10:00:00Z")).toBeNull();
    expect(speedToLeadSeconds("2026-09-07T10:00:00Z", null)).toBeNull();
    expect(speedToLeadSeconds(undefined, undefined)).toBeNull();
  });

  it("returns null for an unparseable date rather than NaN", () => {
    expect(speedToLeadSeconds("not a date", "2026-09-07T10:00:00Z")).toBeNull();
  });

  it("clamps clock skew to 0 rather than reporting a negative age", () => {
    // Salesforce and Vercel clocks differ. A negative value would read as a
    // message sent before the lead existed.
    expect(speedToLeadSeconds("2026-09-07T10:00:05Z", "2026-09-07T10:00:00Z")).toBe(0);
  });

  it("accepts Date objects as well as strings", () => {
    expect(speedToLeadSeconds(new Date("2026-09-07T10:00:00Z"), new Date("2026-09-07T10:01:00Z"))).toBe(60);
  });
});

/**
 * The two triage reasons the zip map introduced.
 *
 * Both replace a silent wrong answer. "region_unclear" replaces guessing the
 * first sub-region for a state; "not_serviced" replaces texting somebody PPP
 * cannot send an estimator to.
 */
describe("decideIntake — the zip decides, and says so when it cannot", () => {
  const laterritory = (workspaceFragment: string) =>
    () => ({ serviced: true as const, territory: "t", workspaceFragment });

  it("routes on the zip's territory, over the city", () => {
    const d = decideIntake(
      { sfRecordId: "00QZ", phone: "5168923401", state: "NY", locality: "somewhere nobody lists", postalCode: "11024" },
      { ...ctx, territoryFor: laterritory("NY LI Nassau") }
    );
    if (d.action === "route") expect(d.workspaceName).toBe("NY LI Nassau Leads");
    else throw new Error(JSON.stringify(d));
  });

  it("triages a split state it cannot place, rather than guessing", () => {
    // Buffalo used to land on Nassau. Four hundred miles.
    const d = decideIntake(
      { sfRecordId: "00QY", phone: "5168923401", state: "NY", locality: "Buffalo" }, ctx);
    if (d.action === "triage") expect(d.reason).toBe("region_unclear");
    else throw new Error(JSON.stringify(d));
  });

  it("triages a lead outside the service area — Kate's rule A2", () => {
    const d = decideIntake(
      { sfRecordId: "00QX", phone: "5168923401", state: "TX", locality: "Austin", postalCode: "73301" },
      { ...ctx, territoryFor: () => ({ serviced: false, why: "TX is outside the states PPP covers", territory: null }) }
    );
    if (d.action === "triage") {
      expect(d.reason).toBe("not_serviced");
      expect(d.detail).toMatch(/outside the states/);
    } else throw new Error(JSON.stringify(d));
  });

  it("triages an active territory nobody covers, naming it", () => {
    // CA Orange: 87 zips, active in Salesforce, no workspace here.
    const d = decideIntake(
      { sfRecordId: "00QW", phone: "9498923401", state: "CA", locality: "Irvine", postalCode: "92602" },
      { ...ctx, territoryFor: () => ({ serviced: false, why: "CA Orange is active in Salesforce but no workspace covers it", territory: "CA Orange" }) }
    );
    if (d.action === "triage") {
      expect(d.reason).toBe("not_serviced");
      expect(d.detail).toMatch(/CA Orange/);
    } else throw new Error(JSON.stringify(d));
  });

  it("falls back to the city when there is no zip map at all", () => {
    // A Salesforce blip returns an empty map. Routing degrades to what it did
    // before rather than refusing every lead in the batch.
    const d = decideIntake(
      { sfRecordId: "00QV", phone: "5168923401", state: "NY", locality: "Garden City", postalCode: "11530" },
      { ...ctx, territoryFor: () => null }
    );
    if (d.action === "route") expect(d.workspaceName).toBe("NY LI Nassau Leads");
    else throw new Error(JSON.stringify(d));
  });
})
