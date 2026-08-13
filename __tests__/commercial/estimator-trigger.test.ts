import { describe, it, expect } from "vitest";
import {
  DEFAULT_SUB_STATUS_BY_STATUS,
  isValidSubStatus,
} from "@/lib/commercial/opportunities/constants";

/**
 * Brendan's ladder: RFP → Estimating, where Estimating "triggers on estimator
 * assign".
 *
 * The update path honoured that. The CREATE path did not — and the create form
 * has an Estimator field, so a deal typed in with an estimator already picked
 * landed in Qualifying and stayed there until somebody drafted a proposal.
 *
 * The inference is pure and lives at the top of `createCommercialOpportunity`;
 * this pins its two rules rather than reaching for a database.
 */
describe("estimator-assigned infers the Estimating stage on create", () => {
  const infer = (input: { status?: string; estimator_user_id?: string | null }) =>
    input.status ?? (!input.status && input.estimator_user_id ? "estimating" : "qualifying");

  it("an estimator on the create form starts the deal in Estimating", () => {
    expect(infer({ estimator_user_id: "u-1" })).toBe("estimating");
  });

  it("no estimator still starts at Qualifying", () => {
    expect(infer({})).toBe("qualifying");
    expect(infer({ estimator_user_id: null })).toBe("qualifying");
  });

  it("an explicit stage always wins — a person's choice outranks the guess", () => {
    // Someone logging a deal that is already out to the GC picks the stage
    // themselves; inferring Estimating over that would move it backwards.
    expect(infer({ status: "proposal", estimator_user_id: "u-1" })).toBe("proposal");
    expect(infer({ status: "qualifying", estimator_user_id: "u-1" })).toBe("qualifying");
  });

  it("Estimating has a valid default sub-status to land on", () => {
    const sub = (DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>).estimating;
    expect(sub).toBeTruthy();
    expect(isValidSubStatus("estimating", sub)).toBe(true);
  });
});
