import { describe, it, expect } from "vitest";
import { jobFlag, rankJobsInFlight, type JobFlightInput } from "@/lib/commercial/reports/jobs-in-flight";

/**
 * Brendan 2026-08-26: "under 'this month' it should say things specific to the
 * deals — this one is billed 5k out of 25k, the work order hasn't been sent."
 *
 * One line per job means one FACT per job, so which fact wins is the entire
 * value of the strip. And a flag on every row is wallpaper — the state where a
 * job has nothing outstanding has to be able to say nothing.
 */
function job(over: Partial<JobFlightInput> = {}): JobFlightInput {
  return {
    oppId: "o1",
    name: "JD Sports — Junction Blvd",
    accountName: "Alta Construction East",
    billedCents: 5_000_00,
    contractCents: 25_000_00,
    workOrderMissing: false,
    workOrderUnsent: false,
    outstandingCents: 0,
    overBilledCents: 0,
    ...over,
  };
}

describe("which fact a job shows", () => {
  it("says nothing when nothing is outstanding", () => {
    // The row that earns its place by being quiet.
    expect(jobFlag(job({ billedCents: 25_000_00 }))).toBeNull();
  });

  it("surfaces the unsent work order Brendan named", () => {
    expect(jobFlag(job({ workOrderUnsent: true }))).toBe("work order not sent");
  });

  it("prefers over-billing to everything else — it is the one that costs money", () => {
    const j = job({ overBilledCents: 1_000_00, workOrderMissing: true, outstandingCents: 9_000_00 });
    expect(jobFlag(j)).toBe("billed over contract");
  });

  it("a crew that cannot start outranks money merely owed", () => {
    expect(jobFlag(job({ workOrderMissing: true, outstandingCents: 9_000_00 }))).toBe("no work order");
  });

  it("'nothing billed yet' only when truly nothing has been billed", () => {
    expect(jobFlag(job({ billedCents: 0 }))).toBe("nothing billed yet");
    expect(jobFlag(job({ billedCents: 1_00 }))).toBeNull();
  });

  it("a job with no contract value does not claim to be over-billed", () => {
    // Division by a zero contract is how a brand-new job gets a scary flag.
    expect(jobFlag(job({ contractCents: 0, billedCents: 0 }))).toBeNull();
  });
});

describe("ordering", () => {
  it("flagged jobs come first, whatever they are worth", () => {
    // The point of the strip: a small blocked job beats a large finished one.
    const small = job({ oppId: "small", contractCents: 2_000_00, billedCents: 0, workOrderUnsent: true });
    const big = job({ oppId: "big", contractCents: 200_000_00, billedCents: 200_000_00 });
    expect(rankJobsInFlight([big, small]).map((j) => j.oppId)).toEqual(["small", "big"]);
  });

  /**
   * THE WORST FLAG COMES FIRST, even when a lesser one is less billed.
   *
   * `jobFlag` ranks the flags deliberately — over-billed, then a crew that
   * cannot start, then money owed, then work not yet invoiced — and that
   * ordering decided which flag a ROW shows. It did not reach the row order,
   * which sorted on "has a flag at all" and then on least-billed percent. A
   * 0%-billed job therefore beat every other flag by construction.
   *
   * Live on the dashboard 2026-09-25: all six rows read "nothing billed yet",
   * the LOWEST-priority flag, on jobs worth $950, $1.5k, $3k, $3.1k, $16k and
   * $40k — while AIREF Building #1 was off the list with $113,129.18 awaiting
   * payment. Six trivia rows pushing the largest collectable off the page
   * Alex opens every morning.
   */
  it("puts money owed above a job nobody has billed yet", () => {
    const owed = job({
      oppId: "owed",
      billedCents: 189_434_20,
      contractCents: 283_082_00,
      outstandingCents: 113_129_18,
    });
    const untouched = job({ oppId: "untouched", billedCents: 0, contractCents: 950_00 });
    expect(jobFlag(owed)).toBe("awaiting payment");
    expect(jobFlag(untouched)).toBe("nothing billed yet");
    expect(rankJobsInFlight([untouched, owed]).map((j) => j.oppId)).toEqual([
      "owed",
      "untouched",
    ]);
  });

  it("keeps a blocked crew above money owed", () => {
    // The flag order is not "biggest number wins" — a crew that cannot start
    // outranks an invoice, however large.
    const blocked = job({ oppId: "blocked", contractCents: 2_000_00, billedCents: 0, workOrderUnsent: true });
    const owed = job({ oppId: "owed", billedCents: 500_000_00, contractCents: 600_000_00, outstandingCents: 500_000_00 });
    expect(rankJobsInFlight([owed, blocked]).map((j) => j.oppId)).toEqual(["blocked", "owed"]);
  });

  it("inside one flag, the most money at stake first", () => {
    const smallOwed = job({ oppId: "small", billedCents: 1_000_00, contractCents: 5_000_00, outstandingCents: 1_000_00 });
    const bigOwed = job({ oppId: "big", billedCents: 90_000_00, contractCents: 100_000_00, outstandingCents: 90_000_00 });
    expect(rankJobsInFlight([smallOwed, bigOwed]).map((j) => j.oppId)).toEqual(["big", "small"]);
  });

  it("among flagged jobs, the least-billed first", () => {
    const a = job({ oppId: "a", billedCents: 20_000_00, workOrderUnsent: true });
    const b = job({ oppId: "b", billedCents: 1_000_00, workOrderUnsent: true });
    expect(rankJobsInFlight([a, b]).map((j) => j.oppId)).toEqual(["b", "a"]);
  });

  it("is stable — the strip must not reshuffle between page loads", () => {
    const rows = [job({ oppId: "b" }), job({ oppId: "a" }), job({ oppId: "c" })];
    const once = rankJobsInFlight(rows).map((j) => j.oppId);
    const twice = rankJobsInFlight([...rows].reverse()).map((j) => j.oppId);
    expect(once).toEqual(twice);
  });

  it("caps the list so the Overview stays an overview", () => {
    const many = Array.from({ length: 30 }, (_, i) => job({ oppId: `o${i}`, workOrderUnsent: true }));
    expect(rankJobsInFlight(many)).toHaveLength(6);
  });

  it("renders nothing from nothing", () => {
    expect(rankJobsInFlight([])).toEqual([]);
  });
});
