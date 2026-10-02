import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildAiaWorkbookBuffer } from "@/lib/commercial/aia/export";

/**
 * The G702 cover sheet's HEADING and its CHANGE ORDER SUMMARY.
 *
 * Stephanie 2026-10-02, with a filled sample attached: "the heading on the G702
 * (pg 1) doesn't export the way we need it to ... can you make sure the Change
 * Orders fill the highlighted area at the bottom".
 *
 * Measured on Green Leaf App 5 before the fix:
 *   · every cell her sample fills (C5-C7, E5-E7, C12/C14/C15) was EMPTY, and
 *     all three blocks were crammed as newline-joined text into A4/D4/A11 —
 *     cells her layout does not read;
 *   · the summary said $13,750.00 of change orders while line 2 of the same
 *     page said $18,800.00, because the block was derived from the G703 rows
 *     tagged as COs rather than from the change orders line 2 is built from;
 *   · everything sat on the THIS MONTH row, because the export had no approval
 *     dates to split on.
 *
 * Asserting the rendered workbook, not the builder.
 */
const G702 = {
  originalContractCents: 37_000_00,
  netChangeOrdersCents: 18_800_00,
  salesTaxCents: 0,
  contractSumToDateCents: 55_800_00,
  totalCompletedStoredCents: 55_800_00,
  retainageCents: 5_580_00,
  totalEarnedLessRetainageCents: 50_220_00,
  previousCertificatesCents: 45_675_00,
  currentPaymentDueCents: 4_545_00,
  balanceToFinishCents: 5_580_00,
  percentCompleteBps: 10_000,
  sovVarianceCents: 0,
} as never;

async function build(
  changeOrders?: Array<{ amountCents: number; decidedAt: string | null }>,
  period: { period_from?: string | null; period_to?: string | null } = {
    period_from: "2026-09-23",
    period_to: "2026-09-23",
  }
) {
  const buf = await buildAiaWorkbookBuffer({
    application: { application_number: 5, retainage_pct: 10, ...period } as never,
    lines: [] as never[],
    g702: G702,
    ownerLabel: "Green Leaf Construction\n14 Manning Avenue\nLeominster, MA 01453",
    projectLabel: "FW Webb 31 Windsor Place\n31 Windsor Place\nCentral Islip, NY 11722",
    contractorLabel: "Tomco Painting\n77 Windsor Place, Ste. 13\nCentral Islip, NY 11722",
    changeOrders,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const g = wb.getWorksheet("Loan G-702")!;
  const v = (a: string) => {
    const x = g.getCell(a).value as unknown;
    return x && typeof x === "object" && "result" in (x as object)
      ? (x as { result: unknown }).result
      : x;
  };
  return v;
}

describe("the G702 heading sits where her form reads it", () => {
  it("puts each block on its own row, in her columns", async () => {
    const v = await build();
    // TO OWNER:
    expect(v("C5")).toBe("Green Leaf Construction");
    expect(v("C6")).toBe("14 Manning Avenue");
    expect(v("C7")).toBe("Leominster, MA 01453");
    // PROJECT:
    expect(v("E5")).toBe("FW Webb 31 Windsor Place");
    expect(v("E6")).toBe("31 Windsor Place");
    expect(v("E7")).toBe("Central Islip, NY 11722");
    // FROM CONTRACTOR: — row 13 is skipped on her sheet, deliberately.
    expect(v("C12")).toBe("Tomco Painting");
    expect(v("C14")).toBe("77 Windsor Place, Ste. 13");
    expect(v("C15")).toBe("Central Islip, NY 11722");
  });

  it("leaves the cells the old layout used empty, so no block prints twice", async () => {
    const v = await build();
    for (const ref of ["A4", "D4", "A11"]) expect(v(ref) ?? "").toBe("");
  });

  it("colors the blocks the way her sample does, not the template's leftover green", async () => {
    /*
     * These cells were empty until we started filling them, so their font
     * color had never been seen. The template carries GREEN on the project
     * block and BLUE on the other two — a bright green block next to two blue
     * ones. Her sample is blue / red / blue.
     */
    const buf = await buildAiaWorkbookBuffer({
      application: { application_number: 5, retainage_pct: 10, period_to: "2026-09-23" } as never,
      lines: [] as never[],
      g702: G702,
      ownerLabel: "O\nstreet\ncity",
      projectLabel: "P\nstreet\ncity",
      contractorLabel: "C\nstreet\ncity",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const g = wb.getWorksheet("Loan G-702")!;
    const colorOf = (ref: string) =>
      (g.getCell(ref).font?.color as { argb?: string; indexed?: number } | undefined) ?? {};
    for (const ref of ["C5", "C6", "C7", "C12", "C14", "C15"]) {
      expect(colorOf(ref).argb, ref).toBe("FF0000FF"); // her blue
    }
    for (const ref of ["E5", "E6", "E7"]) {
      expect(colorOf(ref).argb, ref).toBe("FFFF0000"); // her red
      // Explicit, so it no longer depends on a palette the file does not carry
      // — which is how the project block came out bright green (index 11).
      expect(colorOf(ref).indexed, ref).toBeUndefined();
    }
  });

  it("keeps her own labels intact", async () => {
    const v = await build();
    expect(v("A3")).toBe("TO OWNER:");
    expect(v("D3")).toBe("PROJECT:");
    expect(v("A10")).toBe("FROM CONTRACTOR:");
  });

  it("merges a second address line rather than pushing the city off the block", async () => {
    const buf = await buildAiaWorkbookBuffer({
      application: { application_number: 1, retainage_pct: 10, period_to: "2026-09-30" } as never,
      lines: [] as never[],
      g702: G702,
      ownerLabel: "Acme GC\nSuite 400\n12 Main St\nIslip, NY 11751",
      projectLabel: "P",
      contractorLabel: "C",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const g = wb.getWorksheet("Loan G-702")!;
    expect(g.getCell("C5").value).toBe("Acme GC");
    expect(g.getCell("C6").value).toBe("Suite 400, 12 Main St");
    // The city must survive — it is what tells a lender which town the GC is in.
    expect(g.getCell("C7").value).toBe("Islip, NY 11751");
  });
});

describe("the change order summary explains line 2", () => {
  const COS = [
    { amountCents: 18_250_00, decidedAt: "2026-07-20" }, // previous months
    { amountCents: 550_00, decidedAt: "2026-09-22" }, // same month as the period
  ];

  it("splits previous months from this month by calendar month", async () => {
    const v = await build(COS);
    expect(v("D46")).toBe(18_250); // previous, in dollars
    expect(v("D48")).toBe(550); // this month
  });

  it("foots: previous + this = totals, and the net equals line 2", async () => {
    const v = await build(COS);
    expect((v("D46") as number) + (v("D48") as number)).toBe(v("D50"));
    expect((v("D50") as number) - (v("E50") as number)).toBe(v("D51"));
    // THE ONE THAT MATTERS. A cover sheet that contradicts itself gets rejected.
    expect(v("D51")).toBe(v("E25"));
  });

  it("does not bury a credit in the additions column", async () => {
    const v = await build([
      { amountCents: 20_000_00, decidedAt: "2026-09-10" },
      { amountCents: -1_200_00, decidedAt: "2026-09-11" },
    ]);
    expect(v("D48")).toBe(20_000);
    expect(v("E48")).toBe(1_200); // deductions are positive in their own column
  });

  it("treats a change order with no approval date as previous, never as this month", async () => {
    const v = await build([{ amountCents: 18_800_00, decidedAt: null }]);
    expect(v("D46")).toBe(18_800);
    expect(v("D48")).toBe(0);
  });

  it("still foots to line 2 when no change orders are passed at all", async () => {
    const v = await build(undefined);
    expect(v("D51")).toBe(v("E25"));
    // AND the rows above it add up to it. Checking only the net let a version
    // through where the buckets were empty under a non-zero total — the same
    // self-contradiction this block exists to remove.
    expect((v("D46") as number) + (v("D48") as number)).toBe(v("D50"));
    expect((v("D50") as number) - (v("E50") as number)).toBe(v("D51"));
    expect(v("D46")).toBe(18_800); // unexplained COs read as previous months
  });
});
