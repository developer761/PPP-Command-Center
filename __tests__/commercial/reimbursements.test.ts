import { describe, it, expect } from "vitest";
import {
  summarizeReimbursements,
  type ReimbursementRow,
} from "@/lib/commercial/reports/reimbursements";

/**
 * Reimbursements — what the company owes its own people.
 *
 * Alex's Salesforce report lists what was PAID. The half nobody has is what is
 * still OWED, because nobody chases the company for forty dollars of caulk —
 * so the outstanding side is what these cases are mostly about.
 */

function r(over: Partial<ReimbursementRow> = {}): ReimbursementRow {
  return {
    purchaseId: "p1",
    person: "Mike",
    purchasedYmd: "2026-08-01",
    amountCents: 40_00,
    category: "materials",
    description: "Aboffs",
    jobName: "Panera — Holbrook",
    opportunityId: "o1",
    accountName: "Acme GC",
    settledYmd: null,
    ageDays: 18,
    hasReceipt: true,
    href: "/x",
    ...over,
  };
}

describe("summarizeReimbursements", () => {
  it("splits what's owed from what's been paid back", () => {
    const rep = summarizeReimbursements([
      r({ purchaseId: "p1", amountCents: 40_00 }),
      r({ purchaseId: "p2", amountCents: 60_00, settledYmd: "2026-08-15" }),
    ]);
    expect(rep.owedCents).toBe(40_00);
    expect(rep.settledCents).toBe(60_00);
  });

  it("lists what's owed oldest first — that's who has waited longest", () => {
    const rep = summarizeReimbursements([
      r({ purchaseId: "new", purchasedYmd: "2026-08-15" }),
      r({ purchaseId: "old", purchasedYmd: "2026-06-01" }),
    ]);
    expect(rep.owed.map((x) => x.purchaseId)).toEqual(["old", "new"]);
  });

  // The deliberate asymmetry, and the reason it exists.
  it("a period narrows what was PAID BACK, never what is still owed", () => {
    const rep = summarizeReimbursements(
      [
        r({ purchaseId: "owed", purchasedYmd: "2026-04-01" }),
        r({ purchaseId: "settled-in", settledYmd: "2026-08-18" }),
        r({ purchaseId: "settled-out", settledYmd: "2026-05-02" }),
      ],
      { fromYmd: "2026-08-01", toYmd: "2026-08-31" }
    );
    // A four-month-old debt hidden because you picked "this week" is how it
    // stays unpaid.
    expect(rep.owed.map((x) => x.purchaseId)).toEqual(["owed"]);
    expect(rep.settled.map((x) => x.purchaseId)).toEqual(["settled-in"]);
  });

  it("ranks people by what they're owed, and how long they've waited", () => {
    const rep = summarizeReimbursements([
      r({ purchaseId: "p1", person: "Mike", amountCents: 40_00, ageDays: 5 }),
      r({ purchaseId: "p2", person: "Mike", amountCents: 60_00, ageDays: 30 }),
      r({ purchaseId: "p3", person: "Rosa", amountCents: 500_00, ageDays: 2 }),
    ]);
    expect(rep.byPerson[0]).toMatchObject({ person: "Rosa", owedCents: 500_00, count: 1 });
    expect(rep.byPerson[1]).toMatchObject({ person: "Mike", owedCents: 100_00, count: 2, oldestDays: 30 });
  });

  it("counts outstanding items with no receipt attached", () => {
    // The ones that get argued about at the point of payment.
    const rep = summarizeReimbursements([
      r({ purchaseId: "p1", hasReceipt: false }),
      r({ purchaseId: "p2", hasReceipt: true }),
      // A SETTLED item without a receipt is water under the bridge — flagging
      // it would make the number un-clearable.
      r({ purchaseId: "p3", hasReceipt: false, settledYmd: "2026-08-10" }),
    ]);
    expect(rep.noReceiptCount).toBe(1);
  });

  it("filters to one person across both halves", () => {
    const rep = summarizeReimbursements(
      [
        r({ purchaseId: "p1", person: "Mike" }),
        r({ purchaseId: "p2", person: "Rosa" }),
        r({ purchaseId: "p3", person: "Rosa", settledYmd: "2026-08-15" }),
      ],
      { person: "Rosa" }
    );
    expect(rep.owed).toHaveLength(1);
    expect(rep.settled).toHaveLength(1);
    // …but the picker still offers everyone, or you can't switch away.
    expect(rep.peopleOptions).toEqual(["Mike", "Rosa"]);
  });

  it("is empty, not broken, when nobody has fronted anything", () => {
    const rep = summarizeReimbursements([]);
    expect(rep.owedCents).toBe(0);
    expect(rep.byPerson).toEqual([]);
    expect(rep.noReceiptCount).toBe(0);
  });
});
