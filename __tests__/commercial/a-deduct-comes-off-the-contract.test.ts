import { describe, it, expect } from "vitest";

/**
 * A DEDUCT ALTERNATE COMES OFF THE CONTRACT.
 *
 * `proposalLineItemSumCents` writes `commercial_proposals.total_cents`, which
 * is the single contract number G702 line 1, `accepted_contract_cents`,
 * invoicing, tax and the KPIs all consume. It summed `quantity ×
 * unit_price_cents` and then ADDED any approved alternate whatever its sign,
 * ignoring both `is_deduct` and `line_total_override_cents`.
 *
 * The two other definitions of the same money were already right —
 * `lineTotalCents` in proposals/pdf.tsx honours the override, and
 * `acceptAlternateAction` negates a deduct before raising the change order.
 * The one that writes the contract did neither.
 *
 * Measured on the live book 2026-10-16: PROP-3109 carries the only two deduct
 * lines in the system, $112,093.00 and $59,659.76, on a SENT proposal nobody
 * has answered yet. Ticking "✓ Taken" on both would have written $479,761.09
 * where the contract is $136,255.57 — wrong by $343,505.52.
 *
 * WHY THIS FILE EXISTS AT ALL. There is already a
 * `proposal-deduct-alternates.test.ts` with fifteen green assertions, and
 * every one of them is a regex over source text —
 * `expect(pdfSrc).toMatch(/Deduct Alternate:/)`. Not one asserts a total. The
 * feature shipped green with the money path wrong. So this tests the
 * ARITHMETIC, against constructed rows, with every expected figure a literal.
 *
 * The reduce is reproduced here rather than imported because the real function
 * is `server-only` and takes a database. That is a real limitation and worth
 * stating: this pins the RULE, and `npm run check:money` pins the live rows.
 * If the two drift, the duplication is the bug — which is why the body below
 * is copied verbatim from `lib/commercial/proposals/db.ts`.
 */

type Row = {
  quantity: number;
  unit_price_cents: number;
  is_alternate: boolean;
  is_deduct?: boolean | null;
  line_total_override_cents?: number | null;
  customer_approved?: boolean | null;
  customer_approved_at?: string | null;
};

/** Verbatim from proposalLineItemSumCents. */
function lineValueCents(r: Row): number {
  const ov = r.line_total_override_cents;
  const magnitude =
    ov !== null && ov !== undefined && Number.isFinite(Number(ov))
      ? Math.round(Number(ov))
      : Math.round(Number(r.quantity) * Number(r.unit_price_cents));
  return r.is_deduct === true ? -Math.abs(magnitude) : magnitude;
}

/** The sum, with the win cut-off collapsed to "accepted counts". */
function sum(rows: Row[]): number {
  return rows.reduce((acc, r) => {
    const value = lineValueCents(r);
    if (!r.is_alternate) return acc + value;
    if (r.customer_approved !== true) return acc;
    return acc + value;
  }, 0);
}

const base = (over: Partial<Row> = {}): Row => ({
  quantity: 1,
  unit_price_cents: 0,
  is_alternate: false,
  ...over,
});

describe("a deduct alternate comes off the contract", () => {
  it("PROP-3109's live shape: both deducts taken leaves $136,255.57, not $479,761.09", () => {
    const rows: Row[] = [
      base({ unit_price_cents: 308_008_33 }), // the base scope
      base({
        unit_price_cents: 112_093_00,
        is_alternate: true,
        is_deduct: true,
        customer_approved: true,
      }),
      base({
        unit_price_cents: 59_659_76,
        is_alternate: true,
        is_deduct: true,
        customer_approved: true,
      }),
    ];
    expect(sum(rows)).toBe(136_255_57);
    // What the old reduce produced, and the size of the error.
    expect(308_008_33 + 112_093_00 + 59_659_76).toBe(479_761_09);
    expect(479_761_09 - sum(rows)).toBe(343_505_52);
  });

  it("an unanswered deduct changes nothing — which is why today's book is still correct", () => {
    const rows: Row[] = [
      base({ unit_price_cents: 308_008_33 }),
      base({ unit_price_cents: 112_093_00, is_alternate: true, is_deduct: true }),
      base({ unit_price_cents: 59_659_76, is_alternate: true, is_deduct: true }),
    ];
    expect(sum(rows)).toBe(308_008_33);
  });

  it("a declined deduct changes nothing either", () => {
    const rows: Row[] = [
      base({ unit_price_cents: 100_000_00 }),
      base({
        unit_price_cents: 10_000_00,
        is_alternate: true,
        is_deduct: true,
        customer_approved: false,
      }),
    ];
    expect(sum(rows)).toBe(100_000_00);
  });

  it("an ADD alternate taken still adds — the rule turns on the sign, not on being an alternate", () => {
    const rows: Row[] = [
      base({ unit_price_cents: 100_000_00 }),
      base({ unit_price_cents: 10_000_00, is_alternate: true, customer_approved: true }),
    ];
    expect(sum(rows)).toBe(110_000_00);
  });

  it("a hand-priced line uses the price the estimator typed, which is what the PDF prints", () => {
    const rows: Row[] = [
      // qty 10 x $500 = $5,000, overridden to $4,250.
      base({ quantity: 10, unit_price_cents: 500_00, line_total_override_cents: 4_250_00 }),
    ];
    expect(sum(rows)).toBe(4_250_00);
  });

  it("an override on a DEDUCT still comes off", () => {
    const rows: Row[] = [
      base({ unit_price_cents: 100_000_00 }),
      base({
        quantity: 1,
        unit_price_cents: 9_999_99,
        line_total_override_cents: 8_000_00,
        is_alternate: true,
        is_deduct: true,
        customer_approved: true,
      }),
    ];
    expect(sum(rows)).toBe(92_000_00);
  });

  it("an override of ZERO is honoured, not treated as absent", () => {
    // `0` is falsy; a `??`-free truthiness check would fall back to qty x unit.
    const rows: Row[] = [
      base({ quantity: 4, unit_price_cents: 250_00, line_total_override_cents: 0 }),
    ];
    expect(sum(rows)).toBe(0);
  });

  it("a deduct whose magnitude was stored negative is not double-negated", () => {
    // Math.abs is load-bearing: the UI stores a magnitude, but a hand-written
    // row or an import could carry the sign already.
    const rows: Row[] = [
      base({ unit_price_cents: 100_000_00 }),
      base({
        unit_price_cents: -10_000_00,
        is_alternate: true,
        is_deduct: true,
        customer_approved: true,
      }),
    ];
    expect(sum(rows)).toBe(90_000_00);
  });

  it("a NON-alternate deduct also comes off — the sign is the rule", () => {
    const rows: Row[] = [
      base({ unit_price_cents: 100_000_00 }),
      base({ unit_price_cents: 5_000_00, is_deduct: true }),
    ];
    expect(sum(rows)).toBe(95_000_00);
  });

  it("the contract can be driven to zero but the arithmetic stays honest below it", () => {
    const rows: Row[] = [
      base({ unit_price_cents: 10_000_00 }),
      base({
        unit_price_cents: 12_000_00,
        is_alternate: true,
        is_deduct: true,
        customer_approved: true,
      }),
    ];
    // Not clamped here. A negative contract is a data problem to surface, not
    // one to hide behind a Math.max — the clamp belongs where it can explain.
    expect(sum(rows)).toBe(-2_000_00);
  });
});
