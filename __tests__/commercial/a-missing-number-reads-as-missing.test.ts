import { describe, it, expect } from "vitest";
import { hasVendorActivity, topVendorShareLabel } from "@/lib/commercial/reports/change-orders-vendors";
import { pctOfContract } from "@/lib/commercial/opportunities/stage-kpis";

/**
 * A figure that cannot be computed has to SAY so. Each of these printed a
 * string built from a value that was not there — "null% of spend", "No
 * purchases" over real purchases, a percent of a one-cent contract.
 */

const vendor = (name: string, cents: number) => ({ key: name, name, cents, count: 1, variants: 1, topCategory: "paint" });

describe("change orders & vendor spend", () => {
  it("a window whose purchases and refunds net to $0 is not 'no purchases'", () => {
    const netsToZero = { vendors: [vendor("Sherwin", 4_000_00), vendor("Home Depot", -4_000_00)], unattributedCount: 0 };
    expect(hasVendorActivity(netsToZero)).toBe(true);
    expect(hasVendorActivity({ vendors: [], unattributedCount: 0 })).toBe(false);
    expect(hasVendorActivity({ vendors: [], unattributedCount: 2 })).toBe(true);
  });

  it("the biggest vendor's share reads as a percent only against a positive total", () => {
    expect(topVendorShareLabel({ vendors: [vendor("Sherwin", 750_00)], vendorTotalCents: 1_000_00 })).toBe(
      "Sherwin · 75% of spend",
    );
    for (const total of [0, -250_00]) {
      const label = topVendorShareLabel({ vendors: [vendor("Sherwin", 750_00)], vendorTotalCents: total });
      expect(label).toBe("Sherwin · credits outweigh spend, so no share");
      expect(label).not.toMatch(/null|NaN|undefined|-?\d+%/);
    }
    expect(topVendorShareLabel({ vendors: [], vendorTotalCents: 0 })).toBeUndefined();
  });
});

describe("stage KPI percentages of the contract", () => {
  it("are null with no contract, never a share of one cent", () => {
    expect(pctOfContract({ contractCents: 0 }, 5_000_00)).toBeNull();
    expect(pctOfContract({ contractCents: null }, 5_000_00)).toBeNull();
    expect(pctOfContract({ contractCents: -1 }, 5_000_00)).toBeNull();
  });

  it("are the rounded share otherwise", () => {
    expect(pctOfContract({ contractCents: 100_000_00 }, 25_000_00)).toBe(25);
    expect(pctOfContract({ contractCents: 100_000_00 }, null)).toBe(0);
    expect(pctOfContract({ contractCents: 100_000_00 }, 110_000_00)).toBe(110);
  });
});
