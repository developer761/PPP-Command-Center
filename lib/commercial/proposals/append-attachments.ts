import "server-only";
import { PDFDocument } from "pdf-lib";

/**
 * Append the marked-up plan set to the end of the internal report.
 *
 * Karan 2026-08-26: "I attached the marked-up doc but when I clicked plan
 * report I didn't see it there as a second page document or anything."
 *
 * The first attempt at this listed the filenames on the report and left the
 * files where they were. That is not what was asked for and it is not what is
 * useful: the point of a plan report is to be the one document you hand to
 * whoever is reviewing the bid, and a report that says "there is a marked-up
 * plan set somewhere" still leaves them hunting for it.
 *
 * @react-pdf renders our pages; it cannot absorb a foreign PDF. pdf-lib can, so
 * the report is rendered first and the attachments are spliced on afterwards.
 *
 * Everything here is best-effort by design. A plan set is the largest and least
 * predictable file on the platform — scanned, password-protected, produced by
 * whatever the GC's architect uses — and a report that refuses to open because
 * one attachment is malformed would be a worse failure than the one being
 * fixed. Anything that can't be appended is reported back so the report can say
 * so in words instead of silently omitting it.
 */

/** Above this, appending is skipped. A 300-page plan set behind a 2-page report
 *  is not a document anyone opens, and holding it in memory to build it is how
 *  the route runs out of heap. */
export const MAX_APPEND_BYTES = 25 * 1024 * 1024;

export type AppendSource = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Resolves the file's bytes. Lazy so nothing is fetched for a report that
   *  isn't going to append it. */
  load: () => Promise<Uint8Array | null>;
};

export type AppendOutcome = {
  /** The combined document, or the original bytes when nothing was appended. */
  bytes: Buffer;
  appended: string[];
  /** file name → why it could not be appended, for the report to print. */
  skipped: Array<{ fileName: string; reason: string }>;
};

/** Is this something pdf-lib can splice in? Only PDFs — an xlsx or a photo has
 *  no pages to copy. */
export function isAppendablePdf(mimeType: string, fileName: string): boolean {
  return (
    mimeType === "application/pdf" || fileName.trim().toLowerCase().endsWith(".pdf")
  );
}

export async function appendPdfAttachments(
  base: Buffer,
  sources: AppendSource[]
): Promise<AppendOutcome> {
  const appended: string[] = [];
  const skipped: Array<{ fileName: string; reason: string }> = [];

  const candidates = sources.filter((s) => {
    if (!isAppendablePdf(s.mimeType, s.fileName)) {
      skipped.push({ fileName: s.fileName, reason: "not a PDF — open it from the job's Files tab" });
      return false;
    }
    if (s.sizeBytes > MAX_APPEND_BYTES) {
      skipped.push({ fileName: s.fileName, reason: "too large to attach — open it from the job's Files tab" });
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return { bytes: base, appended, skipped };

  let out: PDFDocument;
  try {
    out = await PDFDocument.load(new Uint8Array(base));
  } catch {
    // Our own render failed to parse, which should be impossible. Hand back the
    // original rather than losing the report over the extras.
    return {
      bytes: base,
      appended,
      skipped: sources.map((s) => ({ fileName: s.fileName, reason: "could not attach" })),
    };
  }

  for (const s of candidates) {
    try {
      const raw = await s.load();
      if (!raw) {
        skipped.push({ fileName: s.fileName, reason: "could not be downloaded" });
        continue;
      }
      // ignoreEncryption: a plan set exported from Bluebeam or Acrobat is very
      // often flagged read-only. That is not a reason to refuse it — we are
      // reading pages, not defeating a password.
      const src = await PDFDocument.load(raw, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
      appended.push(s.fileName);
    } catch {
      skipped.push({ fileName: s.fileName, reason: "couldn't be read — it may be scanned or protected" });
    }
  }

  if (appended.length === 0) return { bytes: base, appended, skipped };

  try {
    return { bytes: Buffer.from(await out.save()), appended, skipped };
  } catch {
    return {
      bytes: base,
      appended: [],
      skipped: [...skipped, ...appended.map((f) => ({ fileName: f, reason: "could not attach" }))],
    };
  }
}
