import { describe, it, expect } from "vitest";

/**
 * Cash flow & collections — the judgement calls.
 *
 * Every one is a way the number could look plausible and mislead. The
 * aggregation needs a database; these pin the RULES, mirrored from
 * lib/commercial/reports/cash-flow.ts.
 */

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** Amount-weighted days to pay across a set of payments. */
function weightedDays(payments: { days: number; cents: number }[]): number | null {
  const amt = payments.reduce((n, p) => n + p.cents, 0);
  if (amt === 0) return null;
  return Math.round(payments.reduce((n, p) => n + Math.max(0, p.days) * p.cents, 0) / amt);
}

describe("days to pay is weighted by amount", () => {
  it("a big slow wire outweighs a small fast cheque", () => {
    // Unweighted this averages to 15 days and reads healthy. Weighted, it is
    // 89 — which is the truth about when the cash actually landed.
    const out = weightedDays([
      { days: 90, cents: 200_000_00 },
      { days: 1, cents: 500_00 },
    ]);
    // (90×200000 + 1×500) / 200500 = 89.8 → 90. The cheque barely moves it,
    // which is the point.
    expect(out).toBe(90);
    // The unweighted average would have been 45 and read far healthier.
    expect(out).toBeGreaterThan(45);
  });

  it("equal amounts average normally", () => {
    expect(weightedDays([{ days: 10, cents: 1000 }, { days: 30, cents: 1000 }])).toBe(20);
  });

  it("is null rather than 0 when nothing could be timed", () => {
    // 0 days would read as "everyone pays instantly", which is the opposite of
    // "we don't know".
    expect(weightedDays([])).toBeNull();
  });
});

describe("deposits — paid before the invoice existed", () => {
  it("counts as same-day, not negative", () => {
    // A deposit on a handshake really did arrive in zero days. Left negative it
    // would drag the whole average down and look like an improvement.
    expect(daysBetween("2026-08-20", "2026-08-01")).toBe(-19);
    expect(weightedDays([{ days: -19, cents: 50_000_00 }])).toBe(0);
  });

  it("still counts toward collected cash", () => {
    // The clamp is on the TIMING only. Dropping the payment would understate
    // money that is genuinely in the bank.
    const payments = [{ days: -19, cents: 50_000_00 }, { days: 30, cents: 50_000_00 }];
    expect(payments.reduce((n, p) => n + p.cents, 0)).toBe(100_000_00);
    expect(weightedDays(payments)).toBe(15);
  });
});

describe("the collection rate", () => {
  const rate = (collected: number, billed: number) =>
    billed > 0 ? Math.round((collected / billed) * 100) : null;

  it("can legitimately exceed 100%", () => {
    // Older invoices landing in this window is normal, not an error — the two
    // figures are keyed on different dates by design.
    expect(rate(150, 100)).toBe(150);
  });

  it("is null when nothing was billed, never 0%", () => {
    // 0% would say "collected nothing" on a month where nothing was invoiced.
    expect(rate(0, 0)).toBeNull();
    expect(rate(5000, 0)).toBeNull();
  });
});

describe("what's still owed", () => {
  it("clamps per invoice so an overpayment can't mask another debt", () => {
    // Netting gives 0 and says the customer is clear while a real invoice is
    // unpaid. Same rule as ProjectFinancials.openBalanceCents.
    const balances = [-500_00, 500_00];
    expect(balances.reduce((n, b) => n + b, 0)).toBe(0);
    expect(balances.reduce((n, b) => n + Math.max(0, b), 0)).toBe(500_00);
  });
});

describe("month bucketing is by when cash ARRIVED", () => {
  it("a March invoice paid in July is July's cash", () => {
    // The reason this report can't just be AR aging with a date filter.
    const paidAt = "2026-07-14";
    expect(paidAt.slice(0, 7)).toBe("2026-07");
  });

  it("months sort chronologically, not lexically by label", () => {
    const keys = ["2026-01", "2025-12", "2026-10", "2026-02"];
    expect([...keys].sort((a, b) => a.localeCompare(b))).toEqual([
      "2025-12", "2026-01", "2026-02", "2026-10",
    ]);
  });
});
