import { describe, it, expect } from "vitest";
import { leadStateFor, byConversation, batches, idList, EXIT_LEAD_FIELDS, EXIT_OPP_FIELDS } from "@/lib/messaging/exit-sweep";
import { shouldExit } from "@/lib/messaging/enrollment";
import { readField } from "@/lib/messaging/rules";
import type { LeadRecord } from "@/lib/messaging/rules";

/**
 * The shape the seeded exit rules are evaluated against.
 *
 * These are Kate's five "stop chasing" rules from migration 199, and every
 * field below was confirmed to exist in the live Salesforce org on
 * 2026-09-21 — including the picklist VALUES, because a rule that compares
 * Status to "Qualified" is worthless if the org spells it differently.
 */
const EXIT_RULES = [
    { ordinal: 1, field: "IsConverted", operator: "is_true" as const, values: [] },
    { ordinal: 2, field: "Status", operator: "in" as const, values: ["Qualified", "Unqualified"] },
    { ordinal: 3, field: "SMS_Opt_In__c", operator: "equals" as const, values: ["Opt-Out"] },
    { ordinal: 4, field: "Opportunity.AppointmentDate__c", operator: "is_not_blank" as const, values: [] },
    { ordinal: 5, field: "Opportunity.StageName", operator: "equals" as const, values: ["Opportunity Assigned"] },
];
const workflow = {
  id: "w", name: "Leads Master", workspaceId: "ws", campaignId: "c",
  entryRules: [], exitRules: EXIT_RULES, isActive: true,
} as unknown as Parameters<typeof shouldExit>[0];
const NOW = new Date("2026-09-21T16:00:00Z");

describe("the Opportunity is nested where the rules can see it", () => {
  it("puts a converted lead's opportunity under an Opportunity key", () => {
    const state = leadStateFor(
      [{ Id: "00Q1", Status: "Open", IsConverted: false, ConvertedOpportunityId: "0061" }],
      [{ Id: "0061", StageName: "Opportunity Assigned", AppointmentDate__c: "2026-09-25" }]
    );
    // Opportunity.* is not reachable from Lead in SOQL, so it is fetched
    // separately and nested here. readField walks the dotted path.
    expect(readField(state["00Q1"], "Opportunity.StageName")).toBe("Opportunity Assigned");
    expect(readField(state["00Q1"], "Opportunity.AppointmentDate__c")).toBe("2026-09-25");
  });

  it("leaves the key off entirely when there is no opportunity", () => {
    const state = leadStateFor([{ Id: "00Q1", Status: "Open", IsConverted: false }], []);
    // Absent, not an empty object: `is_not_blank` on a missing path must be
    // false, and an empty {} would still make the path resolvable.
    expect(readField(state["00Q1"], "Opportunity.AppointmentDate__c")).toBeUndefined();
    expect(shouldExit(workflow, state["00Q1"], NOW).exit).toBe(false);
  });

  it("ignores an opportunity id that came back with no record", () => {
    const state = leadStateFor([{ Id: "00Q1", ConvertedOpportunityId: "0061" }], []);
    expect(readField(state["00Q1"], "Opportunity.StageName")).toBeUndefined();
  });
});

describe("each of Kate's five reasons actually stops the chase", () => {
  const exits = (record: Record<string, unknown>) =>
    shouldExit(workflow, record as LeadRecord, NOW);

  it("a converted lead", () => {
    expect(exits({ Id: "1", IsConverted: true, Status: "Open" }).exit).toBe(true);
  });

  it("a lead marked Qualified — a real value in the org's picklist", () => {
    expect(exits({ Id: "1", Status: "Qualified" }).exit).toBe(true);
  });

  it("a lead marked Unqualified", () => {
    expect(exits({ Id: "1", Status: "Unqualified" }).exit).toBe(true);
  });

  it("somebody who opted out in Salesforce rather than by text", () => {
    expect(exits({ Id: "1", Status: "Open", SMS_Opt_In__c: "Opt-Out" }).exit).toBe(true);
  });

  it("AN APPOINTMENT ON THE BOOKS — the one that matters most", () => {
    // The whole point. An estimator books the job in Salesforce, nothing tells
    // us, and until the sweep existed the customer got chased anyway.
    const state = leadStateFor(
      [{ Id: "00Q1", Status: "Open", ConvertedOpportunityId: "0061" }],
      [{ Id: "0061", StageName: "Need Estimate", AppointmentDate__c: "2026-09-25T14:00:00Z" }]
    );
    expect(exits(state["00Q1"]).exit).toBe(true);
  });

  it("an opportunity assigned to somebody", () => {
    const state = leadStateFor(
      [{ Id: "00Q1", Status: "Open", ConvertedOpportunityId: "0061" }],
      [{ Id: "0061", StageName: "Opportunity Assigned", AppointmentDate__c: null }]
    );
    expect(exits(state["00Q1"]).exit).toBe(true);
  });

  it("leaves an ordinary open lead alone", () => {
    // The control. If this ever exits, the sweep silently stops every campaign.
    const state = leadStateFor(
      [{ Id: "00Q1", Status: "Open", IsConverted: false, SMS_Opt_In__c: "Opt-In (Form)" }],
      []
    );
    expect(exits(state["00Q1"]).exit).toBe(false);
  });

  it("leaves a lead whose opportunity is merely early alone", () => {
    const state = leadStateFor(
      [{ Id: "00Q1", Status: "Open", ConvertedOpportunityId: "0061" }],
      [{ Id: "0061", StageName: "Need Estimate", AppointmentDate__c: null }]
    );
    expect(exits(state["00Q1"]).exit).toBe(false);
  });
});

describe("re-keying Salesforce state by conversation", () => {
  const bySfId = { "00Q1": { Id: "00Q1" } as LeadRecord, "00Q2": { Id: "00Q2" } as LeadRecord };

  it("keys on the conversation, which is what the sweep asks for", () => {
    const out = byConversation([{ conversation_id: "c1", sf_record_id: "00Q1" }], bySfId);
    expect(out).toEqual({ c1: { Id: "00Q1" } });
  });

  it("skips a link with no conversation, rather than keying on null", () => {
    expect(byConversation([{ conversation_id: null, sf_record_id: "00Q1" }], bySfId)).toEqual({});
  });

  it("skips a lead Salesforce did not return", () => {
    // A deleted or inaccessible Lead must not become an exit decision made on
    // an empty record — every rule would read undefined and the chase would
    // continue, which is the safe direction, but the row should not be there.
    expect(byConversation([{ conversation_id: "c9", sf_record_id: "00Q9" }], bySfId)).toEqual({});
  });
});

describe("the SOQL this builds", () => {
  it("batches ids rather than sending one enormous IN list", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);
    expect(batches(ids).map((b) => b.length)).toEqual([200, 200, 50]);
  });

  it("quotes ids and drops anything that is not an id", () => {
    expect(idList(["00Q1000000000001"])).toBe("'00Q1000000000001'");
    // Not escaping — refusing. Nothing shaped like an injection reaches SOQL.
    expect(idList(["00Q1000000000001", "' OR Id != '"])).toBe("'00Q1000000000001'");
    expect(idList(["short"])).toBe("");
  });

  it("asks for exactly the fields the rules read", () => {
    for (const f of ["Status", "IsConverted", "SMS_Opt_In__c", "ConvertedOpportunityId"]) {
      expect(EXIT_LEAD_FIELDS).toContain(f);
    }
    for (const f of ["StageName", "AppointmentDate__c"]) {
      expect(EXIT_OPP_FIELDS).toContain(f);
    }
  });
});
