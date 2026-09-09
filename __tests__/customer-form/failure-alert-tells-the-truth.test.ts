import { describe, it, expect } from "vitest";
import { renderSfFailureAlert, type SfFailureAlertInput } from "@/lib/customer-form/sf-failure-alert";

/**
 * WO #00317112, 2026-09-09. Katie forwarded this alert. It said Salesforce
 * "does not have it" and to re-enter — but the audit log and Salesforce both
 * show the colors DID land on the line item at 18:15:02; only the
 * ColorsReceived__c flag on the WorkOrder failed at 18:15:08.
 *
 * Acting on that email means re-entering colors that are already in Salesforce.
 */
const INCIDENT: SfFailureAlertInput = {
  workOrderId: "0WOWj000007yzPaOAI",
  workOrderNumber: "00317112",
  customerName: "Test Testing",
  saverUserId: null,
  entered: [
    {
      room: "Living Room",
      surfaces: [
        { surface: "Walls", color: "2013-50 Salmon Peach", finish: "Eggshell" },
        { surface: "Ceiling", color: "01 White", finish: "Flat" },
        { surface: "Trim", color: "01 White", finish: "Semi-Gloss" },
        { surface: "Accent Wall", color: "OC-52 Gray Owl", finish: "Eggshell" },
      ],
    },
  ],
  attemptedCount: 2,
  failedCount: 1,
  errorCode: "SF_CLIENT_INIT_FAILED",
  errorMessage: "Failed to read SF credentials: Gateway Timeout",
  kind: "colors",
};

describe("the Salesforce failure alert tells the truth", () => {
  it("does not claim Salesforce has nothing when one write succeeded", () => {
    const { html, text } = renderSfFailureAlert(INCIDENT);

    expect(html).not.toContain("Salesforce does not have it");
    expect(text).not.toContain("NOT in Salesforce");
    // and it says so positively, in both halves
    expect(html).toContain("IS in Salesforce already");
    expect(text).toContain("SUCCEEDED");
  });

  it("warns against blind re-entry on a partial failure", () => {
    const { html, text } = renderSfFailureAlert(INCIDENT);
    expect(html).toContain("Check Salesforce before re-entering");
    expect(text).toContain("Check before re-entering");
    expect(html).not.toContain("nothing is lost");
  });

  it("does not blame permissions or validation rules for a timeout", () => {
    const { html, text } = renderSfFailureAlert(INCIDENT);
    for (const wrong of ["missing Edit permission", "validation rule", "Field Service Lightning"]) {
      expect(html, wrong).not.toContain(wrong);
      expect(text, wrong).not.toContain(wrong);
    }
    expect(html).toContain("connection timeout");
  });

  it("still says 're-enter it' when EVERY write genuinely failed", () => {
    const total = { ...INCIDENT, failedCount: 2, attemptedCount: 2 };
    const { html, text } = renderSfFailureAlert(total);

    expect(html).toContain("Salesforce does not have it");
    expect(html).toContain("nothing is lost");
    expect(text).toContain("NOT in Salesforce");
  });

  it("still blames the right things for a REAL Salesforce rejection", () => {
    const rejected = {
      ...INCIDENT,
      failedCount: 2,
      errorCode: "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
      errorMessage: "FIELD_CUSTOM_VALIDATION_EXCEPTION: Colors must be set",
    };
    const { html } = renderSfFailureAlert(rejected);
    expect(html).toContain("validation rule");
    expect(html).not.toContain("connection timeout");
  });

  it("keeps every color the worker entered, so the email is still a usable record", () => {
    const { html, text } = renderSfFailureAlert(INCIDENT);
    for (const c of ["2013-50 Salmon Peach", "01 White", "OC-52 Gray Owl", "Accent Wall"]) {
      expect(html, c).toContain(c);
      expect(text, c).toContain(c);
    }
  });
});
