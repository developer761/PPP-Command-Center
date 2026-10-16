import { describe, it, expect } from "vitest";

/**
 * The documents a GC receives come out on ONE page — measured, not asserted.
 *
 * Karan's rule, 2026-09-03: "make sure if we add a lot of stuff on like the
 * proposals and stuff it still doesnt and never goes above one page." The
 * internal estimating report is the stated exception — bid notes make it long
 * on purpose — so it is not here.
 *
 * `every-proposal-pdf-path-fits` checks each render SITE calls the fit. That is
 * a source grep, and it cannot see two things this file can:
 *
 *  1. whether the fit actually SUCCEEDS. The ladder used to stop at 1.7×, and
 *     past it the function returned natural length. Every call site correct,
 *     grep green, two-page PDF.
 *  2. a file holding two renderers — closeout-tool.tsx renders both the
 *     transmittal and the warranty, so one `renderFitToOnePage` in it satisfies
 *     the grep for both rows even if only one is wrapped.
 *
 * So this one renders the bytes and counts the pages.
 *
 * How the Letter of Transmittal was found: unfitted, it was TWO pages at FIVE
 * items and FOUR at forty — it had never gone through the fit at all, on either
 * of its two paths. Forty items needs 3.2×, so the old ladder could not have
 * rescued it either.
 */

const PKG = { id: "p", opportunity_id: "o1", status: "draft", created_at: "", updated_at: "" };
const COMPANY = {
  name: "Tomco Painting", phone: "631-555-0100", website: "tomcopainting.com",
  signature_name: "Brendan Dwyer", signature_title: "Project Manager",
  legal_name: "Tomco Painting Inc.", address_line1: "1 Main St",
  address_line2: null, city: "Islip", state: "NY", zip: "11751",
};

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    position: i, copies: 2, item_date: "2026-09-03", item_number: `SD-${i + 1}`,
    description: `Product data sheet ${i + 1} — Benjamin Moore Ultra Spec 500 eggshell`,
    finish_code: "EG",
  }));

/** A page a printer will accept: US Letter, 612 × 792pt, either orientation. */
function expectLetter(page: { getWidth(): number; getHeight(): number }) {
  const w = Math.round(page.getWidth());
  const h = Math.round(page.getHeight());
  const letter = (w === 612 && h === 792) || (w === 792 && h === 612);
  expect(letter, `page is ${w}×${h}pt, not Letter — the fit left it on the tall layout sheet`).toBe(true);
}

async function onePage(bytes: Buffer, label: string) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  expect(doc.getPageCount(), `${label} runs to more than one page`).toBe(1);
  expectLetter(doc.getPage(0));
}

describe("Letter of Transmittal", () => {
  // 5 is an ordinary submittal and was already spilling; 40 is the stress case.
  for (const n of [1, 5, 20, 40]) {
    it(`${n} item(s) → one Letter page`, async () => {
      const { renderLetterOfTransmittalPdf } = await import("@/lib/commercial/opportunities/submittal-pdf");
      const { renderFitToOnePage } = await import("@/lib/commercial/proposals/fit-one-page");
      const { bytes, fitted } = await renderFitToOnePage((pageHeightScale) =>
        renderLetterOfTransmittalPdf({
          submittal: { id: "s1", opportunity_id: "o1", submittal_number: 1, revision_number: 0, title: "Paint submittal", spec_section: "09 91 00", status: "draft", sent_at: null, created_at: "", updated_at: "" },
          items: items(n),
          opp: { title: "115 Connetquot Ave", ppp_job_number: "2601", client_name: "JD Sports", property_street: "115 Connetquot Ave" },
          accountName: "Alta Construction", fromCompany: "Tomco Painting",
          logo: null, signature: null, signatureName: "Brendan Dwyer", signatureTitle: "Project Manager",
          pageHeightScale,
        } as never)
      );
      expect(fitted, "the ladder ran out and fell back to natural length").toBe(true);
      await onePage(bytes, `LoT with ${n} items`);
    }, 90_000);
  }
});

describe("closeout package", () => {
  it("a transmittal with 40 items → one Letter page", async () => {
    const { renderCloseoutTransmittalPdf } = await import("@/lib/commercial/closeout/pdf");
    const { renderFitToOnePage } = await import("@/lib/commercial/proposals/fit-one-page");

    // `included: true` matters — TransmittalDoc renders `items.filter(i =>
    // i.included)`, so a mock without the flag lists NOTHING and the document
    // is one page for the wrong reason. The first version of this test did
    // exactly that and reported a pass while measuring an empty table.
    const { bytes } = await renderFitToOnePage((pageHeightScale) =>
      renderCloseoutTransmittalPdf({
        pkg: PKG,
        items: items(40).map((it) => ({
          kind: "warranty", label: it.description, included: true, item_status: "received",
        })),
        dealName: "115 Connetquot Ave", accountName: "Alta Construction",
        company: COMPANY, logo: null, pageHeightScale,
      } as never)
    );
    await onePage(bytes, "closeout transmittal");
  }, 90_000);

  it("the warranty letter → one Letter page", async () => {
    const { renderWarrantyLetterPdf } = await import("@/lib/commercial/closeout/pdf");
    const { renderFitToOnePage } = await import("@/lib/commercial/proposals/fit-one-page");
    const { bytes } = await renderFitToOnePage((pageHeightScale) =>
      renderWarrantyLetterPdf({
        pkg: PKG, dealName: "115 Connetquot Ave", accountName: "Alta Construction",
        company: COMPANY, logo: null, signature: null, pageHeightScale,
      } as never)
    );
    await onePage(bytes, "warranty letter");
  }, 90_000);
});

/**
 * THE CHANGE ORDER — the document that had the proposal's bug all along.
 *
 * `emailChangeOrderToGc` called `renderChangeOrderPdf(built.input)` raw while
 * app/api/commercial/change-orders/[id]/pdf/route.ts wrapped the IDENTICAL
 * input in `renderFitToOnePage`. Both paths already shared one data builder —
 * `buildChangeOrderPdfInput`, extracted in August precisely so the two could
 * not print different numbers — so the seam everybody had closed was the DATA
 * seam, and the LAYOUT one a line below it stayed open.
 *
 * Measured across all 41 live change orders on 2026-10-16: the download route
 * produced one page 41 times; the email produced TWO on five of them — Water
 * Lilies CO-2 $23,050, CO-3 $11,570, CO-4 $42,000; VCA West Islip CO-1 $2,250,
 * CO-2 $20,375. Preview one page, the GC's attachment two.
 *
 * What makes one long: the SCOPE DESCRIPTION. Those five carry 300-470
 * characters over 8-14 lines, because that is how the office writes a
 * multi-item change ("Touch-Ups: … Price: $5,750.00 ⏎ Wallcovering: …").
 *
 * The sizes below bracket that and then some. Measured 2026-10-16, scope lines
 * → unfitted pages / the ladder rung that rescues it:
 *
 *       4 →  2p @ 1.18×    14 →  2p @ 1.55×    40 →  3p @ 2.45×
 *       8 →  2p @ 1.18×    30 →  3p @ 2.15×    80 →  5p @ 4.00×
 *
 * 80 lines (7,483 characters) is the last rung of the ladder, and
 * `createChangeOrder` truncates `description` at 4,000 characters — which
 * lands around 42 lines — so nothing that can be STORED can outrun the fit.
 * That is the headroom these cases are here to keep.
 */
describe("change order", () => {
  const scope = (lines: number) =>
    lines === 0
      ? null
      : Array.from(
          { length: lines },
          (_, i) =>
            `Item ${i + 1}: prep, prime and paint the affected area; patch and skim as needed.\nPrice: $${(1_250 + i * 325).toLocaleString("en-US")}.00`
        ).join("\n");

  const changeOrder = (lines: number) => ({
    coNumber: "CO-002",
    title: "Additional scope — touch-ups, wallcovering and sprinkler room",
    description: scope(lines),
    amountCents: 2_305_000,
    isDeduct: false,
    status: "Pending",
    dateIso: "2026-10-16",
    accountName: "Water Lillies Food., LLC",
    // Two street lines, as 20 live accounts store them.
    billTo: ["1724 5th Avenue", "Unit#3", "Bay Shore, NY 11706"],
    dealName: "Water Lilies-250 Creative Drive",
    priorContractCents: 12_157_500,
    revisedContractCents: 14_462_500,
    company: {
      name: "Tomco Painting", phone: "631-582-2770", website: "https://www.tomcopainting.com",
      signature_name: "Brendan Dwyer", signature_title: "VP",
    },
    logo: null,
    signature: null,
  });

  for (const n of [0, 8, 14, 40, 80]) {
    it(`${n}-line scope → one Letter page`, async () => {
      const { renderChangeOrderPdf } = await import("@/lib/commercial/change-orders/pdf");
      const { renderFitToOnePage } = await import("@/lib/commercial/proposals/fit-one-page");
      const { bytes, fitted } = await renderFitToOnePage((pageHeightScale) =>
        renderChangeOrderPdf({ ...changeOrder(n), pageHeightScale } as never)
      );
      expect(fitted, "the ladder ran out and fell back to the most compressed render").toBe(true);
      await onePage(bytes, `change order with a ${n}-line scope`);
    }, 90_000);
  }

  /**
   * And the control that makes all of the above mean something.
   *
   * Without the fit, the ordinary 8-line scope really is TWO pages — so the
   * assertions above are measuring the wrapper doing work, not a document that
   * was always going to be short enough. Delete the `renderFitToOnePage` call
   * from the send path and this is the attachment the GC receives.
   */
  it("is genuinely two pages WITHOUT the fit — that was the emailed copy", async () => {
    const { renderChangeOrderPdf } = await import("@/lib/commercial/change-orders/pdf");
    const { pdfPageCount } = await import("@/lib/commercial/proposals/fit-one-page");
    const raw = await renderChangeOrderPdf(changeOrder(8) as never);
    expect(
      await pdfPageCount(raw),
      "an 8-line scope now fits unaided — re-measure, the fixture no longer reproduces the bug"
    ).toBeGreaterThan(1);
  }, 90_000);
});
