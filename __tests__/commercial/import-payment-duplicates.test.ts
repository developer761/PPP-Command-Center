import { describe, it, expect } from "vitest";
import { matchExistingPayment, type ExistingPayment } from "@/lib/commercial/import/mapping";

/**
 * The same cheque, banked twice.
 *
 * During the dual run Mary records a payment in Command Center AND in
 * Salesforce. The importer then inserted Salesforce's copy, because the row she
 * typed carries no Salesforce id and nothing looked for one — so the invoice
 * showed the money twice. Found 2026-10-13 by `import-tomco.mjs --reconcile`:
 * 12 payments and $42,874.63 of cash counted double.
 *
 * It fails in the direction that costs money. Paid twice drives the balance
 * negative, the job reads as settled, drops off AR, and nobody chases it.
 *
 * Every case below is a real row out of that run, named, so that a future
 * change to the matching rule has to argue with the book rather than with a
 * fixture somebody invented.
 */

const p = (o: Partial<ExistingPayment>): ExistingPayment => ({
  id: "x",
  invoice_id: "inv-sf",
  amount_cents: 100_000,
  paid_at: "2026-10-06T16:00:00.000Z",
  reference: "530812",
  ...o,
});

describe("a payment already recorded by hand is adopted, not banked again", () => {
  it("adopts the obvious case: same invoice, same money, same day, same cheque", () => {
    // North Shore Dental $3,920.00 on 2026-10-06, cheque 530812 — one of ten.
    const mine = p({ id: "mary", amount_cents: 392_000, reference: "530812" });
    const got = matchExistingPayment([mine], { amount_cents: 392_000, paid_at: "2026-10-06", reference: "530812" }, "inv-sf");
    expect(got).toEqual({ kind: "adopt", row: mine });
  });

  it("adopts when only one side names a cheque", () => {
    // LMJ Cipla $950.00: Salesforce carried 974107, the typed row carried none.
    const mine = p({ id: "mary", amount_cents: 95_000, reference: null, paid_at: "2026-09-28T16:00:00.000Z" });
    const got = matchExistingPayment([mine], { amount_cents: 95_000, paid_at: "2026-09-28", reference: "974107" }, "inv-sf");
    expect(got.kind).toBe("adopt");
  });

  it("inserts normally when nothing here looks like it", () => {
    expect(matchExistingPayment([], { amount_cents: 500, paid_at: "2026-10-06", reference: "1" }, "inv-sf"))
      .toEqual({ kind: "insert" });
    // Same day, different money — a real second payment.
    const other = p({ amount_cents: 1_000 });
    expect(matchExistingPayment([other], { amount_cents: 2_000, paid_at: "2026-10-06", reference: "1" }, "inv-sf").kind)
      .toBe("insert");
  });
});

describe("it asks rather than guessing, in all three ways money can be lost", () => {
  it("two different cheque numbers — might be two real payments", () => {
    // Ascent-400 S. Technology $75.00 on 2026-09-28: 974104 here, 974107 there.
    // Merging these would delete a payment that happened.
    const mine = p({ id: "mary", amount_cents: 7_500, reference: "974104", paid_at: "2026-09-28T16:00:00.000Z" });
    const got = matchExistingPayment([mine], { amount_cents: 7_500, paid_at: "2026-09-28", reference: "974107" }, "inv-sf");
    expect(got.kind).toBe("ask");
    expect(got.kind === "ask" && got.why).toMatch(/references differ/);
  });

  it("the same money on a DIFFERENT invoice — the job is billed twice", () => {
    /*
     * J. Carleton Environmental Center. Salesforce invoiced the whole
     * $23,235.70; INV-0027 was raised here for another $11,617.85 of the same
     * job, and the one payment is recorded against each.
     *
     * Adopting would update the typed row with Salesforce's `invoice_id` and
     * so MOVE the payment, leaving INV-0027 unpaid — the double-count turned
     * into a false receivable. That is the shape of the 2026-09 AIA incident,
     * where deleting a duplicate payment fixed the deposits and broke AR by
     * $19,000.
     */
    const mine = p({ id: "mary", invoice_id: "inv-0027", amount_cents: 1_161_785, reference: "Inv#312838" });
    const got = matchExistingPayment([mine], { amount_cents: 1_161_785, paid_at: "2026-10-06", reference: "Inv#312838" }, "inv-sf");
    expect(got.kind).toBe("ask");
    expect(got.kind === "ask" && got.why).toMatch(/DIFFERENT invoice/);
  });

  it("several identical payments — too alike to tell apart", () => {
    /*
     * THE REGRESSION THIS EXISTS FOR.
     *
     * An early version collapsed "none" and "several" into one `null`, and
     * `null` meant insert — so the ambiguous job got a THIRD copy of the money,
     * the exact outcome the function was written to prevent. Progress billing
     * makes identical amounts on one job ordinary, so this is not a corner.
     */
    const a = p({ id: "a" }), b = p({ id: "b" });
    const got = matchExistingPayment([a, b], { amount_cents: 100_000, paid_at: "2026-10-06", reference: "530812" }, "inv-sf");
    expect(got.kind).toBe("ask");
    expect(got.kind === "ask" && got.why).toMatch(/2 payments/);
    // Never "insert" — that is the bug.
    expect(got.kind).not.toBe("insert");
  });
});

describe("matching is by the day, not the timestamp", () => {
  it("reads two anchored timestamps as the same day", () => {
    // Both sides arrive anchored — `stagePayments` builds `at(ymd(Date__c))`,
    // so a bare date is a shape the caller never produces. Pinned against the
    // real one, because an earlier version of this test asserted a hazard the
    // caller cannot create while the real hazard below went untested.
    const mine = p({ id: "mary", paid_at: "2026-10-06T16:00:00.000Z" });
    expect(matchExistingPayment([mine], { amount_cents: 100_000, paid_at: "2026-10-06T16:00:00.000Z", reference: "530812" }, "inv-sf").kind)
      .toBe("adopt");
  });

  it("a different day with no shared cheque number is a different payment", () => {
    const mine = p({ id: "mary", paid_at: "2026-10-05T16:00:00.000Z", reference: null });
    expect(matchExistingPayment([mine], { amount_cents: 100_000, paid_at: "2026-10-06T16:00:00.000Z", reference: null }, "inv-sf").kind)
      .toBe("insert");
  });

  it("compares EASTERN days, so a late-evening entry is not tomorrow", () => {
    /*
     * THE REAL HAZARD. `paid_at` is TIMESTAMPTZ and most writers anchor it to
     * noon ET — but `lib/commercial/invoices/db.ts` falls back to `new Date()`
     * when the date field is left blank, so some rows hold a true instant.
     * Mary saving at 9:30pm ET on the 6th stores 2026-10-07T01:30Z. Slicing
     * the first ten characters calls that the 7th, finds no match, and banks
     * the cheque a second time.
     */
    const lateEvening = p({ id: "mary", paid_at: "2026-10-07T01:30:00.000Z", reference: null });
    expect(matchExistingPayment([lateEvening], { amount_cents: 100_000, paid_at: "2026-10-06T16:00:00.000Z", reference: null }, "inv-sf").kind)
      .toBe("adopt");
  });
});

describe("the cheque number is the strong signal, not the date", () => {
  it("adopts a cheque recorded a couple of days after it was dated", () => {
    /*
     * The single most likely form of the duplicate, and the first version of
     * this matcher missed it completely: it selected candidates on (amount,
     * day) and used the reference only as a veto. Ten of the twelve real
     * duplicates carried the same cheque number; the dates are typed and
     * drift. North Shore Dental, cheque 530812, dated the 6th, recorded the
     * 8th — keyed on the day it finds nothing and doubles $3,920.
     */
    const mine = p({ id: "mary", amount_cents: 392_000, reference: "530812", paid_at: "2026-10-08T16:00:00.000Z" });
    const got = matchExistingPayment([mine], { amount_cents: 392_000, paid_at: "2026-10-06T16:00:00.000Z", reference: "530812" }, "inv-sf");
    expect(got.kind).toBe("adopt");
  });

  it("will not adopt on the amount alone", () => {
    // Different day, no shared reference — two equal draws on one invoice
    // (progress plus a retainage release) are ordinary, and merging them
    // deletes real money.
    const mine = p({ id: "mary", reference: "   ", paid_at: "2026-09-01T16:00:00.000Z" });
    expect(matchExistingPayment([mine], { amount_cents: 100_000, paid_at: "2026-10-06T16:00:00.000Z", reference: null }, "inv-sf").kind)
      .toBe("insert");
  });

  it("treats a whitespace-only reference as absent, not as agreement", () => {
    /*
     * `ref()` trims, so "   " must not launder into "the cheque numbers match".
     * The days DIFFER here on purpose: if whitespace did launder into
     * agreement, this would wrongly adopt. With the fixture on the same day
     * the assertion could not tell the bug from the fix — which is what an
     * earlier version of this test did.
     */
    const mine = p({ id: "mary", reference: "   ", paid_at: "2026-10-08T16:00:00.000Z" });
    const got = matchExistingPayment([mine], { amount_cents: 100_000, paid_at: "2026-10-06T16:00:00.000Z", reference: "   " }, "inv-sf");
    expect(got.kind).toBe("insert");
  });
});

describe("a shared reference is not proof — the memo box is not an identifier", () => {
  it("REFUSES to merge VCA Commack's two real $15,000 draws", () => {
    /*
     * THE CASE THAT KILLED THE FIRST VERSION OF THIS RULE.
     *
     * Two genuine payments on one invoice, 2026-01-15 and 2026-03-19, both
     * carrying the GC's PO number "00268853" as their reference. An unbounded
     * reference match adopts one onto the other: in the real dual-run shape,
     * where Mary has typed only one of them, the second is never recorded and
     * $15,000 silently leaves the book.
     *
     * The reference column is a memo box — `joinOtherDetail` writes the
     * "other method" free text into it, which is why "ACH" and "Labr
     * Reimbursement" are references — and 32 distinct values are shared by
     * more than one payment. So a reference may only rescue a near-miss on the
     * DATE, never span one.
     */
    const january = p({
      id: "jan",
      amount_cents: 1_500_000,
      reference: "00268853",
      paid_at: "2026-01-15T16:00:00.000Z",
    });
    const got = matchExistingPayment(
      [january],
      { amount_cents: 1_500_000, paid_at: "2026-03-19T16:00:00.000Z", reference: "00268853" },
      "inv-sf",
    );
    expect(got.kind).toBe("insert");
  });

  it("still rescues a cheque recorded a few days late", () => {
    // The case the reference arm exists for: same cheque, within the window.
    const mine = p({ id: "mary", amount_cents: 392_000, reference: "530812", paid_at: "2026-10-08T16:00:00.000Z" });
    expect(matchExistingPayment([mine], { amount_cents: 392_000, paid_at: "2026-10-06T16:00:00.000Z", reference: "530812" }, "inv-sf").kind)
      .toBe("adopt");
  });

  it("will not let prose stand in for a cheque number", () => {
    // "ACH" on both sides is not evidence of anything — it is the method.
    const mine = p({ id: "mary", reference: "ACH", paid_at: "2026-10-08T16:00:00.000Z" });
    expect(matchExistingPayment([mine], { amount_cents: 100_000, paid_at: "2026-10-06T16:00:00.000Z", reference: "ACH" }, "inv-sf").kind)
      .toBe("insert");
  });
});
