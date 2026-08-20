import { describe, it, expect } from "vitest";
import {
  resolvePreset,
  CASH_FLOW_PRESETS, CASH_FLOW_DEFAULT, cashFlowRange,
  LABOR_PRESETS, LABOR_DEFAULT, laborRange,
  ESTIMATOR_PRESETS, ESTIMATOR_DEFAULT, estimatorRange,
  CHANGE_ORDER_PRESETS, CHANGE_ORDER_DEFAULT, changeOrderRange,
} from "@/lib/commercial/reports/presets";

/**
 * These ranges are now shared between each report page and its export route.
 * The point of the tests is that both callers get a well-formed, ordered window
 * for every preset — a malformed one silently exports the wrong period, and the
 * spreadsheet gives no hint that it did.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

describe("resolvePreset", () => {
  it("accepts a known key", () => {
    expect(resolvePreset("last_12m", CASH_FLOW_PRESETS, CASH_FLOW_DEFAULT)).toBe("last_12m");
  });

  it("falls back on anything unknown, missing, or hostile", () => {
    for (const bad of [undefined, "", "nope", "../../etc", "DROP TABLE"]) {
      expect(resolvePreset(bad, CASH_FLOW_PRESETS, CASH_FLOW_DEFAULT)).toBe(CASH_FLOW_DEFAULT);
    }
  });

  it("takes the first value when the param is repeated", () => {
    expect(resolvePreset(["this_year", "last_year"], CASH_FLOW_PRESETS, CASH_FLOW_DEFAULT)).toBe("this_year");
  });

  it("rejects a key from a DIFFERENT report's preset list", () => {
    // ?preset=all is valid for change orders, not for cash flow.
    expect(resolvePreset("all", CASH_FLOW_PRESETS, CASH_FLOW_DEFAULT)).toBe(CASH_FLOW_DEFAULT);
  });
});

describe("every preset yields a valid, ordered window", () => {
  const cases: [string, () => { fromYmd: string; toYmd: string; label: string }][] = [
    ...CASH_FLOW_PRESETS.map((p) => [`cashFlow:${p.key}`, () => cashFlowRange(p.key)] as const),
    ...LABOR_PRESETS.map((p) => [`labor:${p.key}`, () => laborRange(p.key)] as const),
    ...CHANGE_ORDER_PRESETS.map((p) => [`changeOrder:${p.key}`, () => changeOrderRange(p.key)] as const),
    // Both a calendar year (1) and a non-calendar fiscal year (2 = Feb start).
    ...ESTIMATOR_PRESETS.map((p) => [`estimator:${p.key}:fy1`, () => estimatorRange(p.key, 1)] as const),
    ...ESTIMATOR_PRESETS.map((p) => [`estimator:${p.key}:fy2`, () => estimatorRange(p.key, 2)] as const),
  ];

  for (const [name, fn] of cases) {
    it(name, () => {
      const r = fn();
      expect(r.fromYmd).toMatch(YMD);
      expect(r.toYmd).toMatch(YMD);
      // A reversed window returns nothing at all and looks like "no data".
      expect(r.fromYmd <= r.toYmd).toBe(true);
      expect(r.label.length).toBeGreaterThan(0);
    });
  }
});

describe("window semantics", () => {
  it("cash flow: 12 months is a strictly wider window than 6", () => {
    expect(cashFlowRange("last_12m").fromYmd < cashFlowRange("last_6m").fromYmd).toBe(true);
  });

  it("labour: last month is a complete calendar month", () => {
    const r = laborRange("last_month");
    expect(r.fromYmd.endsWith("-01")).toBe(true);
    expect(r.fromYmd.slice(0, 7)).toBe(r.toYmd.slice(0, 7));
    // Ends on a real last-day (28-31), never the 1st.
    expect(Number(r.toYmd.slice(8, 10))).toBeGreaterThanOrEqual(28);
  });

  it("change orders: 'all' reaches back before any record exists", () => {
    expect(changeOrderRange("all").fromYmd).toBe("2000-01-01");
  });

  it("estimator: a non-calendar fiscal year starts on its configured month", () => {
    const r = estimatorRange("this_year", 2);
    expect(r.fromYmd.slice(5, 7)).toBe("02");
    expect(r.label.startsWith("FY")).toBe(true);
  });

  it("estimator: a calendar fiscal year is labelled as a plain year, not FY", () => {
    const r = estimatorRange("this_year", 1);
    expect(r.fromYmd.slice(5, 7)).toBe("01");
    expect(r.label.startsWith("FY")).toBe(false);
  });

  it("estimator: last fiscal year ends the day before this one starts", () => {
    for (const fy of [1, 2, 7, 12]) {
      const prev = estimatorRange("last_year", fy);
      const cur = estimatorRange("this_year", fy);
      const dayAfterPrev = new Date(`${prev.toYmd}T00:00:00Z`);
      dayAfterPrev.setUTCDate(dayAfterPrev.getUTCDate() + 1);
      // No gap and no overlap between consecutive fiscal years.
      expect(dayAfterPrev.toISOString().slice(0, 10)).toBe(cur.fromYmd);
    }
  });
});
