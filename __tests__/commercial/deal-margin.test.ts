import { describe, it, expect } from "vitest";
import { dealMargin } from "@/lib/commercial/projects/financials";

/**
 * One margin, used everywhere. Three surfaces used to disagree about the same
 * deal — the Overview said "—", the P&L tab said "100%", and the Transactions
 * chip said something else again, two clicks apart. These tests pin the cases
 * that made them diverge.
 */
const base = {
  contractCents: 20_000_00,
  hasContract: true,
  totalCostCents: 0,
  grossMarginCents: 20_000_00,
  grossMarginPct: 100,
  laborUnratedHours: 0,
};

describe("dealMargin", () => {
  it("does not call a job with no costs a 100% margin", () => {
    // The exact disagreement: $200k billed, nothing spent. "100%" reads as a
    // triumph; it actually means the job hasn't started.
    const m = dealMargin(base);
    expect(m.label).toBe("Projected gross margin");
    expect(m.caveat).toMatch(/No costs booked yet/i);
  });

  it("states a real margin plainly once costs exist", () => {
    const m = dealMargin({
      ...base,
      totalCostCents: 12_000_00,
      grossMarginCents: 8_000_00,
      grossMarginPct: 40,
    });
    expect(m.label).toBe("Gross margin");
    expect(m.pct).toBe(40);
    expect(m.caveat).toBeNull();
    expect(m.overBudget).toBe(false);
  });

  it("never returns a percentage without a contract", () => {
    // contract 0 would make every ratio NaN/Infinity. Dollars still show.
    const m = dealMargin({
      ...base,
      contractCents: 0,
      hasContract: false,
      grossMarginPct: null,
      totalCostCents: 5_000_00,
      grossMarginCents: -5_000_00,
    });
    expect(m.pct).toBeNull();
    expect(m.cents).toBe(-5_000_00);
    expect(m.caveat).toMatch(/Contract not set yet/i);
  });

  it("flags a job that's past over-budget rather than printing -4900%", () => {
    const m = dealMargin({
      ...base,
      contractCents: 1_000_00,
      totalCostCents: 50_000_00,
      grossMarginCents: -49_000_00,
      grossMarginPct: -4900,
    });
    expect(m.overBudget).toBe(true);
  });

  it("warns when unrated crew hours understate the margin", () => {
    const m = dealMargin({
      ...base,
      totalCostCents: 12_000_00,
      grossMarginCents: 8_000_00,
      grossMarginPct: 40,
      laborUnratedHours: 37,
    });
    expect(m.caveat).toMatch(/37 crew hours have no cost rate/i);
  });

  it("keeps the unrated-hours warning singular for one hour", () => {
    const m = dealMargin({
      ...base,
      totalCostCents: 1_00,
      grossMarginCents: 1_00,
      grossMarginPct: 1,
      laborUnratedHours: 1,
    });
    expect(m.caveat).toMatch(/1 crew hour have/i);
  });

  it("prefers the no-contract message over the no-costs one", () => {
    // Both conditions true at once: without a contract there's no ratio to
    // project, so that message has to win or we'd promise a projection we
    // can't compute.
    const m = dealMargin({
      ...base,
      contractCents: 0,
      hasContract: false,
      totalCostCents: 0,
      grossMarginPct: null,
    });
    expect(m.caveat).toMatch(/Contract not set yet/i);
  });
});
