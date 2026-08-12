import { describe, it, expect } from "vitest";
import { dealMargin, marginFrom } from "@/lib/commercial/projects/financials";

/**
 * One margin, used everywhere. Three surfaces used to disagree about the same
 * deal — the Overview said "—", the P&L tab said "100%", and the Transactions
 * chip said something else again, two clicks apart.
 *
 * The basis is BILLED (decision D2), which is what the dashboard bars and the
 * account Profitability rollup already use. An earlier version of this function
 * headlined the CONTRACT basis instead: the two deal surfaces then agreed with
 * each other but disagreed with every rollup above them. These tests pin the
 * basis as hard as they pin the wording.
 */
const base = {
  billedPreTaxCents: 20_000_00,
  contractCents: 20_000_00,
  hasContract: true,
  totalCostCents: 0,
  laborUnratedHours: 0,
};

describe("dealMargin", () => {
  it("measures margin against what has been BILLED, not the contract", () => {
    // The case that separates the two bases: half the contract billed, costs
    // already at 60% of the contract. Billed-based says the job is losing money
    // right now (−20%); contract-based says it's fine (40%). D2 headlines the
    // first, and the dashboard agrees with it.
    const m = dealMargin({
      ...base,
      contractCents: 100_000_00,
      billedPreTaxCents: 50_000_00,
      totalCostCents: 60_000_00,
    });
    expect(m.pct).toBe(-20);
    expect(m.cents).toBe(-10_000_00);
    // …and the contract view survives, but only under its own label.
    expect(m.vsContract).toEqual({
      pct: 40,
      cents: 40_000_00,
      label: "vs contract (budget)",
    });
  });

  it("never puts the contract number under the bare word 'margin'", () => {
    const m = dealMargin({ ...base, totalCostCents: 5_000_00 });
    expect(m.label).toBe("Gross margin");
    expect(m.vsContract!.label).toMatch(/contract/i);
    // The headline is the billed one, whatever the contract says.
    expect(m.pct).toBe(75);
  });

  it("does not call a job with no costs a 100% margin", () => {
    // $200k billed, nothing spent. "100%" reads as a triumph; it actually means
    // the job hasn't started.
    const m = dealMargin(base);
    expect(m.label).toBe("Projected gross margin");
    expect(m.caveat).toMatch(/No costs booked yet/i);
  });

  it("states a real margin plainly once costs exist", () => {
    const m = dealMargin({ ...base, totalCostCents: 12_000_00 });
    expect(m.label).toBe("Gross margin");
    expect(m.pct).toBe(40);
    expect(m.caveat).toBeNull();
    expect(m.overBudget).toBe(false);
  });

  it("never returns a percentage before anything is billed", () => {
    // Billed 0 would make every ratio NaN/Infinity. Costs already spent are
    // real, so the dollars still show.
    const m = dealMargin({ ...base, billedPreTaxCents: 0, totalCostCents: 5_000_00 });
    expect(m.pct).toBeNull();
    expect(m.cents).toBe(-5_000_00);
    expect(m.caveat).toMatch(/Nothing billed yet/i);
  });

  it("flags a job that's past over-budget rather than printing -4900%", () => {
    const m = dealMargin({
      ...base,
      billedPreTaxCents: 1_000_00,
      contractCents: 1_000_00,
      totalCostCents: 50_000_00,
    });
    expect(m.overBudget).toBe(true);
  });

  it("warns when unrated crew hours understate the margin", () => {
    const m = dealMargin({ ...base, totalCostCents: 12_000_00, laborUnratedHours: 37 });
    expect(m.caveat).toMatch(/37 crew hours have no cost rate/i);
  });

  it("keeps the unrated-hours warning singular for one hour", () => {
    const m = dealMargin({ ...base, totalCostCents: 1_00, laborUnratedHours: 1 });
    expect(m.caveat).toMatch(/1 crew hour have/i);
  });

  it("omits the contract line entirely when there is no contract", () => {
    // A ratio over a zero contract is undefined, not 0% — and showing "0% vs
    // contract" on an unpriced deal invents a budget nobody set.
    const m = dealMargin({
      ...base,
      contractCents: 0,
      hasContract: false,
      totalCostCents: 5_000_00,
    });
    expect(m.vsContract).toBeNull();
    // The billed headline still works — billing can precede a recorded contract.
    expect(m.pct).toBe(75);
  });
});

/**
 * `marginFrom` is the shared core behind every margin on the platform — the
 * deal Overview, the deal P&L, the Costs tool, the account rollup, the
 * dashboard bars and the reports. It exists because `net ÷ gross` is trivial
 * enough that each surface wrote its own, and every one of them printed "100%"
 * beside "no costs logged".
 */
describe("marginFrom", () => {
  it("refuses to call an unstarted job a 100% margin", () => {
    // The account rollup Karan spotted: Gross $100, Job costs $0 · none logged,
    // Margin 100% · net ÷ gross. True arithmetic, and it reads as a triumph
    // when it means nobody has spent anything yet.
    const m = marginFrom(100_00, 0);
    expect(m.pct).toBe(100);
    expect(m.provisional).toBe(true);
    expect(m.label).toBe("Projected margin");
    expect(m.caveat).toMatch(/No costs booked yet/i);
  });

  it("states a real margin plainly once costs exist", () => {
    const m = marginFrom(100_00, 60_00);
    expect(m.pct).toBe(40);
    expect(m.provisional).toBe(false);
    expect(m.label).toBe("Margin");
    expect(m.caveat).toBeNull();
  });

  it("has no percentage before anything is billed, but still shows the loss", () => {
    const m = marginFrom(0, 5_000_00);
    expect(m.pct).toBeNull();
    expect(m.cents).toBe(-5_000_00);
    expect(m.caveat).toMatch(/Nothing billed yet/i);
  });

  it("flags a catastrophic overrun instead of printing -4900%", () => {
    expect(marginFrom(1_00, 50_00).overBudget).toBe(true);
  });

  it("agrees with dealMargin, so a deal and its account can't disagree", () => {
    // The account rollup sums its deals. If the two used different rules, one
    // deal could read 40% while the account containing only that deal read
    // something else.
    for (const [billed, cost] of [
      [100_00, 0],
      [100_00, 60_00],
      [0, 500_00],
      [1_00, 50_00],
    ] as const) {
      const core = marginFrom(billed, cost);
      const deal = dealMargin({
        billedPreTaxCents: billed,
        contractCents: billed,
        hasContract: billed > 0,
        totalCostCents: cost,
        laborUnratedHours: 0,
      });
      expect(deal.pct, `${billed}/${cost}`).toBe(core.pct);
      expect(deal.provisional, `${billed}/${cost}`).toBe(core.provisional);
      expect(deal.overBudget, `${billed}/${cost}`).toBe(core.overBudget);
    }
  });
});
