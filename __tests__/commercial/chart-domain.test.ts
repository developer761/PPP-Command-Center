import { describe, it, expect } from "vitest";
import { chartDomain } from "@/components/trend-chart";

/**
 * Currency series reach this function in **$K** — $100 arrives as 0.1. That unit
 * is the whole reason the axis lied: the old headroom used
 * `Math.max(1, max - min)`, a floor of one THOUSAND dollars, so a small account
 * got an axis 2.8× its real maximum and a line squashed into a third of the
 * chart.
 */
describe("chartDomain", () => {
  it("does not invent a ceiling for a small currency series", () => {
    // The account Karan was looking at: one $100 invoice, five empty months.
    // The axis read "$280".
    const { yMax } = chartDomain([0, 0, 0, 0, 0, 0.1]);
    expect(yMax).toBeLessThan(0.13); // i.e. under $130, not $280
    expect(yMax).toBeGreaterThanOrEqual(0.1); // still above the real max
  });

  it("scales headroom to the data, at any magnitude", () => {
    // The same shape at $100, $100k and $10M must produce the same relative
    // headroom — nothing about the units should change the picture.
    for (const scale of [0.1, 100, 10_000]) {
      const { yMax } = chartDomain([0, scale]);
      expect(yMax / scale, `scale=${scale}`).toBeCloseTo(1.18, 5);
    }
  });

  it("plots the peak near the top of the chart, not a third of the way up", () => {
    // yRange is the plotting denominator. Forcing it to 1 while the domain
    // spanned 0.28 drew the line at 10% height on a chart whose axis claimed
    // otherwise.
    const { yMax, yMin, yRange } = chartDomain([0, 0.1]);
    const peakHeight = (0.1 - yMin) / yRange;
    expect(peakHeight).toBeGreaterThan(0.8);
    expect(yRange).toBeCloseTo(yMax - yMin, 10);
  });

  it("keeps a flat-zero series honest at [0, 0]", () => {
    // An empty deal, a brand-new job, a period with nothing billed. An earlier
    // version printed a phantom "$180" ceiling above a line of nothing.
    const d = chartDomain([0, 0, 0, 0, 0, 0]);
    expect(d.yMax).toBe(0);
    expect(d.yMin).toBe(0);
    expect(d.yRange).toBe(1); // guard only — never divides by zero
  });

  it("shows a flat non-zero series at its own value", () => {
    // $100 every month should read $100 at the top, baselined at zero — not a
    // fraction of some invented ceiling.
    const d = chartDomain([0.1, 0.1, 0.1]);
    expect(d.yMax).toBe(0.1);
    expect(d.yMin).toBe(0);
    expect((0.1 - d.yMin) / d.yRange).toBe(1);
  });

  it("never drops the axis below zero for an all-positive series", () => {
    // A negative floor on money that can't go negative reads as a loss.
    const d = chartDomain([5, 9, 20]);
    expect(d.yMin).toBeGreaterThanOrEqual(0);
  });

  it("always leaves the top of the data inside the domain", () => {
    for (const series of [
      [0, 0.1],
      [3, 3, 9],
      [0.001, 0.002],
      [12, 4, 7, 19],
      [0, 0, 0.0001],
    ]) {
      const { yMax, yMin } = chartDomain(series);
      expect(Math.max(...series), JSON.stringify(series)).toBeLessThanOrEqual(yMax);
      expect(Math.min(...series), JSON.stringify(series)).toBeGreaterThanOrEqual(yMin);
    }
  });

  it("returns a usable range for every series, so nothing divides by zero", () => {
    for (const series of [[0], [0, 0], [7], [0.1, 0.1], [0, 5]]) {
      expect(chartDomain(series).yRange, JSON.stringify(series)).toBeGreaterThan(0);
    }
  });
});
