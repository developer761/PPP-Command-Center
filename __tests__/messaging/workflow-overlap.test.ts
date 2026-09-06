import { describe, it, expect } from "vitest";
import { rulesAreDisjoint, findOverlaps, type Rule } from "@/lib/messaging/workflow-overlap";

/** Kate's real CA LA audiences, as rules. */
const SF_LEADS: Rule[] = [
  { field: "RecordType", operator: "in", values: ["Web Inquiry", "Phone Inquiry"] },
  { field: "LeadSource", operator: "not_in", values: ["Angi", "Thumbtack", "Strategic Outreach"] },
  { field: "CreatedDate", operator: "within_days", values: [1] },
];
const THUMBTACK: Rule[] = [
  { field: "LeadSource", operator: "in", values: ["Thumbtack"] },
  { field: "CreatedDate", operator: "within_days", values: [1] },
];
const ANGI: Rule[] = [
  { field: "LeadSource", operator: "in", values: ["Angi"] },
  { field: "CreatedDate", operator: "within_days", values: [1] },
];

describe("PPP's real audiences", () => {
  it("proves SF Leads and Thumbtack cannot take the same lead", () => {
    // The SF audience explicitly excludes Thumbtack, which is what makes them
    // safe to run in one workspace.
    const v = rulesAreDisjoint(SF_LEADS, THUMBTACK);
    expect(v.disjoint).toBe(true);
    if (v.disjoint) expect(v.because).toContain("LeadSource");
  });

  it("proves SF Leads and Angi cannot take the same lead", () => {
    expect(rulesAreDisjoint(SF_LEADS, ANGI).disjoint).toBe(true);
  });

  it("proves Thumbtack and Angi cannot take the same lead", () => {
    expect(rulesAreDisjoint(THUMBTACK, ANGI).disjoint).toBe(true);
  });

  it("finds no overlap across all three together", () => {
    // This is the configuration PPP runs today. It should come back clean.
    expect(findOverlaps([
      { id: "1", name: "SF Leads", rules: SF_LEADS },
      { id: "2", name: "Thumbtack", rules: THUMBTACK },
      { id: "3", name: "Angi", rules: ANGI },
    ])).toEqual([]);
  });
});

describe("the double-message bug it exists to catch", () => {
  it("flags two workflows that both take Meta leads", () => {
    const a: Rule[] = [{ field: "LeadSource", operator: "in", values: ["Meta"] }];
    const b: Rule[] = [{ field: "LeadSource", operator: "in", values: ["Meta", "Google"] }];
    expect(rulesAreDisjoint(a, b).disjoint).toBe(false);
  });

  it("flags an empty rule set, because it matches every lead", () => {
    const v = rulesAreDisjoint([], THUMBTACK);
    expect(v.disjoint).toBe(false);
    if (!v.disjoint) expect(v.reason).toBe("empty_ruleset");
  });

  it("flags workflows separated only by a field one of them ignores", () => {
    // A constrains RecordType, B says nothing about it. B takes everything A
    // takes, plus more.
    const a: Rule[] = [{ field: "RecordType", operator: "equals", values: ["Web Inquiry"] }];
    const b: Rule[] = [{ field: "LeadSource", operator: "in", values: ["Meta"] }];
    expect(rulesAreDisjoint(a, b).disjoint).toBe(false);
  });
});

describe("what counts as proof", () => {
  it("two positive constraints with nothing in common", () => {
    const a: Rule[] = [{ field: "State", operator: "in", values: ["NY", "NJ"] }];
    const b: Rule[] = [{ field: "State", operator: "in", values: ["FL", "CA"] }];
    expect(rulesAreDisjoint(a, b).disjoint).toBe(true);
  });

  it("does NOT claim proof when the value sets merely partly differ", () => {
    const a: Rule[] = [{ field: "State", operator: "in", values: ["NY", "NJ"] }];
    const b: Rule[] = [{ field: "State", operator: "in", values: ["NJ", "FL"] }];
    // NJ satisfies both. Getting this wrong double-texts every NJ lead.
    expect(rulesAreDisjoint(a, b).disjoint).toBe(false);
  });

  it("positive against an exclusion that covers it", () => {
    const a: Rule[] = [{ field: "LeadSource", operator: "in", values: ["Angi"] }];
    const b: Rule[] = [{ field: "LeadSource", operator: "not_in", values: ["Angi", "Yelp"] }];
    expect(rulesAreDisjoint(a, b).disjoint).toBe(true);
  });

  it("does NOT claim proof when the exclusion only PARTLY covers it", () => {
    const a: Rule[] = [{ field: "LeadSource", operator: "in", values: ["Angi", "Meta"] }];
    const b: Rule[] = [{ field: "LeadSource", operator: "not_in", values: ["Angi"] }];
    // A Meta lead satisfies both.
    expect(rulesAreDisjoint(a, b).disjoint).toBe(false);
  });

  it("blank against not-blank, and true against false", () => {
    expect(rulesAreDisjoint(
      [{ field: "Opportunity.AppointmentDate__c", operator: "is_blank", values: [] }],
      [{ field: "Opportunity.AppointmentDate__c", operator: "is_not_blank", values: [] }],
    ).disjoint).toBe(true);
    expect(rulesAreDisjoint(
      [{ field: "IsConverted", operator: "is_true", values: [] }],
      [{ field: "IsConverted", operator: "is_false", values: [] }],
    ).disjoint).toBe(true);
  });

  it("refuses to claim proof from contains or date windows", () => {
    // Substring and date logic can look separate and overlap in practice. A
    // wrong "safe" here texts somebody twice, so it stays unproven.
    expect(rulesAreDisjoint(
      [{ field: "Campaign", operator: "contains", values: ["Nassau"] }],
      [{ field: "Campaign", operator: "contains", values: ["Suffolk"] }],
    ).disjoint).toBe(false);
    expect(rulesAreDisjoint(
      [{ field: "CreatedDate", operator: "within_days", values: [1] }],
      [{ field: "CreatedDate", operator: "within_days", values: [7] }],
    ).disjoint).toBe(false);
  });

  it("is case and whitespace insensitive on values", () => {
    // Salesforce picklists arrive inconsistently cased. Treating "Meta" and
    // "meta" as different would report a false all-clear.
    const a: Rule[] = [{ field: "LeadSource", operator: "in", values: ["Meta"] }];
    const b: Rule[] = [{ field: "leadsource", operator: "in", values: [" meta "] }];
    expect(rulesAreDisjoint(a, b).disjoint).toBe(false);
  });
});

describe("findOverlaps reports every unsafe pair", () => {
  it("names both workflows and why", () => {
    const pairs = findOverlaps([
      { id: "1", name: "Meta NY", rules: [{ field: "LeadSource", operator: "in", values: ["Meta"] }] },
      { id: "2", name: "All NY", rules: [{ field: "State", operator: "equals", values: ["NY"] }] },
      { id: "3", name: "Angi NY", rules: [{ field: "LeadSource", operator: "in", values: ["Angi"] }] },
    ]);
    // Meta/Angi are separable. Both overlap "All NY", which constrains a
    // different field entirely.
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.a.name === "All NY" || p.b.name === "All NY")).toBe(true);
    expect(pairs[0].reason).toContain("could qualify for both");
  });
});
