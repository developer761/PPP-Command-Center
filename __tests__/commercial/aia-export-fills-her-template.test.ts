import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildAiaWorkbookBuffer } from "@/lib/commercial/aia/export";

/**
 * The AIA export fills Stephanie's own workbook.
 *
 * Stephanie 2026-09-01: "The excel spreadsheet is not going to fly, has to look
 * like the spreadsheet provided."
 *
 * The old export rebuilt a workbook that mirrored her form's CELL ADDRESSES —
 * and the addresses were right. It still wasn't submittable, because a G702 is
 * not its numbers: it is the certification the contractor signs, the notary
 * block under it, the Architect's Certificate for Payment, the change-order
 * summary and the 1992 AIA footer. None of that was there. You cannot notarise
 * a spreadsheet with no notary block.
 *
 * These assert the two halves that matter: HER form is still intact, and OUR
 * numbers are in it. Rendering the artifact, not reading the builder — the old
 * export would have passed any test that only checked the values.
 */
const line = (
  item_no: string, description: string, scheduled: number,
  prev = 0, now = 0, change_order_id: string | null = null
) => ({
  item_no, description,
  scheduled_value_cents: scheduled,
  from_previous_cents: prev,
  this_period_cents: now,
  materials_stored_cents: 0,
  change_order_id,
}) as never;

const G702 = {
  originalContractCents: 100_000_00, netChangeOrdersCents: 8_000_00, salesTaxCents: 9_450_00,
  contractSumToDateCents: 117_450_00, totalCompletedStoredCents: 65_000_00,
  retainageCents: 3_250_00, totalEarnedLessRetainageCents: 61_750_00,
  previousCertificatesCents: 38_000_00, currentPaymentDueCents: 23_750_00,
  balanceToFinishCents: 55_700_00, percentCompleteBps: 5534, sovVarianceCents: 0,
} as never;

async function build(lines: never[]) {
  const buf = await buildAiaWorkbookBuffer({
    application: { application_number: 3, retainage_pct: 5, period_to: "2026-09-30" } as never,
    lines, g702: G702,
    projectLabel: "JD Sports — Junction Blvd",
    ownerLabel: "Alta Construction East Inc.",
    contractorLabel: "Tomco Painting",
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const raw = (sheet: string, cell: string) => {
    const v = wb.getWorksheet(sheet)!.getCell(cell).value as { result?: unknown } | null;
    return v && typeof v === "object" && "result" in v ? v.result : v;
  };
  return { wb, raw };
}

const LINES = [
  line("1", "Original Contract", 100_000_00, 40_000_00, 20_000_00),
  line("CO-001", "Change Order 1: Extra coat", 10_000_00, 0, 5_000_00, "co1"),
  line("CO-002", "Change Order 2: Deduct doors", -2_000_00),
  line("TAX", "NYS Sales Tax (8.75%)", 9_450_00),
];

describe("her form arrives intact", () => {
  it("keeps the parts that make it a legal document", async () => {
    const { raw } = await build(LINES);
    // Every one of these was ABSENT from the old export. Without them the file
    // is a table of numbers, not an application for payment.
    expect(String(raw("Loan G-702", "G32"))).toContain("Notary Public");
    expect(String(raw("Loan G-702", "G35"))).toContain("ARCHITECT'S CERTIFICATE");
    expect(String(raw("Loan G-702", "G42"))).toContain("AMOUNT CERTIFIED");
    expect(String(raw("Loan G-702", "A44"))).toContain("CHANGE ORDER SUMMARY");
    expect(String(raw("Loan G-702", "A54"))).toContain("AIA DOCUMENT G702");
  });

  it("keeps both sheet names, trailing space and all", async () => {
    // Hers has a trailing space on the G703. A GC's AP macro or her own
    // copy-paste may key off the name, so it is matched exactly.
    const { wb } = await build(LINES);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Loan G-702", "G-703 Total Hard Cost "]);
  });
});

describe("our numbers are in it", () => {
  it("fills the G702 lines", async () => {
    const { raw } = await build(LINES);
    expect(raw("Loan G-702", "E24")).toBeCloseTo(100_000, 2); // 1 Original Contract
    expect(raw("Loan G-702", "E26")).toBeCloseTo(117_450, 2); // 3 Contract Sum to Date
    expect(raw("Loan G-702", "E40")).toBeCloseTo(23_750, 2);  // 8 Current Payment Due
  });

  it("fills the change-order summary, which used to be blank", async () => {
    // The map listed seven cells here and the old export wrote NONE of them.
    // Additions and deductions are split, because that is what the two columns
    // mean — a net figure under ADDITIONS is wrong on a job with a credit.
    const { raw } = await build(LINES);
    expect(raw("Loan G-702", "D48")).toBeCloseTo(10_000, 2);
    expect(raw("Loan G-702", "E48")).toBeCloseTo(2_000, 2);
    expect(raw("Loan G-702", "D51")).toBeCloseTo(8_000, 2);
  });

  it("writes the schedule of values in her row range and totals it", async () => {
    const { raw } = await build(LINES);
    expect(raw("G-703 Total Hard Cost ", "B13")).toBe("Original Contract");
    expect(raw("G-703 Total Hard Cost ", "A14")).toBe("CO-001");
    expect(raw("G-703 Total Hard Cost ", "C15")).toBeCloseTo(-2_000, 2); // a deduct stays negative
    expect(raw("G-703 Total Hard Cost ", "C35")).toBeCloseTo(117_450, 2);
  });

  it("foots to the G702 — the two sheets cannot disagree", async () => {
    // The G703 grand total IS line 3. Her template computes it that way
    // (E26 = 'G-703'!C35), and sovVarianceCents exists to catch them drifting.
    const { raw } = await build(LINES);
    expect(raw("G-703 Total Hard Cost ", "C35")).toBeCloseTo(
      Number(raw("Loan G-702", "E26")), 2
    );
  });

  it("blanks the slots it didn't use", async () => {
    // The template ships rows 13-34 pre-filled with zeros and formulas. Left
    // behind, they print as rows of $0.00 under the last real line — which
    // reads as work priced at nothing.
    const { raw } = await build(LINES);
    expect(raw("G-703 Total Hard Cost ", "C17")).toBeNull();
    expect(raw("G-703 Total Hard Cost ", "B20")).toBeNull();
  });

  it("grows the sheet rather than dropping a line", async () => {
    // Her form has 22 slots. Silently truncating a customer document is not
    // something to leave to luck, however rare 23 lines may be.
    const many = Array.from({ length: 30 }, (_, i) => line(String(i + 1), `Line ${i + 1}`, 1_000_00));
    const { raw } = await build(many);
    expect(raw("G-703 Total Hard Cost ", "B42")).toBe("Line 30");
    expect(raw("G-703 Total Hard Cost ", "C43")).toBeCloseTo(30_000, 2); // totals moved down with it
  });
});
