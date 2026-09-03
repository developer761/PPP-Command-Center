import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * EVERY path that renders a proposal PDF fits it to one page.
 *
 * Brendan 2026-09-03: "this splits into 2 pages."
 *
 * It did — in the EMAIL, and only there. Fit-to-one-page lived in the download
 * route and nowhere else, so Preview showed one page and the attachment the GC
 * actually received had two. The copy that matters was the copy skipping the
 * fit.
 *
 * Three sites render this PDF: the download route, the send path, and the
 * estimating-report filing. A seam test, because nothing in the type system
 * says they have to agree — each one calls `renderProposalPdf` directly and
 * compiles perfectly without the wrapper.
 *
 * The same reasoning already had a comment in the send path — "one resolver …
 * so the archived snapshot can't differ from what the customer saw" — about the
 * DATA. The layout needed saying out loud too.
 */
const SITES: Array<[string, string, string]> = [
  ["download route", "app/api/commercial/proposals/[proposalId]/pdf/route.ts", "renderProposalPdf"],
  ["send to the GC", "lib/commercial/proposals/db.ts", "renderProposalPdf"],
  ["estimating report", "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "renderProposalPdf"],

  // Karan 2026-09-03 — the rule is not about proposals, it is about what a GC
  // receives: "make sure ... it still doesnt and never goes above one page."
  //
  // Every one of these had the SAME shape as the proposal bug that started
  // this file: a download route the reviewer looks at, and a second path that
  // files or emails the copy the customer actually gets. Both must fit, or the
  // two disagree and only the customer sees it.
  ["transmittal — download", "app/api/commercial/opportunities/[id]/submittals/[sid]/pdf/route.ts", "renderLetterOfTransmittalPdf"],
  ["transmittal — auto-file", "app/commercial/accounts/[id]/submittals/[dealId]/[sid]/page.tsx", "renderLetterOfTransmittalPdf"],
  ["closeout transmittal — download", "app/api/commercial/closeout/[id]/transmittal/route.ts", "renderCloseoutTransmittalPdf"],
  ["closeout transmittal — auto-file", "app/commercial/accounts/[id]/closeout/[dealId]/closeout-tool.tsx", "renderCloseoutTransmittalPdf"],
  ["warranty — download", "app/api/commercial/closeout/[id]/warranty/route.ts", "renderWarrantyLetterPdf"],
  ["warranty — auto-file", "app/commercial/accounts/[id]/closeout/[dealId]/closeout-tool.tsx", "renderWarrantyLetterPdf"],
];

describe("every customer-facing PDF goes through the fit", () => {
  for (const [label, file, renderer] of SITES) {
    const src = readFileSync(file, "utf8");

    it(`${label} still renders that PDF (guards the check below)`, () => {
      // If the render moves out of this file, the assertion under it would pass
      // on a file that no longer does the thing.
      expect(src).toContain(renderer);
    });

    it(`${label} fits it to one page`, () => {
      expect(
        /renderFitToOnePage\s*\(/.test(src),
        `${file} renders ${renderer} without renderFitToOnePage — that copy will run to two pages while the others fit, which is exactly what sent a two-page attachment to a GC while Preview showed one.`
      ).toBe(true);
    });

    it(`${label} passes the scale INTO the render`, () => {
      // Calling the wrapper but ignoring its argument silently renders the same
      // page N times and returns the natural length — a check that passes while
      // the bug survives.
      expect(src).toMatch(/pageHeightScale/);
    });
  }
});

describe("the Compact checkbox tells the truth", () => {
  const src = readFileSync(
    "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8"
  );

  it("no longer claims it is what pulls a proposal onto one page", () => {
    // Brendan's "it does not add numbers to the pages like it's says it should"
    // came from this copy. Fitting is automatic now; Compact only changes the
    // starting density. Page numbers DO print on a document too long to fit —
    // verified by byte delta: 113 bytes of numbering appear on a 3-page render
    // and vanish when the render function is disabled.
    expect(src).not.toContain("to pull a slightly-long proposal back onto one page");
    expect(src).toContain("fitted onto one page automatically");
  });
});

/**
 * And it holds when the proposal is LONG.
 *
 * Karan 2026-09-03: "make sure if we add a lot of stuff on like the proposals
 * and stuff it still doesnt and never goes above one page."
 *
 * The tests above check every render site calls the fit. They say nothing about
 * whether the fit SUCCEEDS, and it used to stop trying at 1.7× — measured, that
 * is about thirty line items, which a real proposal reaches. Past it the
 * function returned the natural length and the GC got two pages: all three call
 * sites correct, all three source greps green, two-page PDF.
 *
 * So this one renders the artifact and counts its pages, at sizes past where
 * the old ladder gave up.
 */
describe("a long proposal is still one page", () => {
  const line = (i: number) =>
    ({
      id: `l${i}`, proposal_id: "p1",
      product_name: `Line item ${i} — interior repaint, level 4 finish`,
      description: "Prep, prime and paint two coats; cut and roll; drop cloths throughout; daily clean-up.",
      quantity: 1, unit: "each", unit_price_cents: 5_000_00,
      is_alternate: false, is_labor: false, position: i, phase: null,
      show_price: false, line_total_override_cents: null, customer_approved: null,
      created_at: "", updated_at: "",
    }) as never;

  const proposal = () =>
    ({
      id: "p1", opportunity_id: "o1", revision_number: 1, status: "draft",
      header_json: {
        gc_company: "Alta Construction", project_name: "115 Connetquot Ave",
        date_iso: "2026-09-03", show_capital_improvement_notice: false,
      },
      intro_text_override: null, bid_set_date: null, alternate_notes: null,
      bid_notes: null, exclusion_ids: [], custom_exclusions: [],
      pdf_show_line_prices: false, pdf_compact: false,
      estimator_snapshot_json: { name: "Brendan Dwyer", title: "Lead Estimator", phone: "631-555-0100", email: "brendan@tomcopainting.com" },
      total_cents: 200_000_00, created_at: "", updated_at: "", deleted_at: null,
    }) as never;

  // 30 is where the old ladder's last rung landed; 40 and 60 are past it.
  for (const count of [30, 40, 60]) {
    it(`${count} line items still come out on ONE page`, async () => {
      const { renderProposalPdf } = await import("@/lib/commercial/proposals/pdf");
      const { renderFitToOnePage, pdfPageCount } = await import("@/lib/commercial/proposals/fit-one-page");

      const lineItems = Array.from({ length: count }, (_, i) => line(i));
      const { bytes, fitted } = await renderFitToOnePage((pageHeightScale) =>
        renderProposalPdf({
          proposal: proposal(), lineItems,
          exclusions: ["Drywall repair", "Scaffolding over 12'", "Wall covering removal"],
          mode: "customer", pageHeightScale,
        } as never)
      );

      // Count the real pages — parsed, not regexed. A `/Count` regex reads 0
      // off pdf-lib's own output, which is what fit-to-one-page returns.
      expect(await pdfPageCount(bytes)).toBe(1);
      expect(fitted, "the ladder ran out and fell back to natural length").toBe(true);
    }, 60_000);
  }
});
