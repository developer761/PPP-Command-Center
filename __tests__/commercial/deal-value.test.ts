import { describe, it, expect } from "vitest";
import { dealValueCents } from "@/lib/commercial/opportunities/db";
import type { CommercialOpportunity } from "@/lib/commercial/opportunities/db";

const opp = (over: Partial<CommercialOpportunity> = {}) =>
  ({
    status: "qualifying",
    sub_status: "solicitation",
    bid_value_low_cents: null,
    bid_value_high_cents: null,
    accepted_contract_cents: null,
    ...over,
  }) as CommercialOpportunity;

/**
 * AUDIT 2026-08-12: the pipeline list, its header total and the delivery views
 * all valued a job at its BID — including jobs already being built and billed.
 * A job won at $120k sat in the list at its $95k bid, and the totals summed the
 * wrong number.
 */
describe("dealValueCents", () => {
  it("uses the signed contract once a job is won", () => {
    expect(
      dealValueCents(
        opp({ status: "pre_sale_closed", sub_status: "won", accepted_contract_cents: 120_000_00, bid_value_low_cents: 90_000_00, bid_value_high_cents: 100_000_00 })
      )
    ).toBe(120_000_00);
  });

  it("uses it through every delivery stage too", () => {
    for (const s of ["pre_construction", "in_progress", "billing", "post_sale_closed"] as const) {
      expect(dealValueCents(opp({ status: s, accepted_contract_cents: 120_000_00, bid_value_low_cents: 90_000_00, bid_value_high_cents: 90_000_00 })), s).toBe(120_000_00);
    }
  });

  it("still uses the bid range while a job is being SOLD", () => {
    // A contract snapshot can exist on a re-quoted deal that went back to
    // estimating; until it is won again, the bid is what it is worth.
    expect(
      dealValueCents(opp({ status: "estimating", accepted_contract_cents: 120_000_00, bid_value_low_cents: 90_000_00, bid_value_high_cents: 100_000_00 }))
    ).toBe(95_000_00);
  });

  it("falls back to the proposal when there is no bid range", () => {
    // Bid low/high came off the create forms in the 2026-08 meeting, so most
    // new deals have none — without this they counted as ZERO.
    expect(dealValueCents(opp(), 45_000_00)).toBe(45_000_00);
  });

  it("never counts a lost deal at its contract", () => {
    expect(
      dealValueCents(opp({ status: "pre_sale_closed", sub_status: "lost", accepted_contract_cents: 120_000_00 }), 45_000_00)
    ).toBe(45_000_00);
  });
});
