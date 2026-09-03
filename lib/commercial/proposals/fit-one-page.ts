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
 * How much taller to try, in order.
 *
 * Karan 2026-09-03: "make sure if we add a lot of stuff on like the proposals
 * and stuff it still doesnt and never goes above one page."
 *
 * The ladder used to stop at 1.7× on a legibility argument — that one page
 * nobody can read is worse than two. That reasoning was mine, not his, and it
 * meant a long proposal silently became a two-page document, which is the thing
 * he has now asked twice not to happen. It also had a measurable cost: 30 line
 * items already needed 1.7×, so the give-up point sat inside the range a real
 * proposal can reach.
 *
 * Measured, so the steps mean something:
 *   12 lines → 1.18×   20 → 1.36×   30 → 1.7×   40 → 2.0×   60 → 2.8×
 *
 * Fine steps low down, where nearly every proposal lands and a smaller step
 * means less shrink than necessary; coarse steps high up, where the document is
 * already unusual and each extra render costs another ~200ms. Stops at 4×,
 * which absorbs roughly eighty line items — past any proposal Tomco writes,
 * and especially so now that the schedule of values is one contract line rather
 * than an itemised list.
 */
const LADDER = [1, 1.18, 1.36, 1.55, 1.7, 1.9, 2.15, 2.45, 2.8, 3.2, 3.6, 4.0] as const;

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

  // Nothing on the ladder fit. Hand back the LAST attempt — the most compressed
  // one — rather than the natural-length render.
  //
  // It is the closest thing to one page that exists, and the alternative is
  // handing a GC the two-page document this whole function is here to prevent.
  // A proposal that reaches here is extraordinary (roughly eighty line items),
  // so it is worth a loud log rather than a silent fallback: something upstream
  // is probably wrong with the data.
  console.warn(
    `[fit-one-page] could not reach one page even at ${LADDER[LADDER.length - 1]}× — sending the most compressed render. Check the line-item count.`
  );
  return { bytes: last!, scale: LADDER[LADDER.length - 1], fitted: false };
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
