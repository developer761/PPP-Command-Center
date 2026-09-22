import { describe, it, expect } from "vitest";
import { splitWeekHours } from "@/lib/commercial/field-ops/overview";

/**
 * "Approved this week" read 0h while Mary approved a full week of crew time.
 *
 * The Field Ops tile counted approved hours for W-2 employees only, on the
 * reasoning that it should match what Payroll pays. Every one of Tomco's 23
 * crew is `worker_type = 'sub'` — they pay crews through labor companies — so
 * the filter excluded 100% of the workforce and the tile was pinned at zero.
 * Measured against the live database on 2026-09-22: 760 approved hours since
 * 2026-09-01, displayed as 0h.
 *
 * The tell was the tile beside it. "Time to review" counts submitted entries
 * with no W-2 filter at all, so clearing the queue moved one number and not
 * the other, and there was no way to tell from the screen which one was lying.
 */
const SUB = "sub-1";
const W2 = "w2-1";

describe("splitWeekHours", () => {
  it("counts an approved SUB entry — this is the regression", () => {
    const r = splitWeekHours([{ employee_id: SUB, actual_hours: 8, status: "approved" }], new Set([W2]));
    expect(r.approved).toBe(8);
    // …and it is honestly excluded from the payroll caption, which IS W-2 only.
    expect(r.approvedPayroll).toBe(0);
  });

  it("an all-sub workforce still reports the hours it worked", () => {
    const week = Array.from({ length: 5 }, () => ({ employee_id: SUB, actual_hours: 8, status: "approved" }));
    const r = splitWeekHours(week, new Set());
    expect(r.approved).toBe(40);
    expect(r.approvedPayroll).toBe(0);
  });

  it("separates the payroll slice when the crew is mixed", () => {
    const r = splitWeekHours(
      [
        { employee_id: W2, actual_hours: 10, status: "approved" },
        { employee_id: SUB, actual_hours: 6, status: "exported" },
      ],
      new Set([W2]),
    );
    expect(r.approved).toBe(16);
    expect(r.approvedPayroll).toBe(10);
  });

  it("clocked counts every status; approved counts only settled ones", () => {
    const r = splitWeekHours(
      [
        { employee_id: SUB, actual_hours: 8, status: "submitted" },
        { employee_id: SUB, actual_hours: 4, status: "questioned" },
        { employee_id: SUB, actual_hours: 5, status: "approved" },
        { employee_id: SUB, actual_hours: 3, status: "exported" },
      ],
      new Set(),
    );
    expect(r.clocked).toBe(20);
    // Submitted and questioned time is not signed off, so it is not approved.
    expect(r.approved).toBe(8);
  });
});
