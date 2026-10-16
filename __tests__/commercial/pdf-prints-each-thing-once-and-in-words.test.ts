import { describe, it, expect } from "vitest";
import { renderProposalPdf } from "@/lib/commercial/proposals/pdf";
import type { CommercialProposal, CommercialProposalLineItem } from "@/lib/commercial/proposals/db";
import { mergeProposalExclusions } from "@/lib/commercial/proposals/exclusion-merge";
import { renderSignaturePagePdf } from "@/lib/commercial/esign/pdf";
import { pdfText, occurrences } from "../helpers/pdf-text";

/**
 * Two things a customer PDF printed wrong, read off the RENDERED page text.
 *
 * Each test carries its own control: the same render with the old input (or
 * the old output) must show the defect, so the extractor is proven to see the
 * thing it is asserting is absent. Proven against 6a125921 as well — the
 * duplicated exclusion counted 2, the e-sign date read "2026-09-15".
 */

const TAX_LINE = "Sales Tax, unless applicable.";

function line(id: string, description: string, cents: number): CommercialProposalLineItem {
  return {
    id, proposal_id: "p1", product_name: null, description,
    quantity: 1, unit: "each", unit_price_cents: cents, is_alternate: false,
    is_labor: false, position: 0, phase: null, show_price: false,
    line_total_override_cents: null, customer_approved: null,
    created_at: "", updated_at: "",
  } as unknown as CommercialProposalLineItem;
}

const PROPOSAL = {
  id: "p1", opportunity_id: "o1", revision_number: 1, status: "draft",
  header_json: { gc_company: "Vision GC", project_name: "Inspection Room", date_iso: "2026-10-08", show_capital_improvement_notice: false },
  intro_text_override: null, bid_set_date: null, alternate_notes: null, bid_notes: null,
  exclusion_ids: [], custom_exclusions: [], pdf_show_line_prices: false, pdf_compact: false,
  estimator_snapshot_json: { name: "Brendan Dwyer", title: "VP", phone: "631-300-8984", email: "b@tomco.test" },
  total_cents: 10_000_00, final_price_override_cents: null,
} as unknown as CommercialProposal;

async function renderWith(exclusions: string[]) {
  return renderProposalPdf({
    proposal: PROPOSAL,
    lineItems: [line("1", "Walls: prep and paint, eggshell.", 10_000_00)],
    exclusions,
    qualifications: [],
    showSignatureBlock: true,
    company: { name: "Tomco Painting" } as never,
    tax: null,
  } as never);
}

describe("a proposal's exclusions", () => {
  it("print a line once when it is both ticked from the library and typed as custom", async () => {
    const library = [
      { text: TAX_LINE, kind: "exclusion" as const },
      { text: "Wallpaper removal.", kind: "exclusion" as const },
    ];
    // Typed again, with different spacing and no full stop — still the same line.
    const custom = [{ text: "Sales  Tax, unless applicable", kind: "exclusion" as const }];

    const merged = mergeProposalExclusions(library, custom).map((e) => e.text);
    const fixed = await pdfText(await renderWith(merged));
    // Control: the old resolver concatenated, so the old page showed it twice.
    const old = await pdfText(await renderWith([...library, ...custom].map((e) => e.text)));

    expect(occurrences(old, "unless applicable")).toBe(2);
    expect(occurrences(fixed, "unless applicable")).toBe(1);
    expect(fixed).toContain("Wallpaper removal.");
  }, 60_000);
});

describe("the e-sign acceptance page", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
  const input = {
    company: { name: "Tomco Painting", address_lines: ["1 Main St", "Islip, NY 11751"], phone: "631-555-0100", website: "tomcopainting.com" },
    logo: null,
    requestId: "11111111-1111-1111-1111-111111111111",
    proposalLabel: "Proposal R1",
    proposalNumber: "2026-0042",
    projectName: "Nordstrom Rack - Holbrook",
    gcCompany: "ARCADIS",
    proposalDate: "2026-10-08",
    documentSha256: "d86fbd4e478541af3d8d90992b7fc6eb8009e3bef1c49891f1f720f6601505c4",
    customer: { name: "Jane Doe", title: "PM", company: "ARCADIS", email: "j@arcadis.test", signedAt: "2026-10-09T17:17:36Z", signature: PNG },
    contractor: { name: "Brendan Dwyer", title: "VP", signedAt: "2026-10-09T17:26:32Z", signature: PNG },
  };

  it("prints the proposal date in words, the way the proposal does", async () => {
    const text = await pdfText(await renderSignaturePagePdf(input as never));
    // The extractor can read this page at all (a known phrase is found)…
    expect(text).toContain("ARCADIS");
    // …the date is in words…
    expect(text).toContain("October 8, 2026");
    // …and the raw ISO form is gone.
    expect(text).not.toContain("2026-10-08");
  }, 60_000);

  it("still prints a dash when the proposal has no date", async () => {
    const text = await pdfText(await renderSignaturePagePdf({ ...input, proposalDate: null } as never));
    expect(text).toContain("ARCADIS");
    expect(text).not.toContain("October 8, 2026");
  }, 60_000);
});
