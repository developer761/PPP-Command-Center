import { describe, it, expect } from "vitest";
import { buildGroups, grandTotals, type ReportColumn, type ReportGrouping } from "@/lib/commercial/reports/grouped/spec";

/**
 * The grouped-report engine, held to the numbers printed on Tomco's own
 * Salesforce reports. Every figure below was read off a screenshot of the
 * report Brendan or Mary actually runs, so if this file goes green the shape is
 * reproducing what they already trust.
 */

type Row = {
  account: string;
  status: string;
  opp: string;
  charges: number; // cents
  paid: number;
  balance: number;
};

const col = (key: string, amount: (r: Row) => number): ReportColumn<Row> => ({
  key,
  label: key,
  kind: "money",
  amount,
});

const COLUMNS: ReportColumn<Row>[] = [
  { key: "opp", label: "Opportunity", text: (r) => r.opp },
  col("charges", (r) => r.charges),
  col("paid", (r) => r.paid),
  col("balance", (r) => r.balance),
];

const byAccount: ReportGrouping<Row> = { key: "account", label: "Account", of: (r) => r.account };
const byStatus: ReportGrouping<Row> = { key: "status", label: "Status", of: (r) => r.status };

/**
 * "Tomco Balance Owed" (Mary) / "Balance Owed" (Brendan) — the same 12 records
 * grouped two different ways, and BOTH must land on the same grand total:
 *   Total Records 12 · Charges $358,616.47 · Paid $248,079.60 · Owed $110,536.87
 * The five rows below are the ones legible on the screenshots.
 */
const BALANCE_OWED: Row[] = [
  { account: "5150 Veterans LLC : IDA Project # 4703-24-6", status: "Complete Balance Owed", opp: "5150 Vet Mem Hwy -O'Shea Properties", charges: 6_200_000, paid: 5_950_000, balance: 250_000 },
  { account: "ALTA Construction East Inc.", status: "On Hold", opp: "VCA West Islip - ALTA Construction East", charges: 7_612_500, paid: 4_346_250, balance: 3_266_250 },
  { account: "Brent Mako", status: "On Hold", opp: "253-255 Main Street- Smithtown", charges: 380_625, paid: 0, balance: 380_625 },
  { account: "DuCon Construction Co., Inc.", status: "Complete Balance Owed", opp: "DuCon -LANDLORD-4 Henry Street, Commack", charges: 95_000, paid: 0, balance: 95_000 },
  { account: "Green Leaf Construction", status: "Complete Balance Owed", opp: "31 Windsor Place - Green Leaf", charges: 5_525_000, paid: 4_561_500, balance: 963_500 },
];

describe("Balance Owed, grouped the two ways Tomco groups it", () => {
  it("gives the same grand total either way — the grouping cannot change the money", () => {
    const byAcct = grandTotals(BALANCE_OWED, COLUMNS);
    const flat = grandTotals([...BALANCE_OWED].reverse(), COLUMNS);
    expect(byAcct).toEqual(flat);
    expect(byAcct.balance).toBe(
      BALANCE_OWED.reduce((n, r) => n + r.balance, 0)
    );
  });

  it("Mary's view groups by account, then status", () => {
    const tree = buildGroups(BALANCE_OWED, [byAccount, byStatus], COLUMNS);
    expect(tree).toHaveLength(5); // five distinct GCs in the visible rows
    const alta = tree.find((g) => g.label.startsWith("ALTA"))!;
    expect(alta.count).toBe(1);
    expect(alta.subtotals.charges).toBe(7_612_500);
    expect(alta.subtotals.balance).toBe(3_266_250);
    // The second level is the status inside that account.
    expect(alta.children.map((c) => c.label)).toEqual(["On Hold"]);
    expect(alta.children[0].subtotals.balance).toBe(3_266_250);
  });

  it("Brendan's view groups by status — same rows, same money, fewer groups", () => {
    const tree = buildGroups(BALANCE_OWED, [byStatus], COLUMNS);
    expect(tree.map((g) => g.label).sort()).toEqual(["Complete Balance Owed", "On Hold"]);
    const onHold = tree.find((g) => g.label === "On Hold")!;
    // Screenshot: On Hold (2) subtotal $79,931.25 · $43,462.50 · $36,468.75
    expect(onHold.count).toBe(2);
    expect(onHold.subtotals.charges).toBe(7_993_125);
    expect(onHold.subtotals.paid).toBe(4_346_250);
    expect(onHold.subtotals.balance).toBe(3_646_875);
    // And the subtotals across groups add back up to the grand total.
    const sum = tree.reduce((n, g) => n + g.subtotals.balance, 0);
    expect(sum).toBe(grandTotals(BALANCE_OWED, COLUMNS).balance);
  });

  it("a row with no value for the grouping field lands in one group, not many", () => {
    const rows: Row[] = [
      { account: "", status: "Closed", opp: "a", charges: 100, paid: 0, balance: 100 },
      { account: "   ", status: "Closed", opp: "b", charges: 200, paid: 0, balance: 200 },
    ];
    const tree = buildGroups(rows, [byAccount], COLUMNS);
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("—");
    expect(tree[0].subtotals.balance).toBe(300);
  });

  it("keeps the order the rows arrive in, so the report agrees with its own sort", () => {
    const tree = buildGroups(BALANCE_OWED, [byAccount], COLUMNS);
    expect(tree.map((g) => g.label)).toEqual(BALANCE_OWED.map((r) => r.account));
  });

  it("never sums a column that was not asked to be summed", () => {
    const tree = buildGroups(BALANCE_OWED, [byStatus], COLUMNS);
    for (const g of tree) expect(g.subtotals.opp).toBeUndefined();
  });
});

describe("Tomco Attendance — a summary report, where the totals are hours", () => {
  type Att = { crew: string; job: string; hours: number; days: number };
  const cols: ReportColumn<Att>[] = [
    { key: "job", label: "Job", text: (r) => r.job },
    { key: "hours", label: "Hours", kind: "hours", amount: (r) => r.hours },
    { key: "days", label: "Labor days", kind: "number", amount: (r) => r.days },
  ];
  const byCrew: ReportGrouping<Att> = { key: "crew", label: "Labor crew", of: (r) => r.crew };

  // Straight off Mary's "Tomco Attendance": Omar LI subtotal 99.5h / 12.44 days.
  const rows: Att[] = [
    { crew: "Omar LI", job: "Home Goods-Shirley, NY", hours: 62.0, days: 7.75 },
    { crew: "Omar LI", job: "J & L -303 Christopher Street", hours: 29.0, days: 3.63 },
    { crew: "Omar LI", job: "Water Lillies- LMJ", hours: 8.5, days: 1.06 },
    { crew: "Tomco Labor - Carlos", job: "Water Lillies- LMJ", hours: 8.0, days: 1.0 },
  ];

  it("subtotals hours per crew exactly as Mary's report prints them", () => {
    const tree = buildGroups(rows, [byCrew], cols);
    const omar = tree.find((g) => g.label === "Omar LI")!;
    expect(omar.count).toBe(3);
    expect(omar.subtotals.hours).toBeCloseTo(99.5, 2);
    expect(omar.subtotals.days).toBeCloseTo(12.44, 2);
    const carlos = tree.find((g) => g.label === "Tomco Labor - Carlos")!;
    expect(carlos.subtotals.hours).toBe(8);
  });
});
