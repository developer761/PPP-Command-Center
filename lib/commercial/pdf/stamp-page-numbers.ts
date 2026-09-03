import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Stamp "N / M" on every page of a finished PDF, if there is more than one.
 *
 * Brendan 2026-09-03 asked for page numbers on the documents that run long.
 * `pdf.tsx` already had them — a react-pdf `fixed render` guarded on
 * `totalPages > 1` — and it could never once have printed a number:
 *
 *   · the internal estimating report goes through `renderFitToOnePage`, so at
 *     react-pdf render time `totalPages` is always 1 and the guard yields "";
 *   · the extra pages appear AFTERWARDS, when `appendPdfAttachments` splices
 *     the plan set on with pdf-lib — and react-pdf is long gone by then.
 *
 * So the feature existed, compiled, read correctly, and was dead. It has to be
 * stamped after the document is assembled, which means pdf-lib rather than
 * react-pdf.
 *
 * Deliberately a no-op on a single-page document: a lone "1 / 1" in the corner
 * of a one-page proposal is noise.
 */
export async function stampPageNumbers(bytes: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  const pages = doc.getPages();
  if (pages.length < 2) return bytes;

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 8;

  pages.forEach((page, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const width = font.widthOfTextAtSize(label, size);
    const { width: pw } = page.getSize();

    // Bottom-right, inside the margin the letterhead footer already reserves.
    // Measured off the react-pdf style it replaces (right: 48, bottom: 42) so
    // the number lands where it would have.
    page.drawText(label, {
      x: pw - 48 - width,
      y: 30,
      size,
      font,
      // Mid-grey: legible on a print, but it must not read as content.
      color: rgb(0.45, 0.45, 0.45),
    });
  });

  return Buffer.from(await doc.save());
}
