import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildLedgerWorkbook } from "@/lib/payments/ledger-export";
import { EXPORT_COLUMNS, type LedgerPayment, type LedgerQuery } from "@/lib/payments/ledger";

const base: LedgerPayment = {
  id: "1", status: "succeeded", method: "card", card_funding: "credit", work_order_id: "0WO1",
  work_order_number: "00318254", customer_name: "Fred Pinckney", customer_email: "f@x.com", milestone_label: "Progress",
  base_cents: 149090, fee_cents: 4473, total_cents: 153563, stripe_fee_cents: 4483, livemode: true,
  payment_intent_id: "pi_1", sf_writeback_status: "written", sf_transaction_id: "a03A", payout_id: "po_1",
  cleared_at: "2026-10-09T12:00:00Z", paid_at: "2026-10-07T15:00:00Z", created_at: "2026-10-07T15:00:00Z",
};
const rows: LedgerPayment[] = [
  base,
  { ...base, id: "2", card_funding: "debit", base_cents: 59635, fee_cents: 0, total_cents: 59635, stripe_fee_cents: 1759, payment_intent_id: "pi_2" },
  { ...base, id: "3", method: "ach", card_funding: null, base_cents: 208725, fee_cents: 0, total_cents: 208725, stripe_fee_cents: null, sf_writeback_status: null, cleared_at: null, payment_intent_id: "pi_3" },
];
const q: LedgerQuery = { preset: "month", from: "2026-10-01", to: "2026-10-31", paidWith: "all", livemode: true };

async function readBack() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildLedgerWorkbook(rows, q));
  return wb;
}

describe("the Payments export, read back as a real .xlsx", () => {
  it("has the two sheets, the header row, and one row per payment plus a totals row", async () => {
    const wb = await readBack();
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Payments", "Summary"]);
    const ws = wb.getWorksheet("Payments")!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual([...EXPORT_COLUMNS]);
    expect(ws.rowCount).toBe(1 + rows.length + 1);
    expect(ws.getRow(ws.rowCount).getCell(1).value).toBe("TOTAL");
  });

  it("base and fee are separate NUMBER cells — Excel can sum them", async () => {
    const ws = (await readBack()).getWorksheet("Payments")!;
    const col = (h: (typeof EXPORT_COLUMNS)[number]) => EXPORT_COLUMNS.indexOf(h) + 1;
    expect(ws.getRow(2).getCell(col("Base amount (to Salesforce)")).value).toBe(1490.9);
    expect(ws.getRow(2).getCell(col("Card fee collected (3%)")).value).toBe(44.73);
    expect(ws.getRow(3).getCell(col("Card fee collected (3%)")).value).toBe(0);
    expect(ws.getRow(3).getCell(col("Paid with")).value).toBe("Debit card");
  });

  it("the totals row sums the money columns with formulas", async () => {
    const ws = (await readBack()).getWorksheet("Payments")!;
    const baseCol = EXPORT_COLUMNS.indexOf("Base amount (to Salesforce)") + 1;
    const cell = ws.getRow(ws.rowCount).getCell(baseCol).value as { formula: string };
    const letter = ws.getColumn(baseCol).letter;
    expect(cell.formula).toBe(`SUM(${letter}2:${letter}4)`);
  });

  it("the Summary sheet carries the same totals the page shows", async () => {
    const sum = (await readBack()).getWorksheet("Summary")!;
    const find = (label: string) => {
      let v: unknown;
      sum.eachRow((r) => {
        if (r.getCell(1).value === label) v = r.getCell(2).value;
      });
      return v;
    };
    expect(find("Payments counted")).toBe(3);
    expect(find("Collected — base (to Salesforce)")).toBeCloseTo(4174.5, 2);
    expect(find("Card fees collected (3%)")).toBeCloseTo(44.73, 2);
    expect(find("Total charged")).toBeCloseTo(4219.23, 2);
  });
});
