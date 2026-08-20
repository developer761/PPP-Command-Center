import { describe, it, expect } from "vitest";
import { renderLetterOfTransmittalPdf } from "@/lib/commercial/opportunities/submittal-pdf";

/**
 * The Letter of Transmittal goes to the architect, and it was the ONE document
 * leaving the building without a signature block.
 *
 * Karan replaced Katie's blocked S-Sign integration with tap-to-sign on
 * 2026-07-31 — "wherever a doc needs a signature, Tap to sign autofills the
 * stored signature + date … covers warranty, LoT, contracts". Close-out, the
 * warranty, the work order and the change order all got it. The restructure doc
 * says the rest out loud: "LoT is the one document still missing it."
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function input(over: Record<string, unknown> = {}) {
  return {
    submittal: {
      id: "s1",
      submittal_number: 3,
      status: "sent",
      to_company: "ARCADIS",
      to_attention: "Som Khouvong",
      to_address_lines: ["100 Broadway", "Seattle, WA 98101"],
      re_subject: "Submittals",
      transmitted_as: "for_approval",
      included_kinds: ["submittals"],
      remarks: "Three drawdowns enclosed.",
      sent_at: "2026-08-19T15:00:00Z",
      created_at: "2026-08-18T15:00:00Z",
    },
    items: [
      { position: 1, copies: 3, item_date: "2026-08-18", item_number: "1", description: "Paint Color Drawdowns", finish_code: "P290" },
    ],
    opp: { title: "Nordstrom Rack — Holbrook", ppp_job_number: "00284100" },
    accountName: "ARCADIS",
    fromCompany: "Tomco Painting",
    ...over,
    // The fixture carries only the fields the PDF reads; the row type has a
    // dozen more that the document never touches.
  } as unknown as Parameters<typeof renderLetterOfTransmittalPdf>[0];
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

describe("Letter of Transmittal — tap-to-sign", () => {
  it("renders with the stored signature on file", async () => {
    const out = await renderLetterOfTransmittalPdf(
      input({ signature: PNG, signatureName: "Brendan Dwyer", signatureTitle: "VP" })
    );
    expect(isPdf(out)).toBe(true);
  });

  it("renders a blank rule when no signature is stored", async () => {
    // The paper form is signed by hand — a blank rule is correct, and must not
    // throw for want of an image.
    const out = await renderLetterOfTransmittalPdf(input());
    expect(isPdf(out)).toBe(true);
  });

  it("renders when a signature exists but nobody is named against it", async () => {
    const out = await renderLetterOfTransmittalPdf(input({ signature: PNG }));
    expect(isPdf(out)).toBe(true);
  });

  it("renders with no remarks — the block sits after them either way", async () => {
    const out = await renderLetterOfTransmittalPdf(
      input({ submittal: { ...input().submittal, remarks: null }, signature: PNG } as Record<string, unknown>)
    );
    expect(isPdf(out)).toBe(true);
  });
});
