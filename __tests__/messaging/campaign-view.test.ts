import { describe, it, expect } from "vitest";
import { describeAudience, clauseFor, timingOf, campaignWarnings } from "@/lib/messaging/campaign-view";
import type { Rule } from "@/lib/messaging/rules";
import type { CampaignStep } from "@/lib/messaging/campaign-schedule";

const r = (field: string, operator: Rule["operator"], ...values: unknown[]): Rule => ({ field, operator, values });
const step = (o: Partial<CampaignStep> & { ordinal: number }): CampaignStep => ({
  scheduleMode: "at_launch", delayMinutes: null, dayOffset: null, timeOfDay: null,
  channel: "sms", body: "Hello. Reply STOP to opt out.", subject: null, ...o,
});

describe("an audience, in words", () => {
  /** Kate's real CA LA audience. */
  it("reads Kate's audience as a sentence", () => {
    const s = describeAudience([
      r("RecordType", "in", "Web Inquiry", "Phone Inquiry"),
      r("LeadSource", "not_in", "Angi", "Thumbtack", "Google LSA"),
      r("CreatedDate", "on_date", "today"),
    ], "entry");
    expect(s).toBe(
      "The record type is Web Inquiry or Phone Inquiry, " +
      "the lead source is not Angi, Thumbtack or Google LSA and it was created today."
    );
  });

  /** Exit rules are ANY, not ALL, and the sentence has to say so. */
  it("joins exit rules with or, because any one of them stops it", () => {
    const s = describeAudience([
      r("IsConverted", "is_true"),
      r("Opportunity.AppointmentDate__c", "is_not_blank"),
    ], "exit");
    expect(s).toContain(" or ");
    expect(s).not.toContain(" and ");
  });

  it("says plainly that an empty audience matches nobody", () => {
    expect(describeAudience([], "entry")).toMatch(/Nobody/);
    expect(describeAudience([], "exit")).toMatch(/runs to the end/);
  });

  it("does not read like a log line", () => {
    // describeRule says "LeadSource is not one of Angi, Thumbtack", which is
    // accurate and nobody speaks it.
    expect(clauseFor(r("LeadSource", "not_in", "Angi"))).toBe("the lead source is not Angi");
    expect(clauseFor(r("Opportunity.AppointmentDate__c", "is_not_blank"))).toBe("there is an appointment date");
  });
});

describe("when each message goes, in words", () => {
  it("describes each mode the way somebody would ask about it", () => {
    expect(timingOf(step({ ordinal: 1 }))).toBe("2–5 min after the lead comes in");
    expect(timingOf(step({ ordinal: 2, scheduleMode: "delay_after_last", delayMinutes: 30 }))).toBe("30 minutes later");
    expect(timingOf(step({ ordinal: 3, scheduleMode: "delay_after_last", delayMinutes: 2880 }))).toBe("2 days later");
    expect(timingOf(step({ ordinal: 4, scheduleMode: "absolute_on_day", dayOffset: 1, timeOfDay: "10:00" }))).toBe("Next day at 10am");
    expect(timingOf(step({ ordinal: 5, scheduleMode: "absolute_on_day", dayOffset: 3, timeOfDay: "14:30" }))).toBe("Day 3 at 2:30pm");
  });
});

describe("what is wrong with a campaign, before anybody turns it on", () => {
  /**
   * The one that nearly shipped: the opener said "Call us at
   * {{workspace_phone}}" and nothing filled it in.
   */
  it("blocks on a blank nobody fills in", () => {
    const w = campaignWarnings([step({ ordinal: 1, body: "Call {{the_boss}}." })], { workspaceCount: 3 });
    expect(w[0].severity).toBe("blocking");
    expect(w[0].message).toContain("{{the_boss}}");
  });

  /**
   * Found by rendering the real seeded campaign: {{workspace_phone}} in a
   * stored body is correct and deliberate — it is filled per workspace at send
   * time — and flagging it made a healthy campaign unpublishable.
   */
  it("does not flag a placeholder the system fills at send time", () => {
    const w = campaignWarnings(
      [step({ ordinal: 1, body: "Call us at {{workspace_phone}}. Reply STOP to opt out." })],
      { workspaceCount: 3 }
    );
    expect(w).toEqual([]);
  });

  it("blocks on an email with no subject", () => {
    const w = campaignWarnings([step({ ordinal: 1, channel: "email", subject: "  " })], { workspaceCount: 3 });
    expect(w.some((x) => x.severity === "blocking" && /subject/.test(x.message))).toBe(true);
  });

  it("blocks a campaign no workspace uses", () => {
    const w = campaignWarnings([step({ ordinal: 1 })], { workspaceCount: 0 });
    expect(w.some((x) => x.severity === "blocking" && /nobody would ever receive/.test(x.message))).toBe(true);
  });

  it("blocks a campaign with no messages", () => {
    expect(campaignWarnings([], { workspaceCount: 3 })[0].severity).toBe("blocking");
  });

  it("mentions what a long text will cost", () => {
    const w = campaignWarnings([step({ ordinal: 1, body: "x".repeat(500) })], { workspaceCount: 1 });
    expect(w.some((x) => /4 texts/.test(x.message))).toBe(true);
  });

  it("points out a step timed outside sending hours", () => {
    const w = campaignWarnings(
      [step({ ordinal: 1, scheduleMode: "absolute_on_day", dayOffset: 1, timeOfDay: "06:00" })],
      { workspaceCount: 1, sendWindow: { startHour: 9, endHour: 20 } }
    );
    expect(w.some((x) => /outside sending hours/.test(x.message))).toBe(true);
  });

  it("says nothing about hours when a step is inside them", () => {
    const w = campaignWarnings(
      [step({ ordinal: 1, scheduleMode: "absolute_on_day", dayOffset: 1, timeOfDay: "10:00" })],
      { workspaceCount: 1, sendWindow: { startHour: 9, endHour: 20 } }
    );
    expect(w.some((x) => /outside sending hours/.test(x.message))).toBe(false);
  });

  it("notes when the first text does not say how to stop", () => {
    const w = campaignWarnings([step({ ordinal: 1, body: "Hello there." })], { workspaceCount: 1 });
    expect(w.some((x) => /opt out/.test(x.message))).toBe(true);
  });

  it("stays quiet when the first text already says it", () => {
    const w = campaignWarnings([step({ ordinal: 1, body: "Hello. Reply END to stop texts." })], { workspaceCount: 1 });
    expect(w.some((x) => /opt out/.test(x.message))).toBe(false);
  });

  it("finds nothing wrong with a healthy campaign", () => {
    expect(campaignWarnings([step({ ordinal: 1 })], { workspaceCount: 12 })).toEqual([]);
  });
});

/**
 * ── THE OPT-OUT WARNING, AFTER TWO AUDITS DISAGREED WITH IT ─────────────
 *
 * Two things were wrong with this warning and both were found by reviewing a
 * feature that was then abandoned, which is the main reason to keep them:
 *
 *   1. This panel had its OWN opt-out regex, narrower than the one the editor
 *      checklist and the gate's append use. "STOP to unsubscribe" passed one
 *      screen and was flagged by the other, simultaneously.
 *   2. It said the gate "adds it automatically". The append is conditional on
 *      hasEverSent(to) — has PPP ever texted this handset, in ANY workspace —
 *      so a returning lead gets no appended disclosure. The sentence talked
 *      somebody out of fixing a compliance line on the opener.
 */
describe("the opt-out warning agrees with every other screen", () => {
  const step = (body: string) => ({
    ordinal: 1, scheduleMode: "at_launch" as const, delayMinutes: null,
    dayOffset: null, timeOfDay: null, channel: "sms" as const, body, subject: null,
  });
  const msgs = (body: string) =>
    campaignWarnings([step(body)], { workspaceCount: 1 }).map((w) => w.message);

  it.each([
    "Hi, it's Emily at Precision Painting Plus. Reply STOP to opt out.",
    // The one the two screens used to disagree about.
    "Hi, it's Emily at Precision Painting Plus. Text HELP for help, STOP to unsubscribe.",
    'Hi, it\'s Emily at Precision Painting Plus. Reply "STOP" to opt out.',
  ])("accepts %j, the same as the editor checklist does", (body) => {
    expect(msgs(body).some((m) => /opt out/i.test(m))).toBe(false);
  });

  it("still flags an opener that says nothing about stopping", () => {
    expect(msgs("Hi, it's Emily at Precision Painting Plus.").some((m) => /opt out/i.test(m)))
      .toBe(true);
  });

  it("does not claim the gate always appends it", () => {
    // It only appends for a number PPP has never texted. Saying otherwise on
    // a compliance warning is worse than saying nothing.
    const warning = msgs("Hi, it's Emily at Precision Painting Plus.").find((m) => /opt out/i.test(m));
    expect(warning).not.toMatch(/adds it automatically/i);
    expect(warning).toMatch(/never texted before/i);
  });
});
