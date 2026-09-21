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

/**
 * ONE ROW CANNOT COLLIDE ON TWO INDEXES.
 *
 * migration 186 puts two PARTIAL unique indexes on sms_opt_outs — one on the
 * active phone, one on the active lowercased email. A single row carrying both
 * identifiers can only ever violate one of them, and the importer treats any
 * 23505 as "already suppressed on that channel".
 *
 * So: Bob appears email-only in one export, then appears again WITH his phone.
 * The second insert collides on the EMAIL index, is counted as already
 * present, and Bob's handset is never suppressed — while the importer reports
 * success. He is then textable, which is the one outcome this table exists to
 * prevent. Kate's export is exactly this shape, and splitting a large file is
 * something the screen actively tells her to do ("overlapping is fine").
 *
 * Suppression semantics do not change: the gate matches the phone column for
 * SMS and the email column for email, so a row per identifier suppresses
 * precisely what the combined row did.
 */
describe("a person with both a phone and an email", () => {
  const both = () => toOptOutRecords(buildOptOutPreview("phone,email\n+15163448418,bob@example.com\n"));

  it("is written as one row per identifier, not one row with both", () => {
    const recs = both();
    expect(recs).toHaveLength(2);
  });

  it("suppresses the handset on its own row, so the phone index is what it hits", () => {
    const sms = both().find((r) => r.channel === "sms");
    expect(sms?.phone_e164).toBe("+15163448418");
    // Not carrying the email too: that is what made it collide on the wrong
    // index and lose the phone suppression entirely.
    expect(sms?.email).toBeNull();
  });

  it("suppresses the address on its own row", () => {
    const email = both().find((r) => r.channel === "email");
    expect(email?.email).toBe("bob@example.com");
    expect(email?.phone_e164).toBeNull();
  });

  it("still writes one row for a phone-only person", () => {
    const recs = toOptOutRecords(buildOptOutPreview("phone,email\n+15163448418,\n"));
    expect(recs).toHaveLength(1);
    expect(recs[0].channel).toBe("sms");
  });

  it("still writes one row for an email-only person", () => {
    const recs = toOptOutRecords(buildOptOutPreview("phone,email\n,bob@example.com\n"));
    expect(recs).toHaveLength(1);
    expect(recs[0].channel).toBe("email");
  });

  it("does not write the same identifier twice from one file", () => {
    // Bob email-only on one line and Bob with his phone on another — the shape
    // that produced the lost suppression. His address must not be written
    // twice, or the second write is a 23505 that masks the first.
    const recs = toOptOutRecords(buildOptOutPreview(
      "phone,email\n,bob@example.com\n+15163448418,bob@example.com\n"
    ));
    const emails = recs.filter((r) => r.email);
    const phones = recs.filter((r) => r.phone_e164);
    expect(emails).toHaveLength(1);
    expect(phones).toHaveLength(1);
    expect(phones[0].phone_e164).toBe("+15163448418");
  });
});
