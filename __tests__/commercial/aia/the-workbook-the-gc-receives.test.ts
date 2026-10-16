import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildAiaWorkbookBuffer } from "@/lib/commercial/aia/export";
import { computeG702, applyReleasedRetainage } from "@/lib/commercial/aia/constants";
import type { AiaApplication, AiaLineItem } from "@/lib/commercial/aia/db";

/**
 * THE DOCUMENT THAT LEAVES THE BUILDING.
 *
 * `lib/commercial/aia/export.ts` fills Stephanie's own AIA requisition form and
 * that .xlsx is what a general contractor's accounts payable department
 * processes. On 2026-10-16 an audit broke its retainage math on purpose —
 * `ret5a + 12345` on the cover sheet, `+999` per line on the continuation
 * sheet — and all 8,405 tests stayed green. Both sheets of a customer-facing
 * certificate were corrupted and nothing in the suite noticed, because nothing
 * in the suite had ever opened one.
 *
 * The commit that changed that math said "verified by building the real
 * workbook". It was — once, by hand, against the live database. This is the
 * automated successor, and it needs no database: `buildAiaWorkbookBuffer` takes
 * plain objects.
 *
 * EVERY EXPECTED FIGURE BELOW IS WRITTEN AS A LITERAL, worked out by hand from
 * the fixture. Deriving them from `lineRetainageCents` would make the test a
 * tautology — the shape the delivery-flow check was caught in on the same day,
 * where both sides of the comparison were the same reduce over the same
 * function and a wrong result was wrong identically on both.
 */

const SHEET_G702 = "Loan G-702";
const SHEET_G703 = "G-703 Total Hard Cost ";
/** Her form's line rows and the blank spacer the release note is written into. */
const FIRST_LINE_ROW = 13;

function app(over: Partial<AiaApplication> = {}): AiaApplication {
  return {
    id: "app-1",
    opportunity_id: "opp-1",
    account_id: "acct-1",
    application_number: 6,
    status: "draft",
    original_contract_cents: 0,
    original_contract_is_manual: false,
    retainage_pct: 5,
    is_retainage_release: false,
    period_from: "2026-07-01",
    period_to: "2026-07-31",
    frozen_at: null,
    contract_sum_frozen_cents: null,
    net_change_orders_frozen_cents: null,
    notes: null,
    lien_waiver_document_id: null,
    created_by_user_id: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    deleted_at: null,
    ...over,
  } as AiaApplication;
}

function line(
  n: number,
  item: string,
  scheduled: number,
  fromPrev: number,
  thisPeriod: number,
  stored = 0
): AiaLineItem {
  return {
    id: `line-${n}`,
    application_id: "app-1",
    change_order_id: null,
    position: n * 1000,
    item_no: item,
    description: `Line ${item}`,
    scheduled_value_cents: scheduled,
    from_previous_cents: fromPrev,
    this_period_cents: thisPeriod,
    materials_stored_cents: stored,
    created_at: "2026-07-01T00:00:00Z",
  } as AiaLineItem;
}

async function build(application: AiaApplication, lines: AiaLineItem[], g702Over: Parameters<typeof computeG702>[0]) {
  const g702 = computeG702(g702Over);
  const buf = await buildAiaWorkbookBuffer({
    application,
    lines,
    g702,
    projectLabel: "Test Project",
    ownerLabel: "Test Owner",
    contractorLabel: "Test Contractor",
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const g = wb.getWorksheet(SHEET_G702) ?? wb.worksheets[0];
  const s = wb.getWorksheet(SHEET_G703) ?? wb.worksheets[1];
  /** Cell values, resolving a formula cell to its cached result. */
  const v = (sheet: ExcelJS.Worksheet, ref: string) => {
    const raw = sheet.getCell(ref).value as unknown;
    if (raw && typeof raw === "object" && "result" in (raw as Record<string, unknown>)) {
      return (raw as { result: unknown }).result;
    }
    return raw;
  };
  return { wb, g, s, g702, v, buf };
}

describe("the AIA workbook a general contractor receives", () => {
  it("builds both of her sheets, and keeps her own labels", async () => {
    const lines = [line(1, "1", 100_000_00, 60_000_00, 10_000_00)];
    const { wb, g, v } = await build(app(), lines, {
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 0,
    });
    expect(wb.worksheets.map((w) => w.name)).toEqual([SHEET_G702, SHEET_G703]);
    // Her form's own text, which our writes must never displace.
    expect(String(v(g, "A41"))).toContain("BALANCE TO FINISH");
    expect(v(g, "B42")).toBe("(Line 3 less Line 6)");
    expect(v(g, "A44")).toBe("CHANGE ORDER SUMMARY");
    expect(v(g, "D44")).toBe("ADDITIONS");
    expect(v(g, "E44")).toBe("DEDUCTIONS");
  });

  it("writes the nine cover-sheet lines as DOLLARS, to hand-checked figures", async () => {
    // $100,000 contract, $70,000 completed+stored, 5% retainage, nothing prior.
    //   line 5 = 5% of 70,000.00 = 3,500.00
    //   line 6 = 70,000.00 − 3,500.00 = 66,500.00
    //   line 9 = 100,000.00 − 66,500.00 = 33,500.00
    const lines = [line(1, "1", 100_000_00, 60_000_00, 5_000_00, 5_000_00)];
    const { g, v } = await build(app(), lines, {
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 0,
    });
    expect(v(g, "E24")).toBe(100_000); // 1
    expect(v(g, "E25")).toBe(0); // 2
    expect(v(g, "E26")).toBe(100_000); // 3
    expect(v(g, "E27")).toBe(70_000); // 4
    expect(v(g, "E35")).toBe(3_500); // 5
    expect(v(g, "E36")).toBe(66_500); // 6
    expect(v(g, "E39")).toBe(0); // 7
    expect(v(g, "E40")).toBe(66_500); // 8
    expect(v(g, "E41")).toBe(33_500); // 9
  });

  it("5a is retainage on COMPLETED work, 5b the remainder, and they foot to line 5", async () => {
    // D+E completed 65,000.00 → 5a = 3,250.00.  F stored 5,000.00 → 5b = 250.00.
    const lines = [line(1, "1", 100_000_00, 60_000_00, 5_000_00, 5_000_00)];
    const { g, v } = await build(app(), lines, {
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 0,
    });
    expect(v(g, "B30")).toBe(5); // the rate printed on her form
    expect(v(g, "D30")).toBe(3_250); // 5a
    expect(v(g, "D32")).toBe(250); // 5b
    expect(Number(v(g, "D30")) + Number(v(g, "D32"))).toBe(Number(v(g, "E35")));
  });

  it("the G703 retainage column totals line 5, line for line", async () => {
    const lines = [
      line(1, "1", 60_000_00, 30_000_00, 10_000_00),
      line(2, "2", 40_000_00, 10_000_00, 5_000_00),
    ];
    const { g, s, v } = await build(app(), lines, {
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 0,
    });
    // Hand-checked: 5% of 40,000.00 = 2,000.00; 5% of 15,000.00 = 750.00.
    expect(v(s, `J${FIRST_LINE_ROW}`)).toBe(2_000);
    expect(v(s, `J${FIRST_LINE_ROW + 1}`)).toBe(750);
    expect(v(g, "E35")).toBe(2_750);
    const column = [0, 1].reduce((n, i) => n + Number(v(s, `J${FIRST_LINE_ROW + i}`) ?? 0), 0);
    expect(column).toBe(Number(v(g, "E35")));
  });

  /*
   * STEPHANIE'S CIPLA SHAPE — the reason any of this changed.
   *
   * $87,627.09 billed, retained and RELEASED, then a $1,000 change order. The
   * retainage column must print $0.00 on every released line and $50.00 on the
   * change order, and the cover sheet must ask for $950.00.
   */
  it("prints no retainage on released lines, and the full rate on the change order", async () => {
    const base = line(1, "1", 87_627_09, 87_627_09, 0);
    const co = line(2, "CO-007", 1_000_00, 0, 1_000_00);
    const release = [line(1, "1", 87_627_09, 87_627_09, 0)];
    const lines = applyReleasedRetainage([base, co], release);
    const { g, s, v } = await build(app(), lines, {
      originalContractCents: 87_627_09,
      netChangeOrdersCents: 1_000_00,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 87_627_09,
    });
    expect(v(s, `J${FIRST_LINE_ROW}`)).toBe(0); // released — nothing withheld again
    expect(v(s, `J${FIRST_LINE_ROW + 1}`)).toBe(50); // 5% of the $1,000 CO
    expect(v(g, "E35")).toBe(50); // line 5
    expect(v(g, "E40")).toBe(950); // line 8 — what the GC pays
    expect(v(g, "E41")).toBe(50); // line 9
    // 5b is written as the REMAINDER of line 5, so a 5a computed off a
    // different base than line 5 prints a NEGATIVE 5b on a customer document.
    expect(v(g, "D30")).toBe(50);
    expect(v(g, "D32")).toBe(0);
    expect(Number(v(g, "D32"))).toBeGreaterThanOrEqual(0);
  });

  it("explains the retainage column ONLY when a release is behind it", async () => {
    const withRelease = applyReleasedRetainage(
      [line(1, "1", 87_627_09, 87_627_09, 0), line(2, "CO-007", 1_000_00, 0, 1_000_00)],
      [line(1, "1", 87_627_09, 87_627_09, 0)]
    );
    const after = await build(app(), withRelease, {
      originalContractCents: 87_627_09,
      netChangeOrdersCents: 1_000_00,
      retainagePct: 5,
      lines: withRelease,
      previousCertificatesCents: 87_627_09,
    });
    expect(String(after.v(after.g, "A43") ?? "")).toContain("87,627.09");
    expect(String(after.v(after.g, "A43") ?? "")).toMatch(/new work only/i);

    // An ordinary job has nothing to explain, and her spacer row stays empty.
    const plain = [line(1, "1", 100_000_00, 50_000_00, 0)];
    const before = await build(app(), plain, {
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines: plain,
      previousCertificatesCents: 0,
    });
    expect(before.v(before.g, "A43") ?? null).toBeNull();
  });

  it("drops no line, and grows her 22-row sheet rather than silently truncating", async () => {
    const many = Array.from({ length: 26 }, (_, i) => line(i + 1, String(i + 1), 1_000_00, 1_000_00, 0));
    const { s, v } = await build(app(), many, {
      originalContractCents: 26_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines: many,
      previousCertificatesCents: 0,
    });
    for (let i = 0; i < many.length; i++) {
      expect(v(s, `B${FIRST_LINE_ROW + i}`)).toBe(`Line ${i + 1}`);
    }
  });

  it("a deductive change order still earns downward on both sheets", async () => {
    const lines = [
      line(1, "1", 100_000_00, 100_000_00, 0),
      line(2, "CO-002", -4_000_00, -4_000_00, 0),
    ];
    const { g, s, v } = await build(app(), lines, {
      originalContractCents: 100_000_00,
      netChangeOrdersCents: -4_000_00,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 0,
    });
    expect(v(s, `G${FIRST_LINE_ROW + 1}`)).toBe(-4_000); // completed, negative
    expect(v(s, `J${FIRST_LINE_ROW + 1}`)).toBe(-200); // 5% of it, negative
    expect(v(g, "E27")).toBe(96_000); // line 4
    expect(v(g, "E35")).toBe(4_800); // line 5 = 5,000 − 200
  });

  it("a release certificate withholds nothing and asks for exactly what was held", async () => {
    const lines = [line(1, "1", 100_000_00, 100_000_00, 0)];
    const { g, s, v } = await build(app({ is_retainage_release: true, retainage_pct: 0 }), lines, {
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 0,
      lines,
      previousCertificatesCents: 95_000_00,
    });
    expect(v(g, "E35")).toBe(0); // line 5
    expect(v(g, "D30")).toBe(0); // 5a
    expect(v(g, "D32")).toBe(0); // 5b
    expect(v(s, `J${FIRST_LINE_ROW}`)).toBe(0);
    expect(v(g, "E40")).toBe(5_000); // line 8 = the retainage released
    expect(v(g, "E41")).toBe(0); // line 9 — nothing left
  });
});
