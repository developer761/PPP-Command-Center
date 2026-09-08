import { describe, it, expect } from "vitest";
import { buildOptOutPreview, toOptOutRecords } from "@/lib/messaging/optout-import";

describe("importing Hatch's suppression list", () => {
  it("reads phone and email columns whatever they are called", () => {
    const p = buildOptOutPreview("Phone Number,Email Address\n(516) 344-8418,A@Example.COM\n");
    expect(p.usable).toBe(1);
    expect(p.rows[0].phone).toBe("+15163448418");
    expect(p.rows[0].email).toBe("a@example.com");
  });

  /** 92 of Kate's 213 were email-only. A phone-only importer drops all of them. */
  it("keeps email-only rows and counts them", () => {
    const p = buildOptOutPreview("phone,email\n,someone@example.com\n");
    expect(p.usable).toBe(1);
    expect(p.emailOnly).toBe(1);
    expect(toOptOutRecords(p)[0].channel).toBe("email");
  });

  it("suppresses SMS for a row that has a phone", () => {
    const p = buildOptOutPreview("phone\n+15163448418\n");
    expect(toOptOutRecords(p)[0].channel).toBe("sms");
  });

  it("shows an unreadable phone as a problem rather than silently dropping it", () => {
    const p = buildOptOutPreview("phone,email\n12345,\n");
    expect(p.usable).toBe(0);
    expect(p.unusable).toBe(1);
    expect(p.rows[0].problem).toMatch(/not a usable phone/);
  });

  it("flags a row with nothing to match on", () => {
    const p = buildOptOutPreview("phone,email\n,\n");
    expect(p.rows[0].problem).toBe("no phone and no email");
  });

  it("dedupes within the file", () => {
    const p = buildOptOutPreview("phone\n+15163448418\n516-344-8418\n");
    expect(p.usable).toBe(1);
    expect(p.duplicates).toBe(1);
  });

  it("treats the same person on two channels as two suppressions", () => {
    const p = buildOptOutPreview("phone,email\n+15163448418,\n,a@example.com\n");
    expect(p.usable).toBe(2);
  });

  it("parses an opt-out date when there is one", () => {
    const p = buildOptOutPreview("phone,opted_out_at\n+15163448418,2026-08-01T10:00:00Z\n");
    expect(p.rows[0].optedOutAt).toBe("2026-08-01T10:00:00.000Z");
  });

  /** Losing WHEN they said stop is survivable. Losing THAT they said it is not. */
  it("still imports a row whose date is unreadable", () => {
    const p = buildOptOutPreview("phone,date\n+15163448418,not a date\n");
    expect(p.usable).toBe(1);
    expect(p.rows[0].optedOutAt).toBeNull();
  });

  it("reports which headers it matched, so a wrong guess is visible", () => {
    const p = buildOptOutPreview("Mobile,E-Mail\n+15163448418,a@example.com\n");
    expect(p.detectedHeaders.phone).toBe("Mobile");
    expect(p.detectedHeaders.email).toBe("E-Mail");
  });

  it("survives a file with no usable columns at all", () => {
    const p = buildOptOutPreview("name,notes\nBob,called in\n");
    expect(p.usable).toBe(0);
    expect(p.detectedHeaders.phone).toBeNull();
  });

  it("marks every imported row as coming from Hatch", () => {
    const p = buildOptOutPreview("phone\n+15163448418\n");
    expect(toOptOutRecords(p)[0].source).toBe("hatch_import");
  });
});
