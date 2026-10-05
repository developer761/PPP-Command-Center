import { describe, it, expect } from "vitest";
import {
  splitScopeBlocks,
  scopeBlockTaxCents,
  scopeBlockLines,
  shouldPrintGrandTotal,
} from "@/lib/commercial/proposals/scope-blocks";
import type { CommercialProposalLineItem } from "@/lib/commercial/proposals/db";

/**
 * The two proposals Stephanie sent on 2026-10-05, as tests.
 *
 * INSPECTION ROOM is three separately-priced blocks on one page, each with its
 * own Price / NYS Sales Tax / TOTAL and NO grand total underneath:
 *   Inspection Room      $3,600.00 + $315.00  = $3,915.00
 *   Exterior Doors       $1,500.00 + $131.25  = $1,631.25
 *   100 13th Ave          $275.00  +  $24.06  =   $299.06
 *
 * GLENWOOD is one scope and one total, which is what a proposal without blocks
 * has always printed.
 *
 * Both rates are 8.75% (8750 thousandths) — read back off her own figures:
 * 315.00 / 3600.00 and 131.25 / 1500.00 both give exactly that.
 */
const row = (over: Partial<CommercialProposalLineItem>): CommercialProposalLineItem =>
  ({
    id: "l1", proposal_id: "p1", product_id: null, product_name: null,
    description: "", quantity: 1, unit: "each", unit_price_cents: 0,
    is_alternate: false, is_labor: false, position: 0, phase: null,
    show_price: true, line_total_override_cents: null, customer_approved: null,
    created_at: "", updated_at: "",
    ...over,
  }) as unknown as CommercialProposalLineItem;

const block = (id: string, title: string, cents: number, over = {}) =>
  row({ id, block_title: title, unit_price_cents: cents, is_scope_block: true, ...over });

describe("which rows are scope blocks", () => {
  it("separates them from the inclusions so neither prints twice", () => {
    const items = [
      row({ id: "a", description: "GWB Wall: 2 coats" }),
      block("b", "Inspection Room:", 360000),
    ];
    const { scopeBlocks, inclusions } = splitScopeBlocks(items, "customer");
    expect(scopeBlocks.map((i) => i.id)).toEqual(["b"]);
    expect(inclusions.map((i) => i.id)).toEqual(["a"]);
  });

  it("keeps an internal block off the customer copy but on the internal one", () => {
    const items = [block("b", "Lift", 100000, { is_internal: true })];
    expect(splitScopeBlocks(items, "customer").scopeBlocks).toHaveLength(0);
    expect(splitScopeBlocks(items, "internal").scopeBlocks).toHaveLength(1);
  });

  it("leaves alternates and labor alone even if the flag is set", () => {
    const items = [
      block("alt", "Alt", 100, { is_alternate: true }),
      block("lab", "Labor", 100, { is_labor: true }),
    ];
    const { scopeBlocks, inclusions } = splitScopeBlocks(items, "customer");
    expect(scopeBlocks).toHaveLength(0);
    expect(inclusions).toHaveLength(0); // they belong to their own sections
  });

  it("reads correctly before the migration is applied", () => {
    // Every row arrives without the column; nothing may become a block by
    // accident, or an existing proposal silently changes shape.
    const items = [row({ id: "a" }), row({ id: "b" })];
    const { scopeBlocks, inclusions } = splitScopeBlocks(items, "customer");
    expect(scopeBlocks).toHaveLength(0);
    expect(inclusions).toHaveLength(2);
  });
});

describe("the tax on a block", () => {
  it("reproduces her Inspection Room figures to the cent", () => {
    expect(scopeBlockTaxCents(360000, 8750)).toBe(31500); // $315.00
    expect(scopeBlockTaxCents(150000, 8750)).toBe(13125); // $131.25
    expect(scopeBlockTaxCents(27500, 8750)).toBe(2406); //  $24.06
  });

  it("prints no tax line at all on an exempt job", () => {
    // Null is not zero — "NYS Sales Tax: $0.00" invites the question of why it
    // is listed.
    expect(scopeBlockTaxCents(360000, null)).toBeNull();
  });
});

describe("the body text", () => {
  it("bullets the lines she typed and drops the blank ones", () => {
    expect(scopeBlockLines("Walls: Prep and paint with 2 coats\n\nFRP: Remove existing")).toEqual([
      "● Walls: Prep and paint with 2 coats",
      "● FRP: Remove existing",
    ]);
  });

  it("does not double-bullet a line she already bulleted", () => {
    expect(scopeBlockLines("● Power wash PVC fence")).toEqual(["● Power wash PVC fence"]);
    expect(scopeBlockLines("- Power wash")).toEqual(["● Power wash"]);
  });

  it("survives the \\r\\n she pastes out of Word", () => {
    expect(scopeBlockLines("One\r\nTwo")).toEqual(["● One", "● Two"]);
  });
});

describe("whether the page still owes a grand total", () => {
  const blocks = [block("1", "Inspection Room:", 360000), block("2", "Exterior Doors:", 150000)];
  const sum = 510000;

  it("omits it when the blocks ARE the proposal — her Inspection Room sample", () => {
    expect(
      shouldPrintGrandTotal({
        mode: "customer", scopeBlocks: blocks, scopeBlockSumCents: sum,
        totalCents: sum, overrideActive: false,
      }),
    ).toBe(false);
  });

  it("prints it when there is priced work outside the blocks", () => {
    expect(
      shouldPrintGrandTotal({
        mode: "customer", scopeBlocks: blocks, scopeBlockSumCents: sum,
        totalCents: sum + 120000, overrideActive: false,
      }),
    ).toBe(true);
  });

  it("prints it on a proposal with no blocks — her Glenwood sample", () => {
    expect(
      shouldPrintGrandTotal({
        mode: "customer", scopeBlocks: [], scopeBlockSumCents: 0,
        totalCents: 10547000, overrideActive: false,
      }),
    ).toBe(true);
  });

  it("prints it when a final price was set by hand", () => {
    // That figure is one no block explains, so it has to appear.
    expect(
      shouldPrintGrandTotal({
        mode: "customer", scopeBlocks: blocks, scopeBlockSumCents: sum,
        totalCents: sum, overrideActive: true,
      }),
    ).toBe(true);
  });

  it("always prints it on the internal copy", () => {
    expect(
      shouldPrintGrandTotal({
        mode: "internal", scopeBlocks: blocks, scopeBlockSumCents: sum,
        totalCents: sum, overrideActive: false,
      }),
    ).toBe(true);
  });

  it("is not resurrected by a cent of rounding", () => {
    expect(
      shouldPrintGrandTotal({
        mode: "customer", scopeBlocks: blocks, scopeBlockSumCents: sum,
        totalCents: sum + 1, overrideActive: false,
      }),
    ).toBe(false);
  });
});

/**
 * And the document a GC actually receives.
 *
 * The assertions above are on pure functions, which is the only honest way to
 * check the decisions — react-pdf compresses its content streams, so grepping
 * the bytes for "TOTAL" proves nothing. What the bytes CAN show is layout, and
 * layout is where proposal defects have actually landed here before: a
 * sign-off split across a page break that no amount of reading the source
 * would have revealed.
 *
 * Rendered through `renderFitToOnePage`, because that is what all three real
 * paths do. `renderProposalPdf` on its own runs to natural length — asserting
 * one page on THAT is asserting a path nobody gets, and my first version of
 * this test did exactly that and failed for it.
 */
import { renderProposalPdf } from "@/lib/commercial/proposals/pdf";
import { renderFitToOnePage, pdfPageCount } from "@/lib/commercial/proposals/fit-one-page";
import type { CommercialProposal } from "@/lib/commercial/proposals/db";

const HER_BLOCKS = [
  block("1", "Inspection Room:", 360000, {
    description:
      "Walls: Prep and paint with 2 coats\nHM Doors & Frames: Prep and paint (3) units with 2 coats\nFRP: Remove existing FRP in the corner. Repair, patch, or replace sheetrock as needed. Prime and paint with 2 coats",
  }),
  block("2", "Exterior Doors:", 150000, {
    description:
      "Existing HM Doors: Prep and paint the face of (3) units with 2 coats\nNew HM Doors: Prep and paint the face of (9) new units with 2 coats\nSteel Lintels: Prep, prime, silicone, and paint",
  }),
  block("3", "100 13th Ave, Ronkonkoma:", 27500, {
    description: "Exterior HM Door: Prep and paint both sides of (1) unit with 2 coats, platform included.",
  }),
];

const HER_PROPOSAL = {
  id: "p1", opportunity_id: "o1", revision_number: 1, status: "draft",
  header_json: {
    gc_company: "Thermo Fisher Scientific",
    project_name: "Inspection Room & Exterior Door Painting",
    date_iso: "2026-10-05",
    show_capital_improvement_notice: false,
  },
  intro_text_override: null, bid_set_date: null, alternate_notes: null,
  bid_notes: null, exclusion_ids: [], custom_exclusions: [],
  pdf_show_line_prices: false, pdf_compact: false,
  estimator_snapshot_json: {
    name: "Brendan Dwyer", title: "Lead Estimator",
    phone: "631-300-8984", email: "Brendan@Tomcopainting.com",
  },
  total_cents: 537500, final_price_override_cents: null,
} as unknown as CommercialProposal;

const COMPANY = { name: "Tomco Painting", phone: "631-582-2770", email: "info@tomcopainting.com" } as never;

describe("her Inspection Room proposal, rendered", () => {
  it("comes out on ONE page with three priced blocks", async () => {
    const { bytes, fitted } = await renderFitToOnePage((pageHeightScale) =>
      renderProposalPdf({
        proposal: HER_PROPOSAL,
        lineItems: HER_BLOCKS,
        exclusions: ["Work to be completed during normal business hours"],
        qualifications: [],
        showSignatureBlock: true,
        company: COMPANY,
        mode: "customer",
        pageHeightScale,
        tax: {
          priceCents: 537500, label: "NYS Sales Tax (8.75%)",
          taxCents: 47031, totalCents: 584531,
          jurisdictionName: "Suffolk", rateThou: 8750,
        },
      } as never)
    );
    expect(await pdfPageCount(bytes)).toBe(1);
    expect(fitted, "the ladder ran out and fell back to natural length").toBe(true);
  }, 60_000);

  it("still comes out on one page on a tax-exempt job, where no tax line prints", async () => {
    const { bytes, fitted } = await renderFitToOnePage((pageHeightScale) =>
      renderProposalPdf({
        proposal: HER_PROPOSAL, lineItems: HER_BLOCKS,
        exclusions: [], qualifications: [], showSignatureBlock: true,
        company: COMPANY, mode: "customer", pageHeightScale, tax: null,
      } as never)
    );
    expect(await pdfPageCount(bytes)).toBe(1);
    expect(fitted).toBe(true);
  }, 60_000);
});
