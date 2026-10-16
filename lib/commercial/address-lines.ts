/**
 * Turn stored address fields into the lines a document prints.
 *
 * 🔴 A STREET FIELD CAN CONTAIN A LINE BREAK, AND IT REACHES THE PAPER.
 *
 * 20 live accounts and 3 opportunities hold a CR or CRLF inside a street
 * field — `"1998 Springdale Road\r\nSuite 101"`, `"70 West 40th Street\r\n10th
 * Floor"` — because that is how they came out of Salesforce. Every builder
 * here used `.trim()`, which strips the ends and leaves an interior `\r`
 * untouched, so the character was drawn into the document as a glyph.
 *
 * Proven by extracting the PDF content stream rather than trusting the data:
 * `"Morris Avenue\r"` rendered twice per invoice, on 8 live invoices (two
 * sent, four paid) and 4 AIA certificates.
 *
 * Why it needs to be one function rather than five:
 *
 *  · The AIA export writes into fixed cells with `wrapText: false`, and a
 *    2-line street yielded FOUR parts against three cells. The overflow branch
 *    merged the middles and produced `"1998 Springdale Road⏎, Suite 101"` — so
 *    splitting the character is only half the job; the stray separator has to
 *    go too.
 *  · `.trim()` looks like it handles whitespace and does not handle this. Five
 *    separate authors reached for it and all five were wrong in the same way.
 *
 * Cleaning this in the platform does NOT stick — the next sync rewrites the
 * row from Salesforce verbatim. So the fix belongs on the way OUT, here, and
 * the underlying data is a separate cleanup in Salesforce itself.
 */

/** Every real line in these fields, in order, with no blanks and no breaks. */
export function addressLines(...parts: Array<string | null | undefined>): string[] {
  return parts
    .flatMap((p) => String(p ?? "").split(/\r\n|\r|\n/))
    // Collapse runs of interior whitespace too: a field pasted from a
    // spreadsheet arrives with tabs and doubled spaces as readily as newlines.
    .map((s) => s.replace(/\s+/g, " ").trim())
    // A line that is only punctuation is what a half-filled field leaves
    // behind — "," or "-" prints as a stray mark under the company name.
    .filter((s) => s.length > 0 && /[A-Za-z0-9]/.test(s));
}

/** "City, ST 12345" from its parts, skipping whatever is missing. */
export function cityStateZipLine(
  city: string | null | undefined,
  state: string | null | undefined,
  zip: string | null | undefined,
): string | null {
  const c = addressLines(city)[0] ?? "";
  const s = addressLines(state)[0] ?? "";
  const z = addressLines(zip)[0] ?? "";
  // The ZIP follows the state with a space, never a comma — "Islip, NY 11751".
  const head = [c, s].filter(Boolean).join(", ");
  const out = [head, z].filter(Boolean).join(" ");
  return out.length > 0 ? out : null;
}
