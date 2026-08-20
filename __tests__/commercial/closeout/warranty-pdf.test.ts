import { describe, it, expect } from "vitest";
import { renderWarrantyLetterPdf, type CompanyContact } from "@/lib/commercial/closeout/pdf";

/**
 * The close-out warranty is Tomco's **Form of Warranty** (Katie's captured
 * `Warranty Letter - Tomco.docx`), not a warranty we word ourselves. A real
 * render proves the component tree is valid; the branches that matter are the
 * ones a GC's close-out clerk would notice — a missing completion date, a
 * signature that hasn't been uploaded, and a term other than twelve months.
 */

const company: CompanyContact = {
  name: "Tomco Painting",
  legal_name: "Tomco Painting",
  address_line1: "77 Windsor Place, Ste. 13",
  city: "Central Islip",
  state: "NY",
  zip: "11722",
  phone: "631.582.2770",
  website: "https://www.tomcopainting.com",
  signature_name: "Brendan Dwyer",
  signature_title: "VP",
};

function pkg(over: Record<string, unknown> = {}) {
  return {
    status: "sent",
    to_company: "Acme Construction",
    to_attention: "Som Khouvong",
    to_address_lines: ["100 Broadway", "Seattle, WA 98101"],
    re_subject: "Nordstrom Rack — Holbrook",
    transmitted_as: null,
    remarks: null,
    substantial_completion_date: "2026-07-31",
    warranty_years: 1,
    sent_at: null,
    created_at: "2026-08-19T12:00:00.000Z",
    ...over,
  } as Parameters<typeof renderWarrantyLetterPdf>[0]["pkg"];
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

describe("renderWarrantyLetterPdf — Tomco Form of Warranty", () => {
  it("renders with a signature on file", async () => {
    const out = await renderWarrantyLetterPdf({
      pkg: pkg(),
      dealName: "Nordstrom Rack — Holbrook",
      company,
      // A 1×1 PNG stands in for the stored tap-to-sign image.
      signature: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      ),
    });
    expect(isPdf(out)).toBe(true);
  });

  it("renders a blank signature rule when nothing is on file", async () => {
    // The paper form is signed by hand; printing an empty rule is correct,
    // and must not throw for want of an image.
    const out = await renderWarrantyLetterPdf({ pkg: pkg(), dealName: "Job", company });
    expect(isPdf(out)).toBe(true);
  });

  it("renders with no completion date — the form prints a blank to fill in", async () => {
    const out = await renderWarrantyLetterPdf({
      pkg: pkg({ substantial_completion_date: null }),
      dealName: "Job",
      company,
    });
    expect(isPdf(out)).toBe(true);
  });

  it("renders a longer term, and a company with no postal block configured", async () => {
    const out = await renderWarrantyLetterPdf({
      pkg: pkg({ warranty_years: 2, re_subject: null }),
      dealName: "Job",
      accountName: "Acme Construction",
      company: { name: "Tomco Painting" },
    });
    expect(isPdf(out)).toBe(true);
  });
});
