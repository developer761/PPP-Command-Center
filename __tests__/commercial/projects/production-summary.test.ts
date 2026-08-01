import { describe, it, expect } from "vitest";
import { summarizeProduction, type ProjectRow } from "@/lib/commercial/projects/db";

/**
 * Portfolio production + billing roll-up (Phase G/H dashboard + Account 360).
 * Money-facing, so the aggregation is pinned. All amounts are cents.
 *
 * 2026-07-29 financial truth: "remaining" now means LEFT TO BILL (contract −
 * invoiced), summed from each project's already-clamped leftToBillCents — not
 * contract − completed. Invoiced/paid/outstanding are first-class.
 */
describe("summarizeProduction", () => {
  const row = (over: Partial<ProjectRow> & { status?: string }): ProjectRow => {
    const { status, ...rest } = over;
    return {
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
      invoicedCents: 0,
      billedContractCents: 0,
      paidCents: 0,
      invoiceCount: 0,
      draftInvoiceCount: 0,
      draftedCents: 0,
      leftToBillCents: 0,
      outstandingCents: 0,
      overBilled: false,
      closeoutStatus: null,
      isClosedOut: false,
      submittalTotal: 0,
      submittalAwaiting: 0,
      costsCents: 0,
      costs: { materials: 0, labor: 0, subcontractor: 0, equipment: 0, permit: 0, other: 0, total: 0, count: 0 },
      grossMarginCents: 0,
      grossMarginPct: null,
      ...rest,
    };
  };

  it("sums contract, completed, invoiced, paid, left-to-bill, outstanding, retainage, pending COs", () => {
    const s = summarizeProduction([
      row({ status: "in_progress", contractToDateCents: 10_000_000, completedToDateCents: 4_000_000, invoicedCents: 3_000_000, paidCents: 1_000_000, leftToBillCents: 7_000_000, outstandingCents: 2_000_000, retainageHeldCents: 200_000, pendingCoCount: 1, pendingCoCents: 500_000 }),
      row({ status: "billing", contractToDateCents: 5_000_000, completedToDateCents: 5_000_000, invoicedCents: 5_000_000, paidCents: 5_000_000, leftToBillCents: 0, outstandingCents: 0, retainageHeldCents: 250_000 }),
      row({ status: "pre_construction", contractToDateCents: 2_000_000, invoicedCents: 0, paidCents: 0, leftToBillCents: 2_000_000, outstandingCents: 0, pendingCoCount: 2, pendingCoCents: 300_000 }),
    ]);
    expect(s.activeProjects).toBe(3);
    expect(s.contractValueCents).toBe(17_000_000);
    expect(s.completedToDateCents).toBe(9_000_000);
    expect(s.invoicedCents).toBe(8_000_000);
    expect(s.paidCents).toBe(6_000_000);
    expect(s.leftToBillCents).toBe(9_000_000); // 7M + 0 + 2M
    expect(s.remainingCents).toBe(9_000_000); // remaining aliases left-to-bill now
    expect(s.outstandingCents).toBe(2_000_000); // 8M invoiced − 6M paid
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

  it("sums per-project left-to-bill so one over-billed job can't mask another's headroom", () => {
    // Project A over-billed (clamped to 0 upstream); project B still has room.
    const s = summarizeProduction([
      row({ contractToDateCents: 1_000_000, invoicedCents: 1_200_000, leftToBillCents: 0, overBilled: true }),
      row({ contractToDateCents: 1_000_000, invoicedCents: 400_000, leftToBillCents: 600_000 }),
    ]);
    expect(s.leftToBillCents).toBe(600_000);
    expect(s.remainingCents).toBe(600_000);
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
      invoicedCents: 0,
      billedContractCents: 0,
      paidCents: 0,
      leftToBillCents: 0,
      overBilledCents: 0,
      overBilledProjects: 0,
      outstandingCents: 0,
      costsCents: 0,
      grossMarginCents: 0,
    });
  });

  it("sums over-billing PER PROJECT, never netting an under-billed deal against an over-billed one", () => {
    // Deal A: billed 12M on a 10M contract → 2M over. Deal B: billed 3M on a 5M
    // contract → 2M under. A naive Σbilled − Σcontract = 0 would HIDE A's overage
    // (2026-08 money audit #3). Per-project summing must report 2M over on 1 job.
    const s = summarizeProduction([
      row({ contractToDateCents: 10_000_000, billedContractCents: 12_000_000, overBilled: true, leftToBillCents: 0 }),
      row({ contractToDateCents: 5_000_000, billedContractCents: 3_000_000, overBilled: false, leftToBillCents: 2_000_000 }),
    ]);
    expect(s.overBilledCents).toBe(2_000_000);
    expect(s.overBilledProjects).toBe(1);
    expect(s.leftToBillCents).toBe(2_000_000); // only the under-billed deal's headroom
  });

  it("reports zero over-billing when no project is individually over-billed", () => {
    const s = summarizeProduction([
      row({ contractToDateCents: 10_000_000, billedContractCents: 4_000_000, leftToBillCents: 6_000_000 }),
    ]);
    expect(s.overBilledCents).toBe(0);
    expect(s.overBilledProjects).toBe(0);
  });

  it("sums costs and computes portfolio gross margin (contract − costs)", () => {
    const s = summarizeProduction([
      row({ contractToDateCents: 10_000_000, costsCents: 6_000_000 }),
      row({ contractToDateCents: 4_000_000, costsCents: 5_000_000 }), // over budget on this one
    ]);
    expect(s.costsCents).toBe(11_000_000);
    expect(s.contractValueCents).toBe(14_000_000);
    // Portfolio margin nets: 14M contract − 11M cost = 3M (one job's overrun is
    // absorbed at the portfolio level, but each project row keeps its own sign).
    expect(s.grossMarginCents).toBe(3_000_000);
  });
});
