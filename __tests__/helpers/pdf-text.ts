import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

/**
 * The text of each page of a react-pdf document, for asserting on what PRINTS.
 *
 * react-pdf compresses its content streams, so `toContain` on the raw bytes
 * proves nothing either way. This inflates each page's stream and decodes the
 * hex glyph runs react-pdf writes for the standard 14 fonts (Times, Helvetica,
 * Courier — every customer document here), whose codes are WinAnsi bytes.
 * A document with an EMBEDDED font would come back as glyph ids, i.e. junk —
 * which is why callers assert that a known phrase IS found before asserting
 * that another is not.
 *
 * Same decoding as guide-sections-dont-start-at-a-page-foot.test.ts.
 */
export async function pdfPageTexts(bytes: Uint8Array | Buffer): Promise<string[]> {
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  return doc.getPages().map((page) => {
    const contents = (page as unknown as { node: { Contents: () => unknown } }).node.Contents() as {
      contents?: Uint8Array;
      asUint8Array?: () => Uint8Array;
    };
    const raw = Buffer.from((contents.contents ?? contents.asUint8Array?.()) as Uint8Array);
    let s: string;
    try {
      s = inflateSync(raw).toString("latin1");
    } catch {
      s = raw.toString("latin1");
    }
    let out = "";
    const re = /<([0-9A-Fa-f\s]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const hex = m[1].replace(/\s+/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out.replace(/\s+/g, " ").trim();
  });
}

/** Every page's text, joined. */
export async function pdfText(bytes: Uint8Array | Buffer): Promise<string> {
  return (await pdfPageTexts(bytes)).join(" ");
}

/** How many times `needle` occurs in `hay`. */
export function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
