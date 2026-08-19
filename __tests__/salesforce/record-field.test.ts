import { describe, it, expect } from "vitest";
import { sfField, sfString, sfDate } from "@/lib/salesforce/record-field";

/**
 * R4.34. SOQL field names are case-insensitive; the JSON keys are not. So a
 * query written with the wrong casing SUCCEEDS and then every property read
 * returns undefined — and the standard "catch INVALID_FIELD and retry the other
 * casing" guard never fires, because nothing errored.
 *
 * The Mail Hub follow-up filter died on exactly this and reported as "returns
 * nothing on any date" twice. The record below is the real shape the live org
 * returns when queried with the wrong casing.
 */
const REAL_RESPONSE = {
  attributes: { type: "WorkOrder" },
  Id: "0WOWj000007AwUvOAK",
  FollowUpDate__c: "2026-08-14",
};

describe("sfField", () => {
  it("finds the value however the caller cased the name", () => {
    expect(sfField(REAL_RESPONSE, "FollowUpDate__c")).toBe("2026-08-14");
    // The casing that silently returned undefined for months.
    expect(sfField(REAL_RESPONSE, "FollowupDate__c")).toBe("2026-08-14");
    expect(sfField(REAL_RESPONSE, "followupdate__c")).toBe("2026-08-14");
  });

  it("prefers an exact match when both could apply", () => {
    const odd = { Foo__c: "exact", foo__c: "loose" };
    expect(sfField(odd, "Foo__c")).toBe("exact");
    expect(sfField(odd, "foo__c")).toBe("loose");
  });

  it("returns undefined for a field that genuinely isn't there", () => {
    expect(sfField(REAL_RESPONSE, "Nope__c")).toBeUndefined();
    expect(sfField(null, "Whatever__c")).toBeUndefined();
    expect(sfField(undefined, "Whatever__c")).toBeUndefined();
  });

  it("narrows to a usable string", () => {
    expect(sfString(REAL_RESPONSE, "FollowupDate__c")).toBe("2026-08-14");
    // Salesforce sends null for an empty field; callers want null, not "null".
    expect(sfString({ A__c: null }, "A__c")).toBeNull();
    expect(sfString({ A__c: "" }, "A__c")).toBeNull();
    expect(sfString({ A__c: 42 }, "A__c")).toBeNull();
  });

  it("trims a datetime down to the date", () => {
    expect(sfDate(REAL_RESPONSE, "FollowupDate__c")).toBe("2026-08-14");
    expect(sfDate({ D__c: "2026-08-14T00:00:00.000+0000" }, "D__c")).toBe("2026-08-14");
    expect(sfDate({ D__c: null }, "D__c")).toBeNull();
  });
});
