import { describe, it, expect } from "vitest";
import {
  summarizeTransactions,
  monthLabel,
  type TxnRow,
} from "@/lib/commercial/reports/transactions";
import { transactionsCsv } from "@/lib/commercial/reports/transactions-export";

/**
 * The transactions ledger — Alex's "Tomco Payments In by Month", natively.
 *
 * His report's structure IS the requirement: grouped by month, subtotalled,
 * with a record count and a total. So the grouping and the money are pinned
 * here, along with the two places this platform says more than his report can
 * — a net per month, and what's been received but not yet deposited.
 */

function pay(over: Partial<TxnRow> = {}): TxnRow {
  return {
    id: "pay:1",
    direction: "in",
    dateYmd: "2026-02-14",
    dateIso: "2026-02-14T15:00:00Z",
    name: "Panera — Holbrook",
    recordType: "Payment In",
    amountCents: 10_000_00,
    reference: "317198",
    depositedAtIso: null,
    depositable: true,
    accountId: "a1",
    accountName: "Acme GC",
    opportunityId: "o1",
    href: "/x",
    ...over,
  };
}

function buy(over: Partial<TxnRow> = {}): TxnRow {
  return pay({
    id: "buy:1",
    direction: "out",
    recordType: "Materials",
    name: "Aboffs",
    amountCents: 2_000_00,
    depositable: false,
    depositedAtIso: null,
    ...over,
  });
}

describe("monthLabel", () => {
  it("reads the way his report groups", () => {
    expect(monthLabel("2026-02")).toBe("February 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
  });
});

describe("summarizeTransactions", () => {
  it("groups by month, newest month first", () => {
    const r = summarizeTransactions([
      pay({ id: "pay:1", dateYmd: "2026-02-14", dateIso: "2026-02-14T15:00:00Z" }),
      pay({ id: "pay:2", dateYmd: "2026-03-02", dateIso: "2026-03-02T15:00:00Z" }),
    ]);
    // A bookkeeper closing a month wants it at the top, not after four years.
    expect(r.months.map((m) => m.label)).toEqual(["March 2026", "February 2026"]);
    expect(r.rowCount).toBe(2);
  });

  it("orders rows inside a month oldest first, the way a statement reads", () => {
    const r = summarizeTransactions([
      pay({ id: "pay:b", dateYmd: "2026-02-20", dateIso: "2026-02-20T15:00:00Z" }),
      pay({ id: "pay:a", dateYmd: "2026-02-03", dateIso: "2026-02-03T15:00:00Z" }),
    ]);
    expect(r.months[0].rows.map((x) => x.id)).toEqual(["pay:a", "pay:b"]);
  });

  it("subtotals each month and nets in against out", () => {
    const r = summarizeTransactions([
      pay({ amountCents: 10_000_00 }),
      buy({ id: "buy:1", amountCents: 4_000_00 }),
    ]);
    const m = r.months[0];
    expect(m.inCents).toBe(10_000_00);
    expect(m.outCents).toBe(4_000_00);
    expect(m.netCents).toBe(6_000_00);
    expect(r.netCents).toBe(6_000_00);
  });

  // "Total Amount" over a MIXED ledger cannot be the sum of the column — that
  // would add money out to money in. It's the net; on a single-direction view
  // it's the plain total.
  it("totals honestly whichever direction is shown", () => {
    const rows = [pay({ amountCents: 10_000_00 }), buy({ amountCents: 4_000_00 })];
    expect(summarizeTransactions(rows).totalCents).toBe(6_000_00);
    expect(summarizeTransactions(rows, { direction: "in" }).totalCents).toBe(10_000_00);
    expect(summarizeTransactions(rows, { direction: "out" }).totalCents).toBe(4_000_00);
  });

  describe("undeposited", () => {
    it("counts payments received that haven't cleared", () => {
      const r = summarizeTransactions([
        pay({ id: "pay:1", amountCents: 10_000_00, depositedAtIso: null }),
        pay({ id: "pay:2", amountCents: 3_000_00, depositedAtIso: "2026-02-20T15:00:00Z" }),
      ]);
      expect(r.undepositedCents).toBe(10_000_00);
      expect(r.undepositedCount).toBe(1);
    });

    it("never counts a purchase — there is nothing to deposit", () => {
      // A purchase's `depositedAtIso` is null forever. Counting it would put a
      // number in the "money sitting in the office" banner that isn't money in.
      const r = summarizeTransactions([buy({ amountCents: 9_000_00 })]);
      expect(r.undepositedCents).toBe(0);
      expect(r.undepositedCount).toBe(0);
    });

    it("the not-deposited filter drops purchases too", () => {
      const r = summarizeTransactions(
        [pay({ id: "pay:1" }), buy({ id: "buy:1" })],
        { undepositedOnly: true }
      );
      expect(r.rowCount).toBe(1);
      expect(r.months[0].rows[0].id).toBe("pay:1");
    });
  });

  it("filters by period on the ET calendar date", () => {
    const r = summarizeTransactions(
      [
        pay({ id: "pay:1", dateYmd: "2026-02-14" }),
        pay({ id: "pay:2", dateYmd: "2026-03-02" }),
      ],
      { fromYmd: "2026-03-01", toYmd: "2026-03-31" }
    );
    expect(r.rowCount).toBe(1);
    expect(r.filtered).toBe(true);
  });

  it("offers every party even while filtered to one", () => {
    // Otherwise picking a GC hides the rest and you can't switch away.
    const rows = [
      pay({ id: "pay:1", accountId: "a1", accountName: "Acme GC" }),
      pay({ id: "pay:2", accountId: "a2", accountName: "Zeta Build" }),
      buy({ id: "buy:1", name: "Aboffs" }),
    ];
    const r = summarizeTransactions(rows, { party: "a1" });
    expect(r.rowCount).toBe(1);
    // Alphabetical, GCs and vendors together — one picker, one order.
    expect(r.partyOptions.map((p) => p.name)).toEqual(["Aboffs", "Acme GC", "Zeta Build"]);
  });

  it("is empty, not broken, with nothing to show", () => {
    const r = summarizeTransactions([]);
    expect(r.months).toEqual([]);
    expect(r.rowCount).toBe(0);
    expect(r.netCents).toBe(0);
  });
});

describe("transactionsCsv", () => {
  const report = summarizeTransactions([
    pay({ amountCents: 10_000_00, reference: "317198" }),
    buy({ id: "buy:1", amountCents: 4_000_00, name: "Aboffs" }),
  ]);
  const csv = transactionsCsv(report);

  it("keeps the month header and its subtotal next to the rows", () => {
    expect(csv).toContain("February 2026 (2)");
    expect(csv).toContain("Subtotal");
  });

  it("prints money out negative, so a SUM over the column is the net", () => {
    expect(csv).toContain("-4000.00");
    expect(csv).toContain("10000.00");
  });

  it("says n/a rather than 'No' where nothing can be deposited", () => {
    // "No" on a purchase would read as an outstanding deposit.
    expect(csv).toContain("n/a");
  });

  it("closes with in, out, net and what hasn't cleared", () => {
    expect(csv).toContain("MONEY IN");
    expect(csv).toContain("MONEY OUT");
    expect(csv).toContain("NET");
    expect(csv).toContain("Not yet deposited");
  });
});
