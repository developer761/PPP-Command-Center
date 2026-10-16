import { describe, it, expect } from "vitest";
import { foldPeriodBilling, type PeriodInvoice, type PeriodAiaApp } from "@/lib/commercial/reports/period-billing";
import { billedMonthsInRange, needsHeadFold, monthEnd } from "@/lib/commercial/reports/cash-flow";

/**
 * THE COLLECTION RATE READ 642%.
 *
 * `getCashFlowReport` folds AIA payments into `collected` — on a contractor
 * who bills most commercial work by G702 that is most of the money — and
 * divided it by a `billed` loop that walked `commercial_invoices` alone.
 * Measured against production on 2026-10-16 over 2026-05-01 → 2026-10-16:
 *
 *   collected  $974,243.71  = $194,048.68 invoice + $780,195.03 AIA
 *   billed     $151,722.86  = invoices only
 *   rate              642%  under a caption reading "over 100% just means
 *                            older invoices landed"
 *
 * Both ledgers: $1,386,221.66 billed, and the rate is 70%.
 *
 * These tests do not touch the database and do not read source text. They pin
 * the two things the fix rests on: that the shared `period-billing` fold is
 * the denominator (so AIA-only billing is counted and the dashboard and this
 * report cannot disagree), and that clipping that fold to a range always sums
 * back to the range total — otherwise the chart's two lines drift apart again,
 * quietly, at the edges.
 */

const RANGE = { fromYmd: "2026-05-01", toYmd: "2026-10-16", label: "last 6m" };

/** A taxable invoice. `subtotal_cents` is what the fold reads; the cash-flow
 *  caller hands it `total_cents` so cash is measured against what the customer
 *  was actually asked for. */
const invoice = (over: Partial<PeriodInvoice> = {}): PeriodInvoice => ({
  status: "sent",
  subtotal_cents: 100_00,
  issued_at: "2026-06-10T16:00:00Z",
  created_at: "2026-06-01T16:00:00Z",
  opportunity_id: "opp-invoiced",
  ...over,
});

const app = (over: Partial<PeriodAiaApp> = {}): PeriodAiaApp => ({
  id: "app-1",
  opportunity_id: "opp-aia",
  application_number: 1,
  status: "paid",
  frozen_at: "2026-10-01T16:00:00Z",
  period_to: "2026-06-30",
  ...over,
});

describe("the collection-rate denominator", () => {
  it("counts a job billed only through G702, which has no invoice row at all", () => {
    // The whole shape of the bug: $780k of AIA cash over a denominator that
    // cannot see AIA.
    const invoiceOnly = foldPeriodBilling([invoice({ subtotal_cents: 194_048_68 })], [], new Map(), RANGE);
    expect(invoiceOnly.totalCents).toBe(194_048_68);

    const bothLedgers = foldPeriodBilling(
      [invoice({ subtotal_cents: 194_048_68 })],
      [app()],
      new Map([["app-1", 780_195_03]]),
      RANGE
    );
    expect(bothLedgers.totalCents).toBe(974_243_71);

    // The rate the two denominators produce for the same $974,243.71 of cash.
    const rate = (billed: number) => Math.round((974_243_71 / billed) * 100);
    expect(rate(invoiceOnly.totalCents)).toBe(502);
    expect(rate(bothLedgers.totalCents)).toBe(100);
  });

  it("takes each certificate's INCREMENT, so three applications are not billed three times", () => {
    // App 2 completed-to-date $70k is $45k of new work on top of app 1's $25k.
    // Summing completed-to-date instead would report $160k against $70k billed.
    const b = foldPeriodBilling(
      [],
      [
        app({ id: "a1", application_number: 1, period_to: "2026-05-31" }),
        app({ id: "a2", application_number: 2, period_to: "2026-06-30" }),
        app({ id: "a3", application_number: 3, period_to: "2026-07-31" }),
      ],
      new Map([
        ["a1", 25_000_00],
        ["a2", 70_000_00],
        ["a3", 90_000_00],
      ]),
      RANGE
    );
    expect(b.totalCents).toBe(90_000_00);
    expect(b.monthly.get("2026-05")).toBe(25_000_00);
    expect(b.monthly.get("2026-06")).toBe(45_000_00);
    expect(b.monthly.get("2026-07")).toBe(20_000_00);
  });

  it("excludes a draft, so billed matches the receivable basis the same report uses", () => {
    const b = foldPeriodBilling(
      [invoice({ subtotal_cents: 100_00 }), invoice({ status: "draft", subtotal_cents: 900_00 })],
      [],
      new Map(),
      RANGE
    );
    expect(b.totalCents).toBe(100_00);
  });
});

describe("clipping the billed line to the range", () => {
  // The months the fold reports, unrestricted — this is what `monthly` is.
  const monthly = new Map([
    ["2026-04", 19_484_65],
    ["2026-05", 94_815_19],
    ["2026-06", 171_762_26],
    ["2026-07", 259_089_63],
    ["2026-08", 301_510_24],
    ["2026-09", 357_249_34],
    ["2026-10", 201_795_00],
  ]);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((n, v) => n + v, 0);

  it("knows which windows need a second fold, and which do not", () => {
    // Every cash-flow preset starts on the 1st: at most the tail is partial.
    expect(needsHeadFold({ fromYmd: "2026-05-01", toYmd: "2026-10-16" })).toBe(false);
    expect(needsHeadFold({ fromYmd: "2025-01-01", toYmd: "2025-12-31" })).toBe(false);
    expect(needsHeadFold({ fromYmd: "2026-05-15", toYmd: "2026-09-10" })).toBe(true);
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2024-02")).toBe("2024-02-29");
  });

  it("sums to the range total when only the tail month is partial", () => {
    // Range-exact total: Oct is clipped at the 16th, so it is NOT the $201,795
    // the whole month carries.
    const total = 94_815_19 + 171_762_26 + 259_089_63 + 301_510_24 + 357_249_34 + 150_000_00;
    const months = billedMonthsInRange(monthly, total, { fromYmd: "2026-05-01", toYmd: "2026-10-16" });
    expect(sum(months)).toBe(total);
    expect(months.get("2026-10")).toBe(150_000_00);
    // Whole months pass through untouched, and April is outside the window.
    expect(months.get("2026-06")).toBe(171_762_26);
    expect(months.has("2026-04")).toBe(false);
  });

  it("sums to the range total when the window ends on a month boundary", () => {
    const total = 94_815_19 + 171_762_26;
    const months = billedMonthsInRange(monthly, total, { fromYmd: "2026-05-01", toYmd: "2026-06-30" });
    expect(sum(months)).toBe(total);
    expect([...months.keys()]).toEqual(["2026-05", "2026-06"]);
  });

  it("splits the residual with the head fold when BOTH edges are partial", () => {
    // 2026-05-15 → 2026-09-10. May and September are both part-months.
    const head = 91_878_94; // billed 15–31 May, from the extra fold
    const total = head + 171_762_26 + 259_089_63 + 301_510_24 + 5_165_63;
    const months = billedMonthsInRange(monthly, total, { fromYmd: "2026-05-15", toYmd: "2026-09-10" }, head);
    expect(sum(months)).toBe(total);
    expect(months.get("2026-05")).toBe(head);
    expect(months.get("2026-09")).toBe(5_165_63);
    // …and the whole months between them are untouched.
    expect(months.get("2026-07")).toBe(259_089_63);
  });

  it("puts a single partial month's whole total in that month", () => {
    const months = billedMonthsInRange(monthly, 42_00, { fromYmd: "2026-07-05", toYmd: "2026-07-20" });
    expect([...months.entries()]).toEqual([["2026-07", 42_00]]);
  });
});
