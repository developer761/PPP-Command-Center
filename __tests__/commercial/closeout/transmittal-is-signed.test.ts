import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderCloseoutTransmittalPdf, type CompanyContact } from "@/lib/commercial/closeout/pdf";

/**
 * The close-out transmittal carries a signature.
 *
 * It did not, for a month, while a comment in the submittal transmittal
 * asserted in writing that it did — "the close-out transmittal, the warranty,
 * the work order and the change order all had it". Three of those four. Anyone
 * reading the code to answer "is the closeout signed?" — including me — would
 * have said yes.
 *
 * A transmittal is the sheet a GC's close-out clerk files and comes back to.
 * Unsigned, it is a list.
 *
 * Asserted on the RENDERED BYTES, not the props: the parameter did not even
 * exist on the renderer before, so a test that only checked it was passed
 * would have gone green against a document that dropped it on the floor. A
 * JPEG signature embeds as a DCTDecode stream, and no other image on this
 * page is a JPEG.
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

const pkg = {
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
} as Parameters<typeof renderCloseoutTransmittalPdf>[0]["pkg"];

const items = [
  { kind: "warranty", included: true, item_status: "received", note: null },
  { kind: "lien_waiver", included: true, item_status: "pending", note: null },
] as Parameters<typeof renderCloseoutTransmittalPdf>[0]["items"];

const base = { pkg, items, dealName: "Nordstrom Rack — Holbrook", accountName: "Acme", company };
const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

describe("the close-out transmittal", () => {
  it("embeds the signature it is given", async () => {
    const signature = readFileSync("public/brand/tomco-logo.jpg"); // any real JPEG
    const buf = await renderCloseoutTransmittalPdf({ ...base, signature });
    expect(isPdf(buf)).toBe(true);
    expect(
      buf.toString("latin1").includes("DCTDecode"),
      "the signature never reached the document",
    ).toBe(true);
  }, 60_000);

  it("renders a blank rule to sign by hand when none is on file", async () => {
    // Never worse than no block at all — the same fallback the warranty uses.
    const buf = await renderCloseoutTransmittalPdf({ ...base, signature: null });
    expect(isPdf(buf)).toBe(true);
    expect(buf.toString("latin1").includes("DCTDecode")).toBe(false);
  }, 60_000);

  it("still renders when the caller passes no signature at all", async () => {
    // An un-updated caller must not break the close-out package.
    const buf = await renderCloseoutTransmittalPdf(base);
    expect(isPdf(buf)).toBe(true);
  }, 60_000);
});
