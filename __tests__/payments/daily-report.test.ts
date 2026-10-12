import { describe, expect, it } from "vitest";
import { inFlightCentsFor, isInFlight, type LedgerPayment } from "@/lib/payments/ledger";
import { longDay, monthStartIso, previousDayIso, renderDailyReport } from "@/lib/payments/daily-report-email";

function pay(over: Partial<LedgerPayment>): LedgerPayment {
  return {
    id: "x",
    status: "succeeded",
    method: "card",
    card_funding: "credit",
    work_order_id: "0WO1",
    work_order_number: "00318254",
    customer_name: "Fred Pinckney",
    customer_email: "f@example.com",
    milestone_label: "Deposit",
    base_cents: 100000,
    fee_cents: 3000,
    total_cents: 103000,
    stripe_fee_cents: null,
    livemode: true,
    payment_intent_id: "pi_1",
    sf_writeback_status: null,
    sf_transaction_id: null,
    payout_id: null,
    cleared_at: null,
    paid_at: "2026-10-11T15:00:00Z",
    created_at: "2026-10-11T14:59:00Z",
    ...over,
  };
}

describe("what counts as paid-but-not-in-Salesforce-yet", () => {
  it("is ACH clearing, or succeeded and not written", () => {
    expect(isInFlight(pay({ status: "processing" }))).toBe(true);
    expect(isInFlight(pay({ sf_writeback_status: null }))).toBe(true);
    expect(isInFlight(pay({ sf_writeback_status: "failed" }))).toBe(true);
    expect(isInFlight(pay({ sf_writeback_status: "written" }))).toBe(false);
    expect(isInFlight(pay({ status: "refunded" }))).toBe(false);
  });

  it("sums one Work Order in one money mode only", () => {
    const rows = [
      pay({ base_cents: 100 }),
      pay({ base_cents: 20, status: "processing" }),
      pay({ base_cents: 4000, sf_writeback_status: "written" }), // already in the balance
      pay({ base_cents: 300, livemode: false }), // test money never pays a real job
      pay({ base_cents: 5000, work_order_id: "0WO2" }),
    ];
    expect(inFlightCentsFor(rows, "0WO1", true)).toBe(120);
    expect(inFlightCentsFor(rows, "0WO1", false)).toBe(300);
  });
});

describe("daily report dates", () => {
  it("steps back across month and year ends", () => {
    expect(previousDayIso("2026-10-12")).toBe("2026-10-11");
    expect(previousDayIso("2026-11-01")).toBe("2026-10-31");
    expect(previousDayIso("2027-01-01")).toBe("2026-12-31");
    expect(previousDayIso("2028-03-01")).toBe("2028-02-29");
    expect(monthStartIso("2026-10-31")).toBe("2026-10-01");
  });
  it("names the day without drifting a day in any time zone", () => {
    expect(longDay("2026-10-11")).toBe("Sunday, Oct 11");
  });
});

describe("daily report email", () => {
  const base = { day: "2026-10-11", failedCount: 0, livemode: true, tabUrl: "https://hub.example/dashboard/payments" };

  it("totals the day and the month, base apart from fees", () => {
    const rows = [pay({}), pay({ id: "y", method: "ach", card_funding: null, fee_cents: 0, base_cents: 50050, total_cents: 50050 })];
    const r = renderDailyReport({ ...base, rows, monthRows: [...rows, pay({ id: "z", base_cents: 1000, fee_cents: 0 })] });
    expect(r.subject).toBe("Online payments Sunday, Oct 11: $1,500.50 (2)");
    expect(r.text).toContain("Collected (to Salesforce): $1,500.50");
    expect(r.text).toContain("Card fees (3% credit):     $30.00");
    expect(r.text).toContain("Month to date: 3 payments · $1,510.50 collected");
    expect(r.text).toContain("attached");
  });

  it("says plainly when nothing came in, and promises no file", () => {
    const r = renderDailyReport({ ...base, rows: [], monthRows: [] });
    expect(r.subject).toBe("Online payments Sunday, Oct 11: none");
    expect(r.text).toContain("No online payments");
    expect(r.text).not.toContain("attached");
    expect(r.html).not.toContain("attached");
  });

  it("marks test money in the subject and the body", () => {
    const r = renderDailyReport({ ...base, livemode: false, rows: [pay({ livemode: false })], monthRows: [] });
    expect(r.subject.startsWith("[TEST] ")).toBe(true);
    expect(r.html).toContain("Stripe test mode");
  });

  it("flags bookings that failed", () => {
    expect(renderDailyReport({ ...base, rows: [], monthRows: [], failedCount: 2 }).text).toContain(
      "NEEDS ATTENTION: 2 payments didn't book in Salesforce.",
    );
  });

  it("escapes a customer name typed into a card form", () => {
    const r = renderDailyReport({ ...base, rows: [pay({ customer_name: '<img src=x onerror="alert(1)">' })], monthRows: [] });
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;img");
  });
});
