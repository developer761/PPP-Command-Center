import { describe, it, expect } from "vitest";
import { leadFromSalesforce, stateCode, LEAD_FIELDS } from "@/lib/messaging/lead-map";
import { firstMessageAt, scheduleSteps, FIRST_MESSAGE_WINDOW, type CampaignStep } from "@/lib/messaging/campaign-schedule";
import { TICK_SECONDS } from "@/lib/messaging/reply-delay";
import { matchesAll, type Rule } from "@/lib/messaging/rules";

describe("a Salesforce Lead, as intake needs it", () => {
  const sf = {
    Id: "00Q000000000001", Name: "Pat Rivera", FirstName: "Pat",
    Phone: "(516) 555-2201", MobilePhone: "(516) 555-3302", Email: "pat@example.com",
    LeadSource: "Meta", State: "New York", City: "Garden City",
    RecordType: { Name: "Web Inquiry" }, CreatedDate: "2026-09-15T14:00:00.000+0000",
    Status: "Open", IsConverted: false, SMS_Opt_In__c: null, LeadGroup__c: null,
  };

  it("texts the mobile number, not the landline", () => {
    expect(leadFromSalesforce(sf).lead.phone).toBe("(516) 555-3302");
    expect(leadFromSalesforce({ ...sf, MobilePhone: null }).lead.phone).toBe("(516) 555-2201");
  });

  it("gives routing a two-letter state and the city", () => {
    const { lead } = leadFromSalesforce(sf);
    expect(lead.state).toBe("NY");
    expect(lead.locality).toBe("Garden City");
    expect(stateCode("ny")).toBe("NY");
    expect(stateCode("Nowhere")).toBeNull();
  });

  it("flattens RecordType to the name the seeded entry rule compares", () => {
    const { record } = leadFromSalesforce(sf);
    const rule: Rule = { field: "RecordType", operator: "in", values: ["Web Inquiry", "Phone Inquiry"] };
    expect(matchesAll([rule], record, new Date())).toBe(true);
    expect(matchesAll([rule], leadFromSalesforce({ ...sf, RecordType: { Name: "Partner Basic" } }).record, new Date())).toBe(false);
  });

  it("asks Salesforce for every field it reads", () => {
    for (const f of ["MobilePhone", "RecordType.Name", "CreatedDate", "LeadSource", "SMS_Opt_In__c"]) {
      expect(LEAD_FIELDS).toContain(f);
    }
  });
});

describe("the first message goes 2 to 5 minutes after the lead was created", () => {
  const created = new Date("2026-09-15T14:00:00Z");

  it("lands inside the window even when the tick picks it up a full tick late", () => {
    for (let i = 0; i < 2000; i++) {
      const at = firstMessageAt({ leadCreatedAt: created, now: created, tickSeconds: TICK_SECONDS });
      const s = (at.getTime() - created.getTime()) / 1000;
      expect(s).toBeGreaterThanOrEqual(FIRST_MESSAGE_WINDOW.minSeconds);
      expect(s + TICK_SECONDS).toBeLessThanOrEqual(FIRST_MESSAGE_WINDOW.maxSeconds);
    }
  });

  it("counts from Salesforce's CreatedDate, so the poll's lag is inside the window", () => {
    const noticed = new Date(created.getTime() + 60_000);
    const at = firstMessageAt({ leadCreatedAt: created, now: noticed, tickSeconds: TICK_SECONDS, rand: () => 0.5 });
    const fromCreated = (at.getTime() - created.getTime()) / 1000;
    expect(fromCreated).toBeGreaterThanOrEqual(120);
    expect(fromCreated).toBeLessThanOrEqual(290);
  });

  it("never schedules in the past for a lead noticed late", () => {
    const late = new Date(created.getTime() + 20 * 60_000);
    const at = firstMessageAt({ leadCreatedAt: created, now: late, tickSeconds: TICK_SECONDS });
    expect(at.getTime()).toBe(late.getTime());
  });

  it("moves only the opener; later steps stack on it", () => {
    const steps: CampaignStep[] = [
      { ordinal: 1, scheduleMode: "at_launch", delayMinutes: null, dayOffset: null, timeOfDay: null, channel: "sms", body: "hi", subject: null },
      { ordinal: 2, scheduleMode: "delay_after_last", delayMinutes: 30, dayOffset: null, timeOfDay: null, channel: "email", body: "b", subject: "s" },
    ];
    const launchAt = new Date(created.getTime() + 180_000);
    const [a, b] = scheduleSteps(steps, created, "America/New_York", { launchAt });
    expect(a.runAt.getTime()).toBe(launchAt.getTime());
    expect(b.runAt.getTime()).toBe(launchAt.getTime() + 30 * 60_000);
  });
});
