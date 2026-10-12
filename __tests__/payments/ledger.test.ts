import { describe, expect, it } from "vitest";
import {
  EXPORT_COLUMNS,
  exportRow,
  filterLedger,
  paidWith,
  paymentDateEt,
  rangeFor,
  stageOf,
  totalsOf,
  type LedgerPayment,
} from "@/lib/payments/ledger";

function pay(over: Partial<LedgerPayment>): LedgerPayment {
  return {
    id: "x",
    status: "succeeded",
    method: "card",
    card_funding: "credit",
    work_order_id: "0WO",
    work_order_number: "00318254",
    customer_name: "Fred Pinckney",
    customer_email: "f@example.com",
    milestone_label: "Progress",
    base_cents: 149090,
    fee_cents: 4473,
    total_cents: 153563,
    stripe_fee_cents: null,
    livemode: true,
    payment_intent_id: "pi_1",
    sf_writeback_status: null,
    sf_transaction_id: null,
    payout_id: null,
    cleared_at: null,
    paid_at: "2026-10-07T15:00:00Z",
    created_at: "2026-10-07T14:59:00Z",
    ...over,
  };
}

describe("rangeFor — PPP's fiscal calendar (FY Feb–Jan; Q1 Feb–Apr)", () => {
  it("this month / last month, including across New Year", () => {
    expect(rangeFor("month", "2026-10-07")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(rangeFor("last-month", "2026-10-07")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(rangeFor("last-month", "2027-01-15")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(rangeFor("month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it.each([
    ["2026-02-01", "2026-02-01", "2026-04-30"], // Q1
    ["2026-07-31", "2026-05-01", "2026-07-31"], // Q2
    ["2026-10-07", "2026-08-01", "2026-10-31"], // Q3
    ["2026-12-15", "2026-11-01", "2027-01-31"], // Q4 spans New Year
    ["2027-01-20", "2026-11-01", "2027-01-31"], // …from either side
  ])("quarter containing %s is %s → %s", (today, from, to) => {
    expect(rangeFor("quarter", today)).toEqual({ from, to });
  });

  it("fiscal year: January still belongs to the year that started last February", () => {
    expect(rangeFor("fy", "2026-10-07")).toEqual({ from: "2026-02-01", to: "2027-01-31" });
    expect(rangeFor("fy", "2027-01-31")).toEqual({ from: "2026-02-01", to: "2027-01-31" });
    expect(rangeFor("fy", "2027-02-01")).toEqual({ from: "2027-02-01", to: "2028-01-31" });
  });

  it("custom ignores anything that isn't a date", () => {
    expect(rangeFor("custom", "2026-10-07", { from: "2026-09-01", to: "junk" })).toEqual({ from: "2026-09-01", to: null });
  });
});

describe("paymentDateEt — the day in New York, not UTC", () => {
  it("a 9:30 PM ET payment stays on its own day", () => {
    // 01:30 UTC on the 8th is 9:30 PM ET on the 7th.
    expect(paymentDateEt(pay({ paid_at: "2026-10-08T01:30:00Z" }))).toBe("2026-10-07");
  });
});

describe("paidWith / stageOf", () => {
  it("card type comes from what Stripe said; bank is bank", () => {
    expect(paidWith(pay({ card_funding: "debit" }))).toBe("debit");
    expect(paidWith(pay({ card_funding: null }))).toBe("card");
    expect(paidWith(pay({ method: "ach", card_funding: null }))).toBe("bank");
  });

  it("stage follows the money: clearing → paid → cleared → booked; refunds win", () => {
    expect(stageOf(pay({ status: "processing" }))).toBe("processing");
    expect(stageOf(pay({}))).toBe("awaiting_payout");
    expect(stageOf(pay({ cleared_at: "2026-10-09T10:00:00Z" }))).toBe("cleared");
    expect(stageOf(pay({ cleared_at: "x", sf_writeback_status: "written" }))).toBe("booked");
    expect(stageOf(pay({ sf_writeback_status: "failed" }))).toBe("booking_failed");
    expect(stageOf(pay({ status: "refunded", sf_writeback_status: "written" }))).toBe("refunded");
  });
});

describe("filterLedger", () => {
  const rows = [
    pay({ id: "a" }),
    pay({ id: "b", method: "ach", card_funding: null, paid_at: "2026-09-15T15:00:00Z" }),
    pay({ id: "c", status: "failed" }),
    pay({ id: "d", status: "open" }),
    pay({ id: "e", livemode: false }),
  ];

  it("only money that moved, in the chosen mode, inside the range", () => {
    const out = filterLedger(rows, { from: "2026-10-01", to: "2026-10-31", livemode: true });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("test payments never mix into live numbers, and vice versa", () => {
    expect(filterLedger(rows, { from: null, to: null, livemode: false }).map((r) => r.id)).toEqual(["e"]);
  });

  it("filter by how it was paid", () => {
    expect(filterLedger(rows, { from: null, to: null, livemode: true, paidWith: "bank" }).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("totalsOf — base and fee kept apart", () => {
  const rows = [
    pay({ id: "credit", stripe_fee_cents: 4483 }), // $1,490.90 + $44.73; Stripe took $44.83
    pay({ id: "debit", card_funding: "debit", base_cents: 59635, fee_cents: 0, total_cents: 59635, stripe_fee_cents: 1759 }),
    pay({ id: "bank", method: "ach", card_funding: null, base_cents: 208725, fee_cents: 0, total_cents: 208725 }),
    pay({ id: "refund", status: "refunded", base_cents: 10000, fee_cents: 300, total_cents: 10300 }),
  ];
  const t = totalsOf(rows);

  it("base, fee and total add up separately and refunds are excluded from collected", () => {
    expect(t.count).toBe(3);
    expect(t.baseCents).toBe(149090 + 59635 + 208725);
    expect(t.feeCents).toBe(4473);
    expect(t.totalCents).toBe(t.baseCents + t.feeCents);
    expect(t.refundedCount).toBe(1);
    expect(t.refundedCents).toBe(10300);
  });

  it("fee vs Stripe's cost only over payments where the cost is known", () => {
    expect(t.stripeFeeKnownCount).toBe(2);
    expect(t.stripeFeeCents).toBe(4483 + 1759);
    // credit: +4473 − 4483 = −10; debit: 0 − 1759 → −1769
    expect(t.feeNetCents).toBe(-10 - 1759);
  });

  it("split by how it was paid", () => {
    expect(t.byPaidWith.credit).toEqual({ count: 1, baseCents: 149090, feeCents: 4473, totalCents: 153563 });
    expect(t.byPaidWith.debit.count).toBe(1);
    expect(t.byPaidWith.bank.baseCents).toBe(208725);
  });
});

describe("exportRow", () => {
  it("one cell per column, dollars as numbers so Excel can sum them", () => {
    const row = exportRow(pay({ stripe_fee_cents: 4483, cleared_at: "2026-10-09T12:00:00Z", sf_transaction_id: "a03X" }));
    expect(row).toHaveLength(EXPORT_COLUMNS.length);
    const col = (name: (typeof EXPORT_COLUMNS)[number]) => row[EXPORT_COLUMNS.indexOf(name)];
    expect(col("Base amount (to Salesforce)")).toBe(1490.9);
    expect(col("Card fee collected (3%)")).toBe(44.73);
    expect(col("Total charged")).toBe(1535.63);
    expect(col("Stripe processing cost")).toBe(44.83);
    expect(col("Fee minus Stripe cost")).toBeCloseTo(-0.1, 10);
    expect(col("Paid with")).toBe("Credit card");
    // Cleared with a Salesforce id recorded but no write status → the stage reads
    // from sf_writeback_status, which is still null here.
    expect(col("Status")).toBe("Cleared");
    expect(col("Salesforce Payment In")).toBe("a03X");
  });
});

import { ledgerQueryString, parseLedgerQuery } from "@/lib/payments/ledger";

describe("parseLedgerQuery — the page and the export read the same filter", () => {
  it("defaults to this month, every payment type, in the key's mode", () => {
    expect(parseLedgerQuery({}, "2026-10-07", false)).toEqual({
      preset: "month",
      from: "2026-10-01",
      to: "2026-10-31",
      paidWith: "all",
      livemode: false,
    });
  });

  it("junk falls back instead of erroring", () => {
    const q = parseLedgerQuery({ range: "forever", with: "bitcoin", mode: "maybe" }, "2026-10-07", true);
    expect(q).toMatchObject({ preset: "month", paidWith: "all", livemode: true });
  });

  it("round-trips through the query string", () => {
    const q = parseLedgerQuery({ range: "custom", from: "2026-09-01", to: "2026-09-30", with: "credit", mode: "live" }, "2026-10-07", false);
    const back = parseLedgerQuery(Object.fromEntries(new URLSearchParams(ledgerQueryString(q))), "2026-10-07", false);
    expect(back).toEqual(q);
  });
});
