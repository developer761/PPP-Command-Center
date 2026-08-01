import { describe, it, expect } from "vitest";
import { sumPaymentsBeforeStable } from "@/lib/commercial/invoices/db";

/**
 * Concurrency-fix core (audit re-review Findings 1 & 2). The post-insert trim
 * decides how much a payment may keep from `cap = total − sumBefore`. The whole
 * correctness of the fix hinges on `sumPaymentsBeforeStable` giving EVERY racer
 * the same "who comes before whom" answer, so two simultaneous payments don't
 * both back out. These pin that stable ordering.
 */
describe("sumPaymentsBeforeStable", () => {
  const P = (id: string, amount: number, created_at: string) => ({ id, amount_cents: amount, created_at });

  it("sums only the payments ordered before pid (by created_at)", () => {
    const rows = [P("b", 100, "2026-08-16T10:00:01Z"), P("a", 200, "2026-08-16T10:00:00Z"), P("c", 50, "2026-08-16T10:00:02Z")];
    expect(sumPaymentsBeforeStable(rows, "a")).toBe(0);   // earliest
    expect(sumPaymentsBeforeStable(rows, "b")).toBe(200); // after a
    expect(sumPaymentsBeforeStable(rows, "c")).toBe(300); // after a + b
  });

  it("is deterministic across racers: the tail payment trims, the earlier one keeps (invoice $100, two $100)", () => {
    // Two simultaneous $100 payments on a $100 invoice. created_at ties broken by id.
    const rows = [P("pay-A", 100, "2026-08-16T10:00:00.000Z"), P("pay-B", 100, "2026-08-16T10:00:00.000Z")];
    const total = 100;
    // Racer A (lower id) keeps full; racer B trims to remaining.
    const allowedA = Math.max(0, total - sumPaymentsBeforeStable(rows, "pay-A"));
    const allowedB = Math.max(0, total - sumPaymentsBeforeStable(rows, "pay-B"));
    expect(allowedA).toBe(100); // A is first in stable order → keeps all
    expect(allowedB).toBe(0);   // B is second → nothing left, trims out
    // Crucially they DON'T both back out (old bug): exactly one survives.
    expect(allowedA + allowedB).toBe(100);
  });

  it("uses id only to break exact created_at ties (stable, not insertion-random)", () => {
    const rows = [P("z", 10, "2026-08-16T10:00:00Z"), P("a", 10, "2026-08-16T10:00:00Z")];
    expect(sumPaymentsBeforeStable(rows, "a")).toBe(0);  // "a" < "z"
    expect(sumPaymentsBeforeStable(rows, "z")).toBe(10); // after "a"
  });

  it("milestone over-collection: filtering to one milestone's payments still orders stably", () => {
    // Two $100 payments tagged to a $100 milestone → second one has no room.
    const rows = [P("m1", 100, "2026-08-16T10:00:00.000Z"), P("m2", 100, "2026-08-16T10:00:00.001Z")];
    const milestoneAmount = 100;
    expect(Math.max(0, milestoneAmount - sumPaymentsBeforeStable(rows, "m1"))).toBe(100);
    expect(Math.max(0, milestoneAmount - sumPaymentsBeforeStable(rows, "m2"))).toBe(0);
  });

  it("sums the whole pool when pid is absent (fail-safe: caller then trims to 0)", () => {
    // If we can't find our own row, everything counts as "before" → allowed 0.
    expect(sumPaymentsBeforeStable([P("a", 100, "2026-08-16T10:00:00Z")], "missing")).toBe(100);
    expect(sumPaymentsBeforeStable([], "x")).toBe(0);
  });
});
