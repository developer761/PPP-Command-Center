import { describe, it, expect } from "vitest";
import { weeklyExportedRows } from "@/lib/commercial/field-ops/payroll";

/**
 * Round-3 handoff #3: redownloadPayroll summed an employee's hours over the
 * WHOLE range and capped regular at 40, so a re-download spanning two weeks
 * turned two sub-40h weeks into one >40h range and invented overtime the
 * original weekly export never paid. weeklyExportedRows is the corrected core:
 * OT splits at 40h PER WEEK. These tests fail against the old per-range logic.
 */

const META = new Map([
  ["e1", { name: "Bravo, Ana", external_ref: "A-1" }],
  ["e2", { name: "Alpha, Zed", external_ref: "Z-9" }],
]);

// 2026-08-04 (Tue) and 2026-08-11 (Tue) are in DIFFERENT Mon–Sun weeks.
describe("weeklyExportedRows — OT splits per week, not per range", () => {
  it("two sub-40h weeks stay all-regular (the regression)", () => {
    const rows = weeklyExportedRows(
      [
        { employee_id: "e1", work_date: "2026-08-04", actual_hours: 35 },
        { employee_id: "e1", work_date: "2026-08-11", actual_hours: 35 },
      ],
      META
    );
    expect(rows).toHaveLength(1);
    // Per-week: 35 + 35, each under 40 → no OT. Old per-range code gave 40/30.
    expect(rows[0]).toMatchObject({ reg: 70, ot: 0, total: 70 });
  });

  it("hours over 40 within a single week become OT", () => {
    const rows = weeklyExportedRows(
      [
        { employee_id: "e1", work_date: "2026-08-04", actual_hours: 30 },
        { employee_id: "e1", work_date: "2026-08-05", actual_hours: 20 },
      ],
      META
    );
    expect(rows[0]).toMatchObject({ reg: 40, ot: 10, total: 50 });
  });

  it("OT is counted independently in each week", () => {
    const rows = weeklyExportedRows(
      [
        { employee_id: "e1", work_date: "2026-08-04", actual_hours: 50 }, // week 1: 40 + 10 OT
        { employee_id: "e1", work_date: "2026-08-11", actual_hours: 45 }, // week 2: 40 + 5 OT
      ],
      META
    );
    // Per-week OT = 10 + 5 = 15. Per-range would be 95 → 40 reg / 55 OT.
    expect(rows[0]).toMatchObject({ reg: 80, ot: 15, total: 95 });
  });

  it("returns one row per employee, sorted by name", () => {
    const rows = weeklyExportedRows(
      [
        { employee_id: "e1", work_date: "2026-08-04", actual_hours: 8 },
        { employee_id: "e2", work_date: "2026-08-04", actual_hours: 8 },
      ],
      META
    );
    expect(rows.map((r) => r.name)).toEqual(["Alpha, Zed", "Bravo, Ana"]);
  });

  it("drops employees with no hours and tolerates unknown ids", () => {
    const rows = weeklyExportedRows(
      [
        { employee_id: "e1", work_date: "2026-08-04", actual_hours: 0 },
        { employee_id: "ghost", work_date: "2026-08-04", actual_hours: 12 },
      ],
      META
    );
    expect(rows).toEqual([{ name: "Unknown", ref: null, reg: 12, ot: 0, total: 12 }]);
  });
});
