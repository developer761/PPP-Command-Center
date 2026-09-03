import { describe, it, expect } from "vitest";
import { computeG702, isAiaTaxLine, AIA_TAX_ITEM_NO } from "@/lib/commercial/aia/constants";

/**
 * Sales tax on a payment application.
 *
 * Stephanie 2026-09-01: "The sales tax needs to appear within the totals of the
 * scheduled values. With that, if we change the sales tax status because they
 * provided a cert later into the job if not after, we need the status to change
 * the values within the AIA."
 *
 * Her second sentence decided the shape. A certificate can arrive mid-job and
 * the tax then has to come off. If tax were folded into the contract, taking it
 * off would restate the Original Contract Sum — telling the GC the contract
 * changed when it did not. That is the same confusion she described with
 * alternates surfacing as change orders.
 *
 * So tax behaves like a change order in the arithmetic: OUTSIDE line 1, INSIDE
 * line 3. Line 1 stays the number they signed, and the tax can go to zero
 * without touching it or the change orders.
 */
const row = (v: number, item_no?: string) => ({
  scheduled_value_cents: v,
  from_previous_cents: 0,
  this_period_cents: 0,
  materials_stored_cents: 0,
  item_no,
});

describe("identifying the tax row", () => {
  it("recognises it by item number, case-insensitively", () => {
    expect(isAiaTaxLine({ item_no: AIA_TAX_ITEM_NO })).toBe(true);
    expect(isAiaTaxLine({ item_no: "tax" })).toBe(true);
    expect(isAiaTaxLine({ item_no: " TAX " })).toBe(true);
  });

  it("does not mistake contract or change-order rows for it", () => {
    expect(isAiaTaxLine({ item_no: "1" })).toBe(false);
    expect(isAiaTaxLine({ item_no: "CO-001" })).toBe(false);
    expect(isAiaTaxLine({ item_no: null })).toBe(false);
  });
});

describe("where tax lands in the G702", () => {
  const base = { originalContractCents: 100_000_00, netChangeOrdersCents: 10_000_00, retainagePct: 5, previousCertificatesCents: 0 };

  it("adds to line 3 without touching line 1 or line 2", () => {
    const g = computeG702({
      ...base,
      lines: [row(100_000_00, "1"), row(10_000_00, "CO-001"), row(9_625_00, AIA_TAX_ITEM_NO)],
    });
    expect(g.originalContractCents).toBe(100_000_00); // the contract they signed
    expect(g.netChangeOrdersCents).toBe(10_000_00);
    expect(g.salesTaxCents).toBe(9_625_00);
    expect(g.contractSumToDateCents).toBe(119_625_00); // 1 + 2 + tax
  });

  it("keeps line 3 footing to the schedule of values", () => {
    // sovVarianceCents exists to catch line 3 and the G703 drifting apart.
    // Adding tax to one side only is exactly how that would happen, so this is
    // the assertion that matters most in this file.
    const g = computeG702({
      ...base,
      lines: [row(100_000_00, "1"), row(10_000_00, "CO-001"), row(9_625_00, AIA_TAX_ITEM_NO)],
    });
    expect(g.sovVarianceCents).toBe(0);
  });

  it("an exempt job is arithmetically identical to before", () => {
    // A cert on file, or a capital improvement: no tax row, and nothing else
    // moves. This is the state the cert-arrives-mid-job path converges on.
    const g = computeG702({ ...base, lines: [row(100_000_00, "1"), row(10_000_00, "CO-001")] });
    expect(g.salesTaxCents).toBe(0);
    expect(g.contractSumToDateCents).toBe(110_000_00);
    expect(g.sovVarianceCents).toBe(0);
  });

  it("taxes the change orders too, because a CO on a taxable job is taxable", () => {
    // 8.75% of (contract + CO), not of the contract alone.
    const taxable = 110_000_00;
    const g = computeG702({
      ...base,
      lines: [row(100_000_00, "1"), row(10_000_00, "CO-001"), row(Math.round(taxable * 0.0875), AIA_TAX_ITEM_NO)],
    });
    expect(g.salesTaxCents).toBe(9_625_00);
    expect(g.sovVarianceCents).toBe(0);
  });

  it("bills tax as the job completes, and retains on it like any other line", () => {
    const taxRow = { ...row(9_625_00, AIA_TAX_ITEM_NO), this_period_cents: 9_625_00 };
    const g = computeG702({
      ...base,
      lines: [{ ...row(100_000_00, "1"), this_period_cents: 100_000_00 }, { ...row(10_000_00, "CO-001"), this_period_cents: 10_000_00 }, taxRow],
    });
    expect(g.totalCompletedStoredCents).toBe(119_625_00);
    // 5% retainage across all three rows, summed per line.
    expect(g.retainageCents).toBe(5_981_25);
    // A fully-billed job leaves nothing outstanding.
    expect(g.balanceToFinishCents).toBe(g.contractSumToDateCents - g.totalEarnedLessRetainageCents);
  });
});
