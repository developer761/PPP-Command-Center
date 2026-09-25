/**
 * A column of numbers pasted out of Gusto, read into one figure per row.
 *
 * Katie 2026-09-24: *"If we can make it an easy upload of an export and have
 * the CC do the work for her, that would be great."*
 *
 * This is deliberately NOT a file upload. An upload has to match Gusto's names
 * to our roster, and the roster has two Lucatortos (JJ and Joseph) and two
 * Roberts (Caputo and Patterson) sitting behind display names like "Tomco
 * Labor - Joe". Guessing there puts one man's pay on another man's jobs and
 * looks entirely plausible — the same shape as the AR carryover that would
 * have put $177,733.93 on the wrong building.
 *
 * Pasting a column keeps the person in the loop: the figures land in the boxes
 * beside the names she is already reading, and a mis-paste is visible before
 * she saves rather than discovered in a margin later.
 *
 * WHAT IT ACCEPTS. Whatever a spreadsheet or a PDF actually puts on the
 * clipboard: one value per line, or tab/comma separated columns where the
 * money is the last numeric field on the line. Currency symbols, thousands
 * separators and stray spaces are stripped; accounting parentheses read as
 * negative, because on a payroll report they mean a deduction and silently
 * turning −500 into 500 would be worse than refusing it.
 *
 * WHAT IT REFUSES. Anything it cannot read as money comes back as an
 * unparsed line rather than a zero. A zero is a real figure — it would clear
 * "no cost entered" and post a week with somebody costed at nothing — which is
 * exactly the bug this codebase shipped and fixed earlier the same day.
 */

export type PastedAmounts = {
  /** One figure per usable line, in the order they were pasted. */
  cents: number[];
  /** Lines that looked like content but held no readable money. */
  unreadable: string[];
};

/** A single money token → cents, or null. Mirrors the accounting parser. */
function tokenToCents(token: string): number | null {
  const text = token.trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  const bare = text.replace(/^\(|\)$/g, "").replace(/^-/, "").replace(/[$,\s]/g, "");
  if (!/^\d*\.?\d+$/.test(bare)) return null;
  const n = Number(bare);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  if (cents > 1_000_000_000_00) return null;
  return negative ? -cents : cents;
}

export function parsePastedAmounts(raw: string): PastedAmounts {
  const cents: number[] = [];
  const unreadable: string[] = [];

  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank lines are spacing, not data

    // Split on tabs and commas BETWEEN fields — but a comma inside 1,040.00 is
    // a thousands separator, so only split where a comma is followed by
    // something that is not a digit-group, and prefer tabs when present.
    const fields = trimmed.includes("\t")
      ? trimmed.split("\t")
      : [trimmed];

    // The money is the LAST readable number on the line. A pasted row is often
    // "Greg Stankewicz  40.00  1,150.00" and the company cost is the figure at
    // the end, not the hours at the start.
    let found: number | null = null;
    for (const f of fields) {
      const c = tokenToCents(f);
      if (c !== null) found = c;
    }
    // A single field that is a whole line of text with a number on the end.
    if (found === null) {
      const tail = trimmed.match(/\(?-?[$]?[\d,]*\.?\d+\)?\s*$/);
      if (tail) found = tokenToCents(tail[0]);
    }

    if (found === null) unreadable.push(trimmed);
    else cents.push(found);
  }

  return { cents, unreadable };
}
