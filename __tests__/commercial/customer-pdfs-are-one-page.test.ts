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
