import { describe, it, expect } from "vitest";
import {
  evaluateRule, matchesAll, matchesAny, readField, isBlank,
  firstFailing, firstMatching, describeRule, type Rule,
} from "@/lib/messaging/rules";

const NOW = new Date("2026-09-10T15:00:00Z");
const r = (field: string, operator: Rule["operator"], ...values: unknown[]): Rule =>
  ({ field, operator, values });

/** Kate's real CA LA audience, as she has it in Hatch. */
const ENTRY: Rule[] = [
  r("RecordType", "in", "Web Inquiry", "Phone Inquiry"),
  r("LeadSource", "not_in", "Angi", "Thumbtack"),
  r("CreatedDate", "on_date", "today"),
];

describe("entry rules", () => {
  it("lets through a lead that satisfies every rule", () => {
    expect(matchesAll(ENTRY, {
      RecordType: "Web Inquiry", LeadSource: "Google", CreatedDate: NOW.toISOString(),
    }, NOW)).toBe(true);
  });

  it("keeps out a lead that fails one", () => {
    expect(matchesAll(ENTRY, {
      RecordType: "Web Inquiry", LeadSource: "Thumbtack", CreatedDate: NOW.toISOString(),
    }, NOW)).toBe(false);
  });

  /**
   * The point of "Lead Source not in (Angi, Thumbtack)". A lead with no source
   * recorded is not an Angi lead, and belongs in the campaign.
   */
  it("treats a missing field as not being in a list", () => {
    expect(evaluateRule(r("LeadSource", "not_in", "Angi"), {}, NOW)).toBe(true);
    expect(evaluateRule(r("LeadSource", "in", "Angi"), {}, NOW)).toBe(false);
  });

  it("does not care about capitalisation Salesforce might send", () => {
    expect(evaluateRule(r("RecordType", "in", "Web Inquiry"), { RecordType: "web inquiry" }, NOW)).toBe(true);
    expect(evaluateRule(r("RecordType", "equals", "Web Inquiry"), { RecordType: "WEB INQUIRY " }, NOW)).toBe(true);
  });

  /**
   * An empty audience would enrol every lead in the system. That is never what
   * an unfinished form meant.
   */
  it("matches nothing when there are no rules at all", () => {
    expect(matchesAll([], { anything: "yes" }, NOW)).toBe(false);
  });

  it("names the rule that stopped it", () => {
    const failing = firstFailing(ENTRY, { RecordType: "Web Inquiry", LeadSource: "Angi" }, NOW);
    expect(failing?.field).toBe("LeadSource");
    expect(describeRule(failing!)).toBe("LeadSource is not one of Angi, Thumbtack");
  });
});

describe("exit rules", () => {
  /** Kate's Lead Remove Rules, read the other way: any one means stop. */
  const EXIT: Rule[] = [
    r("IsConverted", "is_true"),
    r("Status", "in", "Qualified", "Unqualified"),
    r("Opportunity.AppointmentDate__c", "is_not_blank"),
  ];

  it("stops the moment any single rule matches", () => {
    expect(matchesAny(EXIT, { IsConverted: true }, NOW)).toBe(true);
    expect(matchesAny(EXIT, { Status: "Qualified" }, NOW)).toBe(true);
  });

  it("keeps going when none do", () => {
    expect(matchesAny(EXIT, { IsConverted: false, Status: "Open" }, NOW)).toBe(false);
  });

  it("reads a booked appointment through a dotted path", () => {
    expect(matchesAny(EXIT, { Opportunity: { AppointmentDate__c: "2026-09-15" } }, NOW)).toBe(true);
  });

  it("reads it when the payload arrives already flattened", () => {
    // Salesforce sends both shapes; treating the flat one as a miss would fail
    // every rule about an Opportunity.
    expect(readField({ "Opportunity.StageName": "Assigned" }, "Opportunity.StageName")).toBe("Assigned");
  });

  it("names the rule that fired", () => {
    expect(describeRule(firstMatching(EXIT, { IsConverted: true }, NOW)!)).toBe("IsConverted is true");
  });
});

describe("the operators, at their edges", () => {
  it("understands the strings Salesforce uses for booleans", () => {
    for (const v of [true, "true", "TRUE", "1", "yes"]) {
      expect(evaluateRule(r("x", "is_true"), { x: v }, NOW), String(v)).toBe(true);
    }
    for (const v of [false, "false", "0", "no", "", null, undefined]) {
      expect(evaluateRule(r("x", "is_false"), { x: v }, NOW), String(v)).toBe(true);
    }
  });

  it("treats whitespace as blank", () => {
    expect(isBlank("   ")).toBe(true);
    expect(isBlank("")).toBe(true);
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank("x")).toBe(false);
    expect(isBlank(0)).toBe(false);
  });

  it("matches today, and only today", () => {
    expect(evaluateRule(r("d", "on_date", "today"), { d: "2026-09-10T23:59:00Z" }, NOW)).toBe(true);
    expect(evaluateRule(r("d", "on_date", "today"), { d: "2026-09-09T23:59:00Z" }, NOW)).toBe(false);
  });

  it("refuses a date it cannot read rather than guessing", () => {
    expect(evaluateRule(r("d", "on_date", "today"), { d: "not a date" }, NOW)).toBe(false);
    expect(evaluateRule(r("d", "within_days", 7), { d: "" }, NOW)).toBe(false);
  });

  it("counts a window backwards from now", () => {
    expect(evaluateRule(r("d", "within_days", 7), { d: "2026-09-05T00:00:00Z" }, NOW)).toBe(true);
    expect(evaluateRule(r("d", "within_days", 7), { d: "2026-08-01T00:00:00Z" }, NOW)).toBe(false);
  });

  it("counts a slightly-future date as within the window", () => {
    // A clock a minute fast is not a lead older than the window.
    expect(evaluateRule(r("d", "within_days", 7), { d: "2026-09-10T15:01:00Z" }, NOW)).toBe(true);
  });

  it("does substring matching without minding case", () => {
    expect(evaluateRule(r("s", "contains", "kitchen"), { s: "The KITCHEN and hall" }, NOW)).toBe(true);
    expect(evaluateRule(r("s", "not_contains", "kitchen"), { s: "The hall" }, NOW)).toBe(true);
  });
});
