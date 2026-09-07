import { describe, it, expect, vi } from "vitest";
import { writeOptOutToSalesforce, fieldsFor, type SfMatch } from "@/lib/messaging/optout-writeback";
import type { E164 } from "@/lib/messaging/phone";

const PHONE = "+15168923401" as E164;
const LEAD: SfMatch = { sObject: "Lead", id: "00Q1", matchedOn: "phone" };
const CONTACT: SfMatch = { sObject: "Contact", id: "0031", matchedOn: "email" };

const deps = (over: Partial<Parameters<typeof writeOptOutToSalesforce>[2]> = {}) => ({
  findRecords: async () => [LEAD],
  setOptOut: async () => {},
  ...over,
});

describe("fieldsFor — writes what Kate's remove rules read", () => {
  it("sms sets only the SMS field", () => {
    expect(fieldsFor("sms")).toEqual({ SMS_Opt_In__c: "Opt-Out" });
  });
  it("email sets both email fields", () => {
    // Her rules check Email_Opt_In__c AND HasOptedOutOfEmail. Setting one
    // leaves a workflow able to pick them up through the other.
    expect(fieldsFor("email")).toEqual({ Email_Opt_In__c: "Opt-Out", HasOptedOutOfEmail: true });
  });
  it("both sets everything", () => {
    expect(Object.keys(fieldsFor("both"))).toHaveLength(3);
  });
});

describe("writeOptOutToSalesforce — the 55 it exists to prevent", () => {
  it("updates a matched record", async () => {
    const set = vi.fn();
    const r = await writeOptOutToSalesforce({ phone: PHONE, email: null }, "sms", deps({ setOptOut: set }));
    expect(r.status).toBe("written");
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("updates EVERY match, not just the first", async () => {
    // A person can be both a Lead and a Contact. Kate's rules read fields on
    // both, so updating one leaves the other able to re-enrol them.
    const set = vi.fn();
    const r = await writeOptOutToSalesforce(
      { phone: PHONE, email: "a@b.com" }, "both",
      deps({ findRecords: async () => [LEAD, CONTACT], setOptOut: set })
    );
    expect(set).toHaveBeenCalledTimes(2);
    expect(r.updated).toHaveLength(2);
  });
});

describe("writeOptOutToSalesforce — a miss is not a failure", () => {
  it("records no-match as PENDING, not failed", async () => {
    // 98 of the 213 had no Salesforce record because the person opted out
    // before one existed. Treating that as an error is what sent 213 emails
    // to info@ and lost 55 people.
    const r = await writeOptOutToSalesforce({ phone: PHONE, email: null }, "sms", deps({ findRecords: async () => [] }));
    expect(r.status).toBe("pending_no_record");
    expect(r.detail).toContain("suppression is already in effect");
  });

  it("distinguishes a lookup FAILURE from a lookup MISS", async () => {
    // One means Salesforce is down and should be retried. The other means
    // there is nothing to update. Collapsing them retries forever or gives up
    // on a real outage.
    const r = await writeOptOutToSalesforce(
      { phone: PHONE, email: null }, "sms",
      deps({ findRecords: async () => { throw new Error("SF 503"); } })
    );
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("SF 503");
  });

  it("refuses when there is nothing to match on", async () => {
    const r = await writeOptOutToSalesforce({ phone: null, email: null }, "sms", deps());
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("no phone or email");
  });
});

describe("writeOptOutToSalesforce — partial success stays visible", () => {
  it("reports the half that worked and the half that did not", async () => {
    // A Lead may update while a Contact fails on field permissions. Reporting
    // the whole thing as failed would hide a write that did happen and cause
    // it to be retried.
    const set = vi.fn(async (m: SfMatch) => {
      if (m.sObject === "Contact") throw new Error("insufficient access");
    });
    const r = await writeOptOutToSalesforce(
      { phone: PHONE, email: "a@b.com" }, "both",
      deps({ findRecords: async () => [LEAD, CONTACT], setOptOut: set })
    );
    expect(r.status).toBe("written");
    expect(r.updated).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain("insufficient access");
    expect(r.detail).toBe("updated 1, failed 1");
  });

  it("reports failed only when NOTHING was written", async () => {
    const r = await writeOptOutToSalesforce(
      { phone: PHONE, email: null }, "sms",
      deps({ setOptOut: async () => { throw new Error("nope"); } })
    );
    expect(r.status).toBe("failed");
    expect(r.updated).toHaveLength(0);
  });
});
