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
  it("reads a Salesforce bare date against our anchored timestamp", () => {
    // We store 16:00Z (noon ET); Salesforce hands back "2026-10-06". Comparing
    // the raw strings would never match and every payment would double.
    const mine = p({ id: "mary", paid_at: "2026-10-06T16:00:00.000Z" });
    expect(matchExistingPayment([mine], { amount_cents: 100_000, paid_at: "2026-10-06", reference: "530812" }, "inv-sf").kind)
      .toBe("adopt");
  });

  it("a different day is a different payment", () => {
    const mine = p({ id: "mary", paid_at: "2026-10-05T16:00:00.000Z" });
    expect(matchExistingPayment([mine], { amount_cents: 100_000, paid_at: "2026-10-06", reference: "530812" }, "inv-sf").kind)
      .toBe("insert");
  });
});
