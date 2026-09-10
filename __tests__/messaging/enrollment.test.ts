import { describe, it, expect } from "vitest";
import { chooseWorkflow, shouldExit, type Workflow } from "@/lib/messaging/enrollment";
import type { Rule } from "@/lib/messaging/rules";

const NOW = new Date("2026-09-10T15:00:00Z");
const r = (field: string, operator: Rule["operator"], ...values: unknown[]): Rule =>
  ({ field, operator, values });

const wf = (o: Partial<Workflow> & { id: string; name: string }): Workflow => ({
  workspaceId: "w1", campaignId: "c1", isActive: true,
  entryRules: [r("RecordType", "in", "Web Inquiry")],
  exitRules: [r("IsConverted", "is_true")],
  ...o,
});

describe("which campaign a lead enters", () => {
  it("enters the one whose audience it matches", () => {
    const d = chooseWorkflow([wf({ id: "1", name: "Leads Master" })], { RecordType: "Web Inquiry" }, NOW);
    expect(d.enrol).toBe(true);
    if (d.enrol) expect(d.workflow.name).toBe("Leads Master");
  });

  it("ignores a workflow that is switched off", () => {
    const d = chooseWorkflow([wf({ id: "1", name: "Off", isActive: false })], { RecordType: "Web Inquiry" }, NOW);
    expect(d.enrol).toBe(false);
    if (!d.enrol) expect(d.reason).toMatch(/no active workflow/);
  });

  /**
   * A lead that silently did not enter a campaign is indistinguishable from
   * one the system never saw. That is the hardest thing to debug here, so the
   * reason names the rule that turned it away.
   */
  it("says which rule turned a lead away", () => {
    const d = chooseWorkflow([wf({ id: "1", name: "Leads Master" })], { RecordType: "Referral" }, NOW);
    expect(d.enrol).toBe(false);
    if (!d.enrol) expect(d.reason).toContain("RecordType is one of Web Inquiry");
  });

  /**
   * Two audiences matching one lead is a configuration mistake, not a runtime
   * choice. Picking one silently would hide it.
   */
  it("reports an overlap rather than hiding it", () => {
    const d = chooseWorkflow([
      wf({ id: "1", name: "First" }),
      wf({ id: "2", name: "Second" }),
    ], { RecordType: "Web Inquiry" }, NOW);
    expect(d.enrol).toBe(true);
    expect(d.alsoMatched).toEqual(["Second"]);
  });

  it("does not report an overlap when there is none", () => {
    const d = chooseWorkflow([wf({ id: "1", name: "Only" })], { RecordType: "Web Inquiry" }, NOW);
    expect(d.alsoMatched).toEqual([]);
  });

  it("enrols nobody when there are no workflows at all", () => {
    expect(chooseWorkflow([], { RecordType: "Web Inquiry" }, NOW).enrol).toBe(false);
  });
});

describe("when a conversation should stop", () => {
  it("stops when an exit rule fires, and says which", () => {
    const d = shouldExit(wf({ id: "1", name: "x" }), { IsConverted: true }, NOW);
    expect(d.exit).toBe(true);
    if (d.exit) expect(d.reason).toBe("IsConverted is true");
  });

  it("keeps going when none fire", () => {
    expect(shouldExit(wf({ id: "1", name: "x" }), { IsConverted: false }, NOW).exit).toBe(false);
  });

  it("keeps going when a workflow has no exit rules", () => {
    expect(shouldExit(wf({ id: "1", name: "x", exitRules: [] }), { IsConverted: true }, NOW).exit).toBe(false);
  });

  /** Kate's real remove rules: a booked appointment ends the chase. */
  it("stops once an appointment is on the record", () => {
    const w = wf({ id: "1", name: "x", exitRules: [r("Opportunity.AppointmentDate__c", "is_not_blank")] });
    expect(shouldExit(w, { Opportunity: { AppointmentDate__c: "2026-09-15" } }, NOW).exit).toBe(true);
    expect(shouldExit(w, { Opportunity: {} }, NOW).exit).toBe(false);
  });
});
