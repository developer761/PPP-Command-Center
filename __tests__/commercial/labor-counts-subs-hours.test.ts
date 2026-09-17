import { describe, it, expect } from "vitest";

import { laborLineFor } from "@/lib/commercial/reports/labor";

/**
 * A subcontractor's HOURS count. Their hours are not their cost.
 *
 * Katie 2026-09-17: "the Labor payouts from Salesforce aren't showing up in
 * Command Center."
 *
 * They were in the book the whole time — 815 rows, $555,789.53 — and the Labor
 * report could not see any of it. The report opened its loop with
 * `if (!w2.has(employeeId)) continue`, and every one of Tomco's 23 crew is
 * `worker_type = 'sub'`, because they pay crews through labor companies rather
 * than payroll. So the filter excluded 100% of the workforce and the report was
 * structurally blank — in every period, forever — while sitting next to 14,992
 * approved hours.
 *
 * The filter was half right, and that is why it survived review: pricing a
 * sub's hours from a rate card AND counting the payout to their company really
 * would double the cost. What it got wrong was throwing the HOURS away too.
 * Nothing else counts those hours, so there was nothing to double.
 *
 * This pins the rule that broke, not the report around it: a DB-backed report
 * cannot run in this suite, which is why the rule now lives in a pure function
 * that the report's own loop calls.
 */

describe("how one approved shift lands on the labor report", () => {
  it("counts a sub's hours, and gives them no rate-priced cost", () => {
    // THE REGRESSION. Restore `if (!isW2) continue` and this goes to 0 hours.
    const line = laborLineFor({ isW2: false, hours: 8, rateCents: null });
    expect(line.hours).toBe(8);
    expect(line.costCents).toBe(0);
  });

  it("does not call a sub 'unrated' — they have no rate by design", () => {
    // Counting them here would put all 23 crew under "no cost rate on file",
    // sending Mary to set 23 rates that must never exist: a rate plus a payout
    // is the double-count the whole split exists to prevent.
    expect(laborLineFor({ isW2: false, hours: 8, rateCents: null }).unratedHours).toBe(0);
    // Even if somebody has typed a rate against a sub, it must not become cost.
    expect(laborLineFor({ isW2: false, hours: 8, rateCents: 5000 }).costCents).toBe(0);
  });

  it("prices a W-2 hour from the rate in force", () => {
    expect(laborLineFor({ isW2: true, hours: 8, rateCents: 4250 }).costCents).toBe(34_000);
    expect(laborLineFor({ isW2: true, hours: 7.5, rateCents: 4133 }).costCents).toBe(30_998); // rounds, never truncates
  });

  it("still flags a W-2 hour with no rate as unpriced", () => {
    // The honesty line the report is built on: an unpriced hour makes the cost
    // column an understatement, which overstates margin everywhere downstream.
    const line = laborLineFor({ isW2: true, hours: 6, rateCents: null });
    expect(line.hours).toBe(6);
    expect(line.costCents).toBe(0);
    expect(line.unratedHours).toBe(6);
  });

  it("ignores a shift with no hours on it", () => {
    for (const hours of [0, -3, Number.NaN]) {
      const line = laborLineFor({ isW2: true, hours, rateCents: 5000 });
      expect(line.hours).toBe(0);
      expect(line.costCents).toBe(0);
      expect(line.unratedHours).toBe(0);
    }
  });

  it("never lets a sub contribute to both money columns", () => {
    // The invariant behind the whole report, stated once: for any shift, at
    // most one of the two money accounts can be non-zero from this function.
    // The other — the payout to the crew's company — is added elsewhere, and
    // the two are never summed.
    for (const isW2 of [true, false]) {
      for (const rateCents of [null, 0, 5000]) {
        const line = laborLineFor({ isW2, hours: 8, rateCents });
        if (!isW2) expect(line.costCents).toBe(0);
        expect(line.hours).toBe(8);
      }
    }
  });
});
