import { describe, it, expect } from "vitest";
import { deriveProjectAttention, type ProjectAttentionInput } from "@/lib/commercial/projects/project-attention";

const money = (c: number) => `$${(c / 100).toFixed(0)}`;

const HREFS = {
  invoices: "/inv",
  changeOrders: "/co",
  submittals: "/sub",
  aia: "/aia",
  closeout: "/close",
  schedule: "/sched",
};

const base: ProjectAttentionInput = {
  onSite: false,
  billing: false,
  hasContract: true,
  contractCents: 100_00,
  billedPreTaxCents: 100_00,
  openInvoiceCents: 0,
  overdueInvoice: null,
  overdueAia: null,
  retainageCents: 0,
  pendingCoCount: 0,
  pendingCoCents: 0,
  submittalsNotSent: false,
  closeoutNotStarted: false,
  crewHours: 0,
  targetStartInDays: null,
  hrefs: HREFS,
};

const keys = (i: ProjectAttentionInput) => deriveProjectAttention(i, money).map((a) => a.key);

describe("deriveProjectAttention", () => {
  it("returns nothing for a healthy, quiet project", () => {
    expect(deriveProjectAttention(base, money)).toEqual([]);
  });

  it("surfaces an overdue invoice as the highest-priority item", () => {
    const items = deriveProjectAttention(
      { ...base, overdueInvoice: { number: "INV-014", balanceCents: 8_400_00, daysLate: 12 } },
      money
    );
    expect(items[0]).toMatchObject({ key: "overdue", severity: "high", href: "/inv" });
    expect(items[0].detail).toContain("12 days late");
  });

  it("ranks high → med → low regardless of push order", () => {
    const items = deriveProjectAttention(
      {
        ...base,
        billing: true,
        billedPreTaxCents: 40_00, // left to bill (low)
        pendingCoCount: 2, // med
        pendingCoCents: 3_200_00,
        overdueInvoice: { number: "INV-1", balanceCents: 1_00, daysLate: 1 }, // high
      },
      money
    );
    expect(items.map((a) => a.severity)).toEqual(["high", "med", "low"]);
  });

  it("flags a pending change order with its dollar detail", () => {
    const items = deriveProjectAttention({ ...base, pendingCoCount: 1, pendingCoCents: 3_200_00 }, money);
    const co = items.find((a) => a.key === "pending-co")!;
    expect(co.title).toContain("1 change order awaiting");
    expect(co.detail).toBe("$3200");
  });

  it("flags submittals not sent", () => {
    expect(keys({ ...base, submittalsNotSent: true })).toContain("submittals");
  });

  it("flags crew-not-scheduled only when start is near, no hours, and off site", () => {
    expect(keys({ ...base, targetStartInDays: 4 })).toContain("crew");
    expect(keys({ ...base, targetStartInDays: 20 })).not.toContain("crew"); // too far out
    expect(keys({ ...base, targetStartInDays: 4, crewHours: 8 })).not.toContain("crew"); // already scheduled
    expect(keys({ ...base, targetStartInDays: 4, onSite: true })).not.toContain("crew"); // already on site
  });

  it("does not double-count outstanding when it's already overdue", () => {
    const items = deriveProjectAttention(
      { ...base, openInvoiceCents: 5_00, overdueInvoice: { number: "INV-2", balanceCents: 5_00, daysLate: 3 } },
      money
    );
    expect(items.filter((a) => a.key === "outstanding")).toHaveLength(0);
    expect(items.filter((a) => a.key === "overdue")).toHaveLength(1);
  });

  it("flags close-out only once the job is fully billed", () => {
    expect(keys({ ...base, closeoutNotStarted: true, billedPreTaxCents: 100_00 })).toContain("closeout");
    expect(keys({ ...base, closeoutNotStarted: true, billedPreTaxCents: 50_00 })).not.toContain("closeout");
  });
});

describe("a late payment application", () => {
  // An AIA-billed job raises no invoice. Before this it could only ever reach
  // the low-severity "outstanding" line, so the deal page stayed calm about
  // money the AR-aging report already had in the 61-90 bucket.
  it("is flagged high, like a late invoice", () => {
    const items = deriveProjectAttention(
      { ...base, openInvoiceCents: 40_000_00, overdueAia: { balanceCents: 40_000_00, daysLate: 61 } },
      money
    );
    const flagged = items.find((i) => i.key === "overdue-aia");
    expect(flagged?.severity).toBe("high");
    expect(flagged?.detail).toContain("61 days late");
  });

  it("does not also repeat the same money as a low-severity line", () => {
    const items = deriveProjectAttention(
      { ...base, openInvoiceCents: 40_000_00, overdueAia: { balanceCents: 40_000_00, daysLate: 61 } },
      money
    );
    expect(items.find((i) => i.key === "outstanding")).toBeUndefined();
  });

  it("current AIA money still reads as plain outstanding", () => {
    const items = deriveProjectAttention({ ...base, openInvoiceCents: 40_000_00, overdueAia: null }, money);
    expect(items.find((i) => i.key === "overdue-aia")).toBeUndefined();
    expect(items.find((i) => i.key === "outstanding")).toBeDefined();
  });
});
