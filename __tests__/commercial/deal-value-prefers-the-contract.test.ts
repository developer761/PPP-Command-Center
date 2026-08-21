import { describe, it, expect } from "vitest";
import { dealValueCents } from "@/lib/commercial/opportunities/db";
import type { CommercialOpportunity } from "@/lib/commercial/opportunities/db";

/**
 * Once a job is under contract, the bid is history.
 *
 * docs/OPEN_BACKLOG, "Step-7": the opportunities LIST showed delivery rows at
 * their original bid. A job won at $120k sat in the list at its $95k estimate,
 * and the header total summed the wrong number — on the page the pipeline is
 * read from.
 *
 * Fixed by the 2026-08-12 audit inside `dealValueCents`, and verified against
 * the live database on 2026-08-21: 9 of 12 decided deals resolve to their
 * signed contract; the other 3 carry no figure of any kind, so they read $0
 * either way. Pinned here because this is a number people quote, and it has
 * regressed once already.
 */

function opp(over: Partial<CommercialOpportunity> = {}): CommercialOpportunity {
  return {
    id: "o1",
    status: "estimating",
    sub_status: null,
    accepted_contract_cents: null,
    bid_value_low_cents: null,
    bid_value_high_cents: null,
    ...over,
  } as unknown as CommercialOpportunity;
}

const BID = { bid_value_low_cents: 90_000_00, bid_value_high_cents: 100_000_00 }; // mid 95k
const SIGNED = 120_000_00;

describe("dealValueCents", () => {
  it("uses the bid midpoint while the job is still being chased", () => {
    expect(dealValueCents(opp({ ...BID, status: "estimating" } as never))).toBe(95_000_00);
  });

  it("switches to the signed contract the moment the deal is WON", () => {
    const won = opp({
      ...BID,
      status: "pre_sale_closed",
      sub_status: "won",
      accepted_contract_cents: SIGNED,
    } as never);
    expect(dealValueCents(won)).toBe(SIGNED);
  });

  it("keeps using the contract through every delivery stage", () => {
    for (const status of ["pre_construction", "in_progress", "billing", "post_sale_closed"]) {
      const o = opp({ ...BID, status, accepted_contract_cents: SIGNED } as never);
      expect(dealValueCents(o), `${status} fell back to the bid`).toBe(SIGNED);
    }
  });

  it("does NOT use a contract figure on a deal that was lost", () => {
    // A signed figure on a lost deal is stale data, not a contract.
    const lost = opp({
      ...BID,
      status: "pre_sale_closed",
      sub_status: "lost",
      accepted_contract_cents: SIGNED,
    } as never);
    expect(dealValueCents(lost)).toBe(95_000_00);
  });

  it("falls back to the bid when a won deal has no contract figure yet", () => {
    // The state 3 live deals are actually in — won, nothing signed recorded.
    // Falling back is right; inventing a contract value would be worse.
    const won = opp({ ...BID, status: "in_progress" } as never);
    expect(dealValueCents(won)).toBe(95_000_00);
  });

  it("falls back to the proposal total when there is no bid range at all", () => {
    expect(dealValueCents(opp({ status: "proposal" } as never), 42_000_00)).toBe(42_000_00);
  });
});
