import { describe, it, expect } from "vitest";
import { summarizeSalesTax, type SalesTaxRow } from "@/lib/commercial/reports/sales-tax";

/**
 * Sales tax — the figures a filing is built from, so every one is pinned.
 *
 * The half that matters most isn't the collected total: it's the exempt
 * invoices with no certificate behind them. An exemption you can't produce
 * paperwork for is an assessment waiting to happen, and it is invisible on any
 * report that only totals the tax column.
 */

function row(over: Partial<SalesTaxRow> = {}): SalesTaxRow {
  return {
    invoiceId: "i1",
    invoiceNumber: "INV-0001",
    issuedYmd: "2026-08-10",
    accountId: "a1",
    accountName: "Acme GC",
    jobName: "Panera — Holbrook",
    subtotalCents: 100_000_00,
    taxCents: 8_625_00,
    taxPct: 8.625,
    exempt: false,
    exemptSource: null,
    exemptKind: null,
    migrated: false,
    certNumber: null,
    href: "/x",
    ...over,
  };
}

const exempt = (over: Partial<SalesTaxRow> = {}) =>
  row({
    taxCents: 0,
    exempt: true,
    taxPct: 0,
    exemptKind: over.certNumber ? "certified" : over.exemptSource ? "no_cert" : "unmarked",
    ...over,
  });

describe("summarizeSalesTax", () => {
  it("totals the taxable base and the tax collected", () => {
    const r = summarizeSalesTax([row(), row({ invoiceId: "i2", subtotalCents: 50_000_00, taxCents: 4_312_50 })]);
    expect(r.taxableBaseCents).toBe(150_000_00);
    expect(r.taxCollectedCents).toBe(12_937_50);
  });

  it("keeps exempt money out of the taxable base", () => {
    // Otherwise a filing overstates the base and the two halves stop tying.
    const r = summarizeSalesTax([row(), exempt({ invoiceId: "i2", subtotalCents: 80_000_00 })]);
    expect(r.taxableBaseCents).toBe(100_000_00);
    expect(r.exemptBaseCents).toBe(80_000_00);
    expect(r.exemptCount).toBe(1);
  });

  // The point of the report.
  it("counts exempt invoices with no certificate behind them", () => {
    const r = summarizeSalesTax([
      exempt({ invoiceId: "i1", subtotalCents: 40_000_00, certNumber: "EX-123", exemptSource: "opportunity" }),
      exempt({ invoiceId: "i2", subtotalCents: 60_000_00, certNumber: null }),
    ]);
    expect(r.uncertifiedCount).toBe(1);
    expect(r.uncertifiedBaseCents).toBe(60_000_00);
  });

  it("a TAXED invoice is never counted as uncertified", () => {
    // It has no certificate because it needs none — counting it would put the
    // whole book in a compliance warning.
    const r = summarizeSalesTax([row({ certNumber: null })]);
    expect(r.uncertifiedCount).toBe(0);
    expect(r.uncertifiedBaseCents).toBe(0);
  });

  it("groups by the rate each invoice froze", () => {
    const r = summarizeSalesTax([
      row({ invoiceId: "i1", taxPct: 8.625, subtotalCents: 100_00, taxCents: 8_63 }),
      row({ invoiceId: "i2", taxPct: 8.625, subtotalCents: 200_00, taxCents: 17_25 }),
      row({ invoiceId: "i3", taxPct: 8.875, subtotalCents: 400_00, taxCents: 35_50 }),
    ]);
    expect(r.byRate).toHaveLength(2);
    // Biggest tax first — that's the jurisdiction the filing is mostly about.
    expect(r.byRate[0].taxPct).toBe(8.875);
    expect(r.byRate[1].count).toBe(2);
    expect(r.byRate[1].baseCents).toBe(300_00);
  });

  it("filters to a period on the issue date", () => {
    const r = summarizeSalesTax(
      [row({ invoiceId: "i1", issuedYmd: "2026-07-31" }), row({ invoiceId: "i2", issuedYmd: "2026-08-01" })],
      { fromYmd: "2026-08-01", toYmd: "2026-08-31" }
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].invoiceId).toBe("i2");
    expect(r.filtered).toBe(true);
  });

  it("the no-certificate filter shows only the risk", () => {
    const r = summarizeSalesTax(
      [row(), exempt({ invoiceId: "i2", certNumber: "EX-1" }), exempt({ invoiceId: "i3", certNumber: null })],
      { uncertifiedOnly: true }
    );
    expect(r.rows.map((x) => x.invoiceId)).toEqual(["i3"]);
  });

  /**
   * A FILTER MUST RETURN WHAT THE SENTENCE BESIDE IT COUNTED.
   *
   * The page shows two warnings, and they are deliberately different problems:
   * "marked exempt with no certificate on file" is missing paperwork, and
   * "charged no tax on a job that was never marked exempt" is usually
   * under-billing — in NY everything is taxable unless an exemption is claimed.
   *
   * Both banners' "Show just those" pointed at `uncertifiedOnly`, which is
   * `exempt && no certificate` — the UNION of the two. On production that meant
   * pressing it under a sentence reading 2 returned 5: the two it named plus
   * the three from the banner above. And the worse of the two warnings had no
   * link at all, so the only filter offered was for the lesser problem and it
   * silently included the greater one.
   *
   * The count you are checking against is the one you just read, so a filter
   * that returns more than it is wrong in the direction that gets believed.
   */
  describe("each warning filters to its own rows", () => {
    const rows = [
      row({ invoiceId: "taxed" }),
      exempt({ invoiceId: "certified", certNumber: "EX-1" }),
      exempt({ invoiceId: "nocert", certNumber: null, exemptSource: "opportunity" }),
      exempt({ invoiceId: "unmarked-a", certNumber: null }),
      exempt({ invoiceId: "unmarked-b", certNumber: null }),
    ];

    it("checks the fixture really holds both kinds", () => {
      // An audit must prove it measured: a fixture where every exempt row is
      // the same kind would pass both assertions below for the wrong reason.
      const kinds = rows.map((r) => r.exemptKind);
      expect(kinds).toContain("no_cert");
      expect(kinds).toContain("unmarked");
      expect(kinds).toContain("certified");
    });

    it("no_cert returns only the claimed-but-undocumented ones", () => {
      const r = summarizeSalesTax(rows, { exemptKind: "no_cert" });
      expect(r.rows.map((x) => x.invoiceId)).toEqual(["nocert"]);
      expect(r.filtered).toBe(true);
    });

    it("unmarked returns only the never-claimed ones", () => {
      const r = summarizeSalesTax(rows, { exemptKind: "unmarked" });
      expect(r.rows.map((x) => x.invoiceId).sort()).toEqual(["unmarked-a", "unmarked-b"]);
      expect(r.filtered).toBe(true);
    });

    it("neither kind returns the other's rows — the actual bug", () => {
      const noCert = summarizeSalesTax(rows, { exemptKind: "no_cert" }).rows;
      const unmarked = summarizeSalesTax(rows, { exemptKind: "unmarked" }).rows;
      expect(noCert.length + unmarked.length).toBe(3);
      expect(noCert.some((r) => r.exemptKind === "unmarked")).toBe(false);
      expect(unmarked.some((r) => r.exemptKind === "no_cert")).toBe(false);
    });

    it("keeps the old both-kinds filter working for a bookmarked link", () => {
      const r = summarizeSalesTax(rows, { uncertifiedOnly: true });
      expect(r.rows).toHaveLength(3);
    });

    it("ignores a kind nobody defined rather than filtering to nothing", () => {
      const r = summarizeSalesTax(rows, { exemptKind: undefined });
      expect(r.rows).toHaveLength(5);
      expect(r.filtered).toBe(false);
    });
  });

  it("lists newest first — a filing is about the period you just closed", () => {
    const r = summarizeSalesTax([
      row({ invoiceId: "old", issuedYmd: "2026-06-01" }),
      row({ invoiceId: "new", issuedYmd: "2026-08-01" }),
    ]);
    expect(r.rows[0].invoiceId).toBe("new");
  });

  it("is empty, not broken, with no invoices", () => {
    const r = summarizeSalesTax([]);
    expect(r.taxCollectedCents).toBe(0);
    expect(r.byRate).toEqual([]);
    expect(r.uncertifiedCount).toBe(0);
  });

  // Three different situations, and a filing preparer treats them differently.
  describe("why no tax was charged", () => {
    it("separates a missing certificate from a missing decision", () => {
      const r = summarizeSalesTax([
        exempt({ invoiceId: "ok", subtotalCents: 10_000_00, certNumber: "EX-1", exemptSource: "opportunity" }),
        exempt({ invoiceId: "paperwork", subtotalCents: 20_000_00, exemptSource: "account" }),
        exempt({ invoiceId: "nobody-decided", subtotalCents: 30_000_00 }),
      ]);
      expect(r.noCertCount).toBe(1);
      expect(r.noCertBaseCents).toBe(20_000_00);
      // The worse one: in NY everything is taxable unless an exemption is
      // claimed, so this is likely under-billed tax, not an unfiled document.
      expect(r.unmarkedCount).toBe(1);
      expect(r.unmarkedBaseCents).toBe(30_000_00);
      // Both are still exposure, so the headline counts them together.
      expect(r.uncertifiedCount).toBe(2);
      expect(r.uncertifiedBaseCents).toBe(50_000_00);
    });

    it("a certified exemption is in neither bucket", () => {
      const r = summarizeSalesTax([exempt({ certNumber: "EX-1", exemptSource: "opportunity" })]);
      expect(r.uncertifiedCount).toBe(0);
      expect(r.noCertCount).toBe(0);
      expect(r.unmarkedCount).toBe(0);
    });
  });
});
