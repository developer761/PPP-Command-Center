import { describe, it, expect } from "vitest";
import { stageForNewOpportunity } from "@/lib/commercial/opportunities/mutations";
import {
  DEFAULT_SUB_STATUS_BY_STATUS,
  isValidSubStatus,
} from "@/lib/commercial/opportunities/constants";

/**
 * Brendan's ladder: RFP → Estimating, where Estimating "triggers on estimator
 * assign". Editing a deal honoured that; creating one did not.
 *
 * This file previously RE-IMPLEMENTED the rule locally instead of importing
 * it, and its copy asserted `qualifying + estimator → qualifying` — codifying
 * the very bug the fix was for, and staying green while the real code path was
 * unreachable. The parallel review session caught it. It now imports the
 * function the mutation actually calls.
 */
describe("stageForNewOpportunity", () => {
  it("starts a deal in Estimating when an estimator is picked on the form", () => {
    expect(stageForNewOpportunity("qualifying", "u-1")).toBe("estimating");
  });

  it("fires even though the forms always send a status", () => {
    // The dead-code bug: both create forms resolve
    // `formData.get("status") ?? "qualifying"` before calling the mutation, so
    // a rule keyed on "no status was supplied" can never run from the UI.
    // Pinning the explicit-qualifying case is what makes that unrepeatable.
    expect(stageForNewOpportunity("qualifying", "u-1")).not.toBe("qualifying");
    expect(stageForNewOpportunity(undefined, "u-1")).toBe("estimating");
    expect(stageForNewOpportunity(null, "u-1")).toBe("estimating");
  });

  it("leaves a deal alone with no estimator", () => {
    expect(stageForNewOpportunity("qualifying", null)).toBe("qualifying");
    expect(stageForNewOpportunity(undefined, undefined)).toBe("qualifying");
    expect(stageForNewOpportunity("qualifying", "")).toBe("qualifying");
  });

  it("never drags a deal backwards from a later stage", () => {
    // Someone logging a job that is already out to the GC, or already won,
    // picks that stage themselves. Estimating is behind both.
    for (const later of ["estimating", "proposal", "pre_sale_closed", "in_progress", "billing"] as const) {
      expect(stageForNewOpportunity(later, "u-1")).toBe(later);
    }
  });

  it("lands on a sub-status that is actually valid for Estimating", () => {
    // The stage is only half of it — an invalid sub-status would be rewritten
    // downstream and quietly undo the move.
    const sub = (DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>).estimating;
    expect(sub).toBeTruthy();
    expect(isValidSubStatus("estimating", sub)).toBe(true);
  });
});
