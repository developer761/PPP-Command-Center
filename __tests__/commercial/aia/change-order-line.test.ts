import { describe, it, expect } from "vitest";
import { isAiaChangeOrderLine, computeG702 } from "@/lib/commercial/aia/constants";

/**
 * M2 regression: the G702 "Original Contract Sum" (line 1) is BASE work only —
 * change orders are line 2. `isAiaChangeOrderLine` is the ONE definition the
 * seed snap, the live certificate, the App-2 carry-forward, and the portfolio
 * rollup all use to exclude CO rows from the base schedule-of-values total. If
 * it stops recognising a CO row, that row's amount lands in the contract base
 * AND in netCO, double-counting the change order on line 3.
 */
describe("isAiaChangeOrderLine", () => {
  it("recognises a row tagged with change_order_id", () => {
    expect(isAiaChangeOrderLine({ change_order_id: "co-uuid", item_no: "7" })).toBe(true);
  });

  it("recognises a legacy CO-### item_no (pre-migration-128, no FK backfill)", () => {
    expect(isAiaChangeOrderLine({ change_order_id: null, item_no: "CO-001" })).toBe(true);
    expect(isAiaChangeOrderLine({ change_order_id: null, item_no: "co-42" })).toBe(true);
    expect(isAiaChangeOrderLine({ change_order_id: null, item_no: "CO-007" })).toBe(true);
  });

  it("treats plain numbered base lines as NOT change orders", () => {
    expect(isAiaChangeOrderLine({ change_order_id: null, item_no: "1" })).toBe(false);
    expect(isAiaChangeOrderLine({ change_order_id: null, item_no: "12" })).toBe(false);
    expect(isAiaChangeOrderLine({ change_order_id: null, item_no: null })).toBe(false);
  });

  it("does not mistake a description that merely mentions CO for a CO row", () => {
    // Only the item_no is inspected — a base line described as "CO coordination"
    // with item_no "3" must stay base.
    expect(isAiaChangeOrderLine({ change_order_id: null, item_no: "3" })).toBe(false);
  });
});

/**
 * End-to-end footing: line 1 (base) + line 2 (netCO) must equal line 3, and the
 * G703 grand total (base rows + CO rows) must tie to line 3 — so the two sheets
 * the GC receives agree. This is the invariant M2 + F2 restore.
 */
describe("G702 foots when base + CO rows are summed the shared way", () => {
  it("contract sum to date = base line-1 + netCO, matching Σ all scheduled values", () => {
    const baseRows = [
      { change_order_id: null, item_no: "1", scheduled_value_cents: 300_000_00, from_previous_cents: 0, this_period_cents: 0, materials_stored_cents: 0 },
      { change_order_id: null, item_no: "2", scheduled_value_cents: 150_000_00, from_previous_cents: 0, this_period_cents: 0, materials_stored_cents: 0 },
    ];
    const coRows = [
      { change_order_id: "co-1", item_no: "CO-001", scheduled_value_cents: 50_000_00, from_previous_cents: 0, this_period_cents: 0, materials_stored_cents: 0 },
    ];
    const allLines = [...baseRows, ...coRows];

    const baseSov = allLines.filter((l) => !isAiaChangeOrderLine(l)).reduce((s, l) => s + l.scheduled_value_cents, 0);
    const netCO = coRows.reduce((s, l) => s + l.scheduled_value_cents, 0);
    const g702 = computeG702({
      originalContractCents: baseSov, // line 1 — base only
      netChangeOrdersCents: netCO, // line 2
      retainagePct: 10,
      lines: allLines, // G703 grand total = base + CO
      previousCertificatesCents: 0,
    });

    expect(g702.originalContractCents).toBe(450_000_00);
    expect(g702.contractSumToDateCents).toBe(500_000_00);
    // The two sheets tie: contract sum to date == Σ every scheduled value.
    expect(g702.sovVarianceCents).toBe(0);
  });
});
