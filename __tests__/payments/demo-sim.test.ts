import { describe, expect, it } from "vitest";
import { parsePaid, simCharge, simSchedule } from "@/lib/payments/demo-sim";

describe("simulated demo", () => {
  it("reads only c/d/b from the URL, at most one per term", () => {
    expect(parsePaid("cd")).toEqual(["c", "d"]);
    expect(parsePaid("c<x>b")).toEqual(["c", "b"]);
    expect(parsePaid("cdbcd")).toEqual(["c", "d", "b"]);
    expect(parsePaid(undefined)).toEqual([]);
  });

  it("starts with the Deposit due and $5,000 owed", () => {
    const s = simSchedule([]);
    expect(s.payableBalanceCents).toBe(500000);
    expect(s.milestones.map((m) => m.status)).toEqual(["due", "upcoming", "upcoming"]);
  });

  it("moves term by term; a bank transfer shows as processing", () => {
    expect(simSchedule(["c"]).milestones.map((m) => m.status)).toEqual(["paid", "due", "upcoming"]);
    const s = simSchedule(["c", "b"]);
    expect(s.milestones.map((m) => m.status)).toEqual(["paid", "processing", "due"]);
    expect(s.payableBalanceCents).toBe(150000);
    expect(simSchedule(["c", "d", "b"]).payableBalanceCents).toBe(0);
  });

  it("charges 3% on credit only", () => {
    expect(simCharge(0, "c")).toEqual({ baseCents: 150000, feeCents: 4500, totalCents: 154500 });
    expect(simCharge(1, "d")).toEqual({ baseCents: 200000, feeCents: 0, totalCents: 200000 });
    expect(simCharge(2, "b")).toEqual({ baseCents: 150000, feeCents: 0, totalCents: 150000 });
  });
});
