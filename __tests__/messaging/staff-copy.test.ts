import { describe, it, expect } from "vitest";
import {
  isBotAgentKey, agentLabel, BOT_LABEL, intentPhrase, plainLeadReason, plainHoldReason, untextableDigits,
} from "@/lib/messaging/staff-copy";

describe("who is holding it", () => {
  it("tells a bot's workflow key from a person", () => {
    expect(isBotAgentKey("lead_nurture")).toBe(true);
    expect(isBotAgentKey("followup")).toBe(true);
    expect(isBotAgentKey("Kate Smith")).toBe(false);
    expect(isBotAgentKey("kate@precisionpaintingplus.net")).toBe(false);
    expect(isBotAgentKey(null)).toBe(false);
  });
  it("says the bot where a key was, and leaves a person's name alone", () => {
    expect(agentLabel("lead_nurture")).toBe(BOT_LABEL);
    expect(agentLabel("lead_nurture", { workflow: true })).toBe("Emily, new leads");
    expect(agentLabel("some_new_job", { workflow: true })).toBe("Emily, some new job");
    expect(agentLabel("Kate Smith")).toBe("Kate Smith");
    expect(agentLabel("  ")).toBeNull();
  });
});

describe("what the bot is doing", () => {
  it("reads an intent as words, and never shows an underscore", () => {
    expect(intentPhrase("ask_project_details")).toBe("ask about the project");
    expect(intentPhrase("brand_new_intent")).toBe("brand new intent");
  });
});

describe("why a lead is held", () => {
  it("names the consent policy by what it does", () => {
    const r = plainLeadReason("no SMS consent is recorded on this lead, and SMS_REQUIRE_EXPRESS_CONSENT is on");
    expect(r).not.toMatch(/SMS_REQUIRE/);
    expect(r).toBe("No SMS consent is recorded on this lead, and PPP only texts leads who agreed to texts");
  });
  it("drops the reason code and keeps the detail", () => {
    expect(plainLeadReason("not_serviced: that zip is marked Out of Area")).toBe("Outside the area PPP serves: that zip is marked Out of Area");
    expect(plainLeadReason("region_not_live: CO Denver Leads is not switched on yet")).toBe("CO Denver Leads is not switched on yet");
    expect(plainLeadReason("no_matching_workspace: source=Meta state=— locality=—"))
      .toBe("No workspace matches where this lead came from: from Meta, with no state or town given");
    expect(plainLeadReason("no_matching_workspace: source=Google state=NY locality=—"))
      .toBe("No workspace matches where this lead came from: from Google, in NY");
  });
  it("corrects the old digit wording, including stored rows", () => {
    expect(plainLeadReason("no_contactable_phone: a 10-digit number, which is not one we can text"))
      .toBe("No phone we can text: 10 digits, but not a valid US number");
    expect(plainLeadReason("no_contactable_phone: a 8-digit number, which is not one we can text"))
      .toBe("No phone we can text: 8 digits, where a US number has 10");
  });
  it("never repeats a number an old row quoted", () => {
    const r = plainLeadReason('no_contactable_phone: "352621635520" is not a number we can text');
    expect(r).not.toMatch(/\d{4,}/);
  });
  it("reads a redrive hold, and leaves other holds as they are", () => {
    expect(plainHoldReason('"not_serviced: TX is outside the states PPP covers" will not answer differently'))
      .toBe("Outside the area PPP serves: TX is outside the states PPP covers. Retrying will not change that.");
    expect(plainHoldReason("older than the 24h limit")).toBe("Older than the 24h limit");
  });
  it("counts digits in English", () => {
    expect(untextableDigits(1, false)).toBe("1 digit, where a US number has 10");
    expect(untextableDigits(7, true)).toMatch(/country code/);
  });
});
