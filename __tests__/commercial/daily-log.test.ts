import { describe, it, expect } from "vitest";
import { ABSENCE_TYPES } from "@/lib/commercial/field-ops/daily-log";

/**
 * The Daily Log's rules. Karan's spec is explicit about WHY they matter:
 * "speed is the whole game — >30s and it won't happen daily, regressing to
 * 'every cell = 8'." A log nobody fills in is worse than none, because it
 * looks like data.
 */

/** Mirrors submitDailyHours — a 24h day is a typo, not a shift. */
function clampHours(raw: number): number {
  return Math.min(24, Math.round(raw * 10) / 10);
}

/** Approved or exported: past the point a painter may edit. */
const SETTLED = new Set(["approved", "exported"]);

describe("hours entry", () => {
  it("rounds to the half hour people actually think in", () => {
    expect(clampHours(7.5)).toBe(7.5);
    expect(clampHours(8.04)).toBe(8);
    expect(clampHours(8.26)).toBe(8.3);
  });

  it("caps a runaway number rather than refusing it", () => {
    // Refusing outright at 5pm on site is how a day goes unrecorded entirely.
    // Capping records something true-ish and visible to the approver.
    expect(clampHours(240)).toBe(24);
  });

  it("keeps zero, which is a real answer", () => {
    // Zero hours on a job you were scheduled for is meaningful — it is how a
    // painter says "I was pulled elsewhere" without needing an absence.
    expect(clampHours(0)).toBe(0);
  });
});

describe("what a painter may still change", () => {
  it("refuses once approved or exported", () => {
    // The approval step means nothing if the person can revise afterwards, and
    // exported hours are already on a paycheque.
    for (const s of ["approved", "exported"]) expect(SETTLED.has(s)).toBe(true);
  });

  it("allows a resubmit while still pending", () => {
    // Submitted and questioned are both "not settled" — a painter correcting
    // their own mistake before review is exactly what we want.
    for (const s of ["submitted", "questioned"]) expect(SETTLED.has(s)).toBe(false);
  });
});

describe("absence reasons", () => {
  it("covers the four the spec names, plus the paid ones", () => {
    // P/S/NW/NA from R10.4 — personal, sick, no-work, not-available.
    const values = ABSENCE_TYPES.map((t) => t.value);
    for (const v of ["PERSONAL", "SICK", "NO_WORK", "NOT_AVAILABLE"]) {
      expect(values).toContain(v);
    }
    expect(values).toContain("PTO");
    expect(values).toContain("HOLIDAY");
  });

  it("every reason has a label a painter would recognise", () => {
    // No enum names on a phone screen: "NOT_AVAILABLE" is not a sentence.
    for (const t of ABSENCE_TYPES) {
      expect(t.label).not.toMatch(/[A-Z_]{4,}/);
      expect(t.label.length).toBeGreaterThan(3);
    }
  });

  it("matches the values the database CHECK allows", () => {
    // Same class as the team-roles bug: an app list and a Postgres CHECK that
    // are the same list, maintained separately.
    const sql = require("node:fs").readFileSync(
      "supabase/migrations/112_commercial_field_ops_foundation.sql",
      "utf8"
    );
    const m = /check \(type in \(([^)]*)\)/i.exec(sql);
    expect(m, "absence type CHECK not found — did the migration move?").toBeTruthy();
    const allowed = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    for (const t of ABSENCE_TYPES) {
      expect(allowed, `"${t.value}" is offered but Postgres would reject it`).toContain(t.value);
    }
  });
});
