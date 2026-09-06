/**
 * CSV parsing for the training import.
 *
 * Written rather than reached for because the input is a Google Sheets export
 * of real customer conversations, and every awkward case in RFC 4180 shows up
 * in that data: a message containing a comma, a message containing a line
 * break, a customer who typed a double quote. `split(",")` mangles all three
 * silently — it does not throw, it just produces wrong rows, and a wrong row
 * here becomes a bad training example nobody can trace back.
 *
 * Also handles what spreadsheets actually emit: a UTF-8 BOM, CRLF endings, and
 * ragged rows.
 *
 * On the BOM specifically — parseCsv() would survive without the strip, because
 * JavaScript's trim() counts U+FEFF as whitespace and every header and cell is
 * trimmed. parseCsvRows() is exported separately and does NOT trim, so a caller
 * using it directly would get "\ufeffDate" as its first field. The strip is for
 * them. (Worth writing down: the first test of this asserted through parseCsv
 * and passed with the strip deleted — it was testing trim(), not this.)
 */

export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
  /** Rows whose column count did not match the header. Kept, not dropped —
   *  a silently discarded row is worse than a visible odd one. */
  ragged: { line: number; got: number; expected: number }[];
};

/** Split CSV text into rows of raw fields. RFC 4180 quoting. */
export function parseCsvRows(text: string): string[][] {
  // A BOM on the first header turns "Date" into "﻿Date" and every header
  // match then fails for no visible reason.
  let s = text.replace(/^﻿/, "");
  // Normalise line endings so an embedded \r does not end up inside a value.
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        // "" inside a quoted field is a literal quote.
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c; // includes newlines — a message can span lines
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }

  // Whatever is left when the text ends. Guard against a trailing newline
  // producing a phantom final row of one empty field.
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Parse into objects keyed by header. */
export function parseCsv(text: string): ParsedCsv {
  const raw = parseCsvRows(text);
  if (raw.length === 0) return { headers: [], rows: [], ragged: [] };

  const headers = raw[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  const ragged: ParsedCsv["ragged"] = [];

  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i];
    if (cells.length !== headers.length) {
      ragged.push({ line: i + 1, got: cells.length, expected: headers.length });
    }
    const obj: Record<string, string> = {};
    headers.forEach((h, j) => { obj[h] = (cells[j] ?? "").trim(); });
    rows.push(obj);
  }
  return { headers, rows, ragged };
}

/**
 * Match a header by meaning rather than exact name.
 *
 * Kate's export will not use our column names, and asking her to rename
 * columns before uploading is the kind of friction that means the upload never
 * happens. Longest match wins so "customer name" beats "name" when both exist.
 */
export function matchHeader(headers: string[], candidates: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = candidates.map(norm);
  let best: { header: string; score: number } | null = null;

  for (const h of headers) {
    const nh = norm(h);
    for (const w of wanted) {
      if (!nh || !w) continue;
      const hit = nh === w ? 1000 : nh.includes(w) || w.includes(nh) ? w.length : 0;
      if (hit > 0 && (!best || hit > best.score)) best = { header: h, score: hit };
    }
  }
  return best?.header ?? null;
}
