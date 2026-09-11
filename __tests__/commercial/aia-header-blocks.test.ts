import { describe, it, expect } from "vitest";
import {
  aiaOwnerLabel,
  aiaProjectLabel,
  aiaContractorLabel,
} from "@/lib/commercial/aia/header-labels";

/**
 * The three identity blocks at the top of a G702.
 *
 * Stephanie 2026-09-11: "To Owner: GC/Builder name and address (wrap the text
 * below instead of it showing up as one long line in a single cell) · Project:
 * Project name and address (wrap text) · From Contractor: Tomco Painting and
 * address."
 *
 * All three carried the name only. These blocks are the parties to the
 * contract — an architect or lender reading the certificate has to be able to
 * identify each one.
 */
describe("TO OWNER", () => {
  it("stacks the GC's name over its billing address", () => {
    expect(
      aiaOwnerLabel({
        company_name: "Alta Construction East Inc.",
        billing_street: "1 Sunrise Hwy",
        billing_street2: "Suite 200",
        billing_city: "Bay Shore",
        billing_state: "NY",
        billing_zip: "11706",
      })
    ).toBe("Alta Construction East Inc.\n1 Sunrise Hwy\nSuite 200\nBay Shore, NY 11706");
  });

  it("skips the blanks rather than printing empty lines or stray commas", () => {
    // A GC with no address on file must not produce "Name\n\n, " — half these
    // accounts predate the billing fields.
    expect(aiaOwnerLabel({ company_name: "Alta" })).toBe("Alta");
    expect(
      aiaOwnerLabel({ company_name: "Alta", billing_city: "Bay Shore", billing_state: "NY" })
    ).toBe("Alta\nBay Shore, NY");
    expect(aiaOwnerLabel({ company_name: "Alta", billing_zip: "11706" })).toBe("Alta\n11706");
  });
});

describe("PROJECT", () => {
  it("does not print the street twice when the job is NAMED for it", () => {
    // Brendan 2026-09-03 made the job name the address, so on most jobs these
    // two fields are now the same string. Stacking them naively printed
    // "115 Connetquot Ave" on two consecutive lines of a document a GC pays
    // against.
    expect(
      aiaProjectLabel("115 Connetquot Ave", {
        property_street: "115 Connetquot Ave",
        property_city: "Islip",
        property_state: "NY",
        property_zip: "11751",
      })
    ).toBe("115 Connetquot Ave\nIslip, NY 11751");
  });

  it("compares case- and space-insensitively", () => {
    expect(
      aiaProjectLabel("115 connetquot ave ", { property_street: "115 Connetquot Ave" })
    ).toBe("115 connetquot ave");
  });

  it("still prints the street when the job has its own name", () => {
    expect(
      aiaProjectLabel("JD Sports Fit-Out", {
        property_street: "123 Main St",
        property_city: "Islip",
        property_state: "NY",
        property_zip: "11751",
      })
    ).toBe("JD Sports Fit-Out\n123 Main St\nIslip, NY 11751");
  });
});

describe("FROM CONTRACTOR", () => {
  it("uses the LEGAL name — this block is the party that signs", () => {
    expect(
      aiaContractorLabel({
        name: "Tomco Painting",
        legal_name: "Tomco Painting Inc.",
        address_line1: "77 Windsor Place, Ste. 13",
        city: "Central Islip",
        state: "NY",
        zip: "11722",
      })
    ).toBe("Tomco Painting Inc.\n77 Windsor Place, Ste. 13\nCentral Islip, NY 11722");
  });

  it("falls back to the trading name when no legal name is set", () => {
    expect(aiaContractorLabel({ name: "Tomco Painting", legal_name: null })).toBe("Tomco Painting");
  });
});

describe("the cells actually wrap", () => {
  it("sets wrapText on all three, or the newlines render as one long line", async () => {
    // The whole point of her note. Excel shows an embedded newline as a run-on
    // unless the cell wraps — so without this the address change makes the
    // block WORSE than the name-only version it replaced. Asserted on the
    // rendered workbook, not on the source.
    const { buildAiaWorkbookBuffer } = await import("@/lib/commercial/aia/export");
    const buf = await buildAiaWorkbookBuffer({
      application: { id: "a", opportunity_id: "o", application_number: 1, status: "draft", period_from: null, period_to: null, original_contract_cents: 25_000_00, retainage_pct: 10, notes: null },
      lines: [{ id: "l1", item_no: "1", description: "Original Contract", scheduled_value_cents: 27_187_50, from_previous_cents: 0, this_period_cents: 0, materials_stored_cents: 0, position: 1000, change_order_id: null }],
      g702: { originalContractCents: 25_000_00, netChangeOrdersCents: 0, salesTaxCents: 0, contractSumToDateCents: 27_187_50, totalCompletedStoredCents: 0, retainageCents: 0, totalEarnedLessRetainageCents: 0, previousCertificatesCents: 0, currentPaymentDueCents: 0, balanceToFinishCents: 27_187_50, percentCompleteBps: 0, sovVarianceCents: 0 },
      ownerLabel: "Alta\n1 Sunrise Hwy\nBay Shore, NY 11706",
      projectLabel: "115 Connetquot Ave\nIslip, NY 11751",
      contractorLabel: "Tomco Painting Inc.\n77 Windsor Place\nCentral Islip, NY 11722",
    } as never);

    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const g = wb.getWorksheet("Loan G-702")!;
    for (const ref of ["A4", "D4", "A11"]) {
      expect(g.getCell(ref).alignment?.wrapText, `${ref} does not wrap`).toBe(true);
      expect(String(g.getCell(ref).value)).toContain("\n");
    }
  }, 60_000);
});
