import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderProposalPdf } from "@/lib/commercial/proposals/pdf";
import type { CommercialProposal, CommercialProposalLineItem } from "@/lib/commercial/proposals/db";

/**
 * Render the document. Do not merely read the code that renders it.
 *
 * Every proposal defect Stephanie reported was visible in the OUTPUT and
 * invisible in the source — sections in the wrong order, a price that printed
 * against its own checkbox, a total restated under the alternates.
 * proposal-pdf-shape.test.ts asserts the source's structure, which catches
 * order and duplication, but it cannot see LAYOUT.
 *
 * And layout is where the next one was: rendering this fixture on 2026-08-22
 * showed the sign-off split across a page break — "Brendan Dwyer / Lead
 * Estimator" ending page one, his phone and email orphaned onto page two. I
 * had made that block taller earlier the same day by merging the estimator's
 * details into it, and no amount of reading the file would have shown it. A GC
 * would have seen a signature block with no way to reach anyone.
 *
 * There is no PDF text extractor in this project and adding a dependency for a
 * test is not worth it, so this asserts what can be read from the bytes: that
 * it renders at all, that it is a valid PDF, and how many PAGES it takes —
 * which is enough to catch a layout blow-up and to prove the compact option
 * does what it claims.
 */

function pageCount(buf: Buffer): number {
  const s = buf.toString("latin1");
  const m = /\/Count\s+(\d+)/.exec(s);
  return m ? Number(m[1]) : (s.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function line(id: string, description: string, cents: number, alt = false): CommercialProposalLineItem {
  return {
    id, proposal_id: "p1", product_name: null, description,
    quantity: 1, unit: "each", unit_price_cents: cents, is_alternate: alt,
    is_labor: false, position: 0, phase: null, show_price: false,
    line_total_override_cents: null, customer_approved: null,
    created_at: "", updated_at: "",
  } as unknown as CommercialProposalLineItem;
}

function proposal(over: Partial<CommercialProposal> = {}): CommercialProposal {
  return {
    id: "p1", opportunity_id: "o1", revision_number: 1, status: "draft",
    header_json: {
      gc_company: "Alta Construction East Inc.",
      project_name: "JD Sports — Junction Blvd",
      date_iso: "2026-08-22",
      show_capital_improvement_notice: false,
    },
    intro_text_override: null, bid_set_date: "2026-01-11",
    alternate_notes: "Price assumes one mobilisation and clear, unobstructed access.",
    bid_notes: null, exclusion_ids: [], custom_exclusions: [],
    pdf_show_line_prices: false, pdf_compact: false,
    estimator_snapshot_json: {
      name: "Brendan Dwyer", title: "Lead Estimator",
      phone: "631-300-8984", email: "Brendan@Tomcopainting.com",
    },
    total_cents: 30_000_00, final_price_override_cents: null,
    ...over,
  } as unknown as CommercialProposal;
}

const COMPANY = { name: "Tomco Painting", phone: "631-582-2770", email: "info@tomcopainting.com" } as never;
const LINES = [
  line("1", "Drywall Ceiling: Prep and paint with latex, flat finish.", 20_000_00),
  line("2", "Exterior Facade: Power wash and paint.", 10_000_00),
  line("3", "Wallcovering in lobby", 4_500_00, true),
];
const ARGS = {
  lineItems: LINES,
  exclusions: ["Working outside of standard business hours M-F.", "Wallpaper"],
  qualifications: ["Assumes surfaces are free of mould and loose paint."],
  showSignatureBlock: true,
  company: COMPANY,
  tax: {
    priceCents: 30_000_00, label: "NYS Sales Tax (8.625%)",
    taxCents: 2_587_50, totalCents: 32_587_50,
    jurisdictionName: "Suffolk", rateThou: 8625,
  },
};

describe("the proposal PDF renders", () => {
  it("produces a valid PDF for a realistic proposal", async () => {
    const buf = await renderProposalPdf({ proposal: proposal(), ...ARGS });
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.toString("latin1").startsWith("%PDF")).toBe(true);
  }, 60_000);

  it("renders the internal estimator copy too", async () => {
    // Different code path — line-item tables, watermark, bid notes — and it has
    // its own props. It has broken independently before.
    const buf = await renderProposalPdf({
      proposal: proposal({ bid_notes: "Assumed 2 coats over existing." } as never),
      ...ARGS,
      mode: "internal",
      showSignatureBlock: false,
    });
    expect(buf.toString("latin1").startsWith("%PDF")).toBe(true);
  }, 60_000);

  it("compact never takes MORE pages than normal", async () => {
    // The whole claim of the compact option (Stephanie: "put it all on one page
    // or an option to change the format"). If tightening the type ever stopped
    // saving space, the checkbox would be a lie.
    const [normal, compact] = await Promise.all([
      renderProposalPdf({ proposal: proposal(), ...ARGS }),
      renderProposalPdf({ proposal: proposal({ pdf_compact: true } as never), ...ARGS }),
    ]);
    expect(pageCount(compact)).toBeLessThanOrEqual(pageCount(normal));
  }, 90_000);

  it("keeps the sign-off block whole", () => {
    // Cannot be seen from the bytes without a text extractor, so it is pinned
    // at the source: wrap={false} is what stops the contact details being
    // orphaned onto the next page away from the name.
    const src = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");
    const at = src.indexOf("function SignatureBlock");
    const block = src.slice(at, src.indexOf("\nfunction ", at + 10));
    expect(block).toContain("wrap={false}");
  });
});
