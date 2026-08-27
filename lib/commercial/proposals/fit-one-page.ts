import "server-only";
import { PDFDocument } from "pdf-lib";

/**
 * Make a generated document fit on a single page.
 *
 * Karan 2026-08-26, the platform rule: "everything is supposed to have one page
 * for the PDF, unless it's internal — then when we add bid notes it can have
 * more." So every customer-facing document — invoice, change order, work order,
 * submittal, statement — goes through this, and only the internal estimator
 * report is allowed to run long (and then only because a plan set is spliced
 * onto the end of it).
 *
 * Karan 2026-08-26: "when I do plan report and have like 5 line items it goes
 * to 2 different pages — it should always be one."
 *
 * Measured first: it spilled at THREE line items, and the existing
 * `pdf_compact` toggle made no difference at all — 2 pages either way. It also
 * wasn't one oversized block. Remove the exclusions, or the qualifications, or
 * the bid notes, or the line descriptions, and the same report fits; keep them
 * all and two line items are enough to push it over. The height is cumulative,
 * so there is nothing to trim that wouldn't be deleting content somebody asked
 * for.
 *
 * So this does what a printer's fit-to-page does. The document is laid out on a
 * TALLER sheet until it flows onto one page, then that page is scaled down onto
 * Letter. Type, spacing and proportion all shrink together, which is why the
 * result still reads as the same document rather than a squashed one — and it
 * needs no changes to the stylesheet, so the customer copy is untouched.
 *
 * There is a floor. Past it the report is one page nobody can read, which is
 * not what was asked for; a second page is better than a first one you have to
 * zoom into. A report that hits the floor is returned at its natural length.
 */

/**
 * How much taller to try, in order. Each step is roughly one extra third of a
 * page of room; the last is a 60% reduction, which is about as small as 10pt
 * body type survives on paper.
 */
const LADDER = [1, 1.18, 1.36, 1.55, 1.7] as const;

/**
 * How many pages does this PDF have?
 *
 * Parsed properly rather than grepped. The first version of this regexed
 * `/Count N` out of the bytes, which reads react-pdf's output correctly and
 * returns ZERO for pdf-lib's — so the moment this function was pointed at its
 * own output it started reporting nonsense, and every measurement built on it
 * was quietly meaningless.
 */
export async function pdfPageCount(buf: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

/**
 * Render at increasing page heights until the document fits on one page, then
 * scale it back to Letter.
 *
 * @param render called with the height multiplier to lay out at.
 */
export async function renderFitToOnePage(
  render: (pageHeightScale: number) => Promise<Buffer>
): Promise<{ bytes: Buffer; scale: number; fitted: boolean }> {
  let last: Buffer | null = null;

  for (const scale of LADDER) {
    const buf = await render(scale);
    last = buf;
    if ((await pdfPageCount(buf)) !== 1) continue;

    if (scale === 1) return { bytes: buf, scale: 1, fitted: true };

    try {
      return { bytes: await scaleOntoLetter(buf, scale), scale, fitted: true };
    } catch (err) {
      // The report matters more than its page count. A failure to re-paginate
      // hands back the tall single page, which still opens and still reads —
      // it is just an unusual sheet size.
      console.warn(
        "[proposal-pdf] fit-to-one-page scaling failed:",
        err instanceof Error ? err.message : err
      );
      return { bytes: buf, scale, fitted: true };
    }
  }

  // Past the floor: a genuinely long report. Give it back at its natural size
  // rather than at a size nobody can read.
  return { bytes: last!, scale: 1, fitted: false };
}

/** Draw a single tall page onto one Letter page, scaled to fit. */
async function scaleOntoLetter(tall: Buffer, scale: number): Promise<Buffer> {
  const out = await PDFDocument.create();
  const [embedded] = await out.embedPdf(new Uint8Array(tall), [0]);
  const LETTER_W = 612;
  const LETTER_H = 792;
  // Width is unchanged by the ladder, so this is 1/scale — but derive it rather
  // than assume, so a future change to the page width can't silently crop.
  const k = Math.min(LETTER_W / embedded.width, LETTER_H / embedded.height);
  const page = out.addPage([LETTER_W, LETTER_H]);
  page.drawPage(embedded, {
    xScale: k,
    yScale: k,
    x: (LETTER_W - embedded.width * k) / 2,
    y: (LETTER_H - embedded.height * k) / 2,
  });
  return Buffer.from(await out.save());
}
