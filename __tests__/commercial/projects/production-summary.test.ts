import { describe, it, expect } from "vitest";
import { summarizeProduction, type ProjectRow } from "@/lib/commercial/projects/db";

/**
 * Portfolio production roll-up (Phase G/H dashboard + Account 360). Money-facing,
 * so the aggregation is pinned. All amounts are cents.
 */
describe("summarizeProduction", () => {
  const row = (over: Partial<ProjectRow> & { status?: string }): ProjectRow => {
    const { status, ...rest } = over;
    return {
      // Only the fields the summary reads matter; the rest are structurally
      // present so the type is satisfied.
      opp: { status: status ?? "in_progress" } as ProjectRow["opp"],
      accountId: "a",
      accountName: "GC",
      baseContractCents: 0,
      netApprovedCoCents: 0,
      contractToDateCents: 0,
      completedToDateCents: 0,
      retainageHeldCents: 0,
      pendingCoCount: 0,
      pendingCoCents: 0,
      hasBilling: false,
      latestAppNumber: null,
      latestAppStatus: null,
      percentCompleteBps: null,
      ...rest,
    };
  };

  it("sums contract, billed, retainage, and pending COs across projects", () => {
    const s = summarizeProduction([
      row({ status: "in_progress", contractToDateCents: 10_000_000, completedToDateCents: 4_000_000, retainageHeldCents: 200_000, pendingCoCount: 1, pendingCoCents: 500_000 }),
      row({ status: "billing", contractToDateCents: 5_000_000, completedToDateCents: 5_000_000, retainageHeldCents: 250_000, pendingCoCount: 0, pendingCoCents: 0 }),
      row({ status: "pre_construction", contractToDateCents: 2_000_000, completedToDateCents: 0, retainageHeldCents: 0, pendingCoCount: 2, pendingCoCents: 300_000 }),
    ]);
    expect(s.activeProjects).toBe(3);
    expect(s.contractValueCents).toBe(17_000_000);
    expect(s.completedToDateCents).toBe(9_000_000);
    expect(s.remainingCents).toBe(8_000_000); // 17M contract − 9M completed
    expect(s.retainageHeldCents).toBe(450_000);
    expect(s.pendingCoCount).toBe(3);
    expect(s.pendingCoCents).toBe(800_000);
  });

  it("counts in-production (in_progress OR billing) and billing separately", () => {
    const s = summarizeProduction([
      row({ status: "pre_construction" }),
      row({ status: "in_progress" }),
      row({ status: "billing" }),
      row({ status: "billing" }),
    ]);
    expect(s.inProductionProjects).toBe(3); // 1 in_progress + 2 billing
    expect(s.billingProjects).toBe(2);
  });

  it("never reports negative remaining when completed exceeds contract", () => {
    // Over-completion (work in place ahead of a not-yet-restated contract base)
    // must not show a negative 'left to complete'.
    const s = summarizeProduction([
      row({ contractToDateCents: 1_000_000, completedToDateCents: 1_200_000 }),
    ]);
    expect(s.remainingCents).toBe(0);
  });

  it("is all-zero for an empty portfolio", () => {
    const s = summarizeProduction([]);
    expect(s).toEqual({
      activeProjects: 0,
      inProductionProjects: 0,
      billingProjects: 0,
      contractValueCents: 0,
      completedToDateCents: 0,
      remainingCents: 0,
      retainageHeldCents: 0,
      pendingCoCount: 0,
      pendingCoCents: 0,
    });
  });
});
