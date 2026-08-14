/**
 * Extract just the CUSTOMER's own free-text from a WorkOrderLineItem's raw
 * ColorNotes__c, dropping the machine-generated preamble the color form writes
 * back: orphan-surface color descriptions (Kate #27) and the
 * `Customer selected "Don't paint this surface" on …` lines (Kate #09), plus
 * the single `Customer notes:` wrapper label (Kate #11).
 *
 * Used to pre-fill the notes textarea on a RE-SENT form so the customer edits
 * only what they actually typed — never machine text presented back as if it
 * were their own — which also keeps re-submission idempotent: the value that
 * comes back carries no preamble to re-stack. Crew-written notes (no
 * `Customer notes:` wrapper) pass through unchanged so real job context still
 * shows on the form.
 */
export function extractCustomerFreeText(raw: string | null | undefined): string {
  const s = String(raw ?? "")
    // Drop the machine-generated "don't paint" lines — regenerated fresh from
    // the current form state on every submit, so the stored copy must not survive.
    .replace(/Customer selected "Don't paint this surface" on [^\n]*?\.\s*/gi, "");
  // Form-assembled notes always place the human free-text after a single
  // `Customer notes:` label; the orphan-color preamble comes BEFORE it and never
  // contains that label, so the first occurrence is always the wrapper. Keep
  // only what follows it.
  const idx = s.indexOf("Customer notes:");
  if (idx !== -1) return s.slice(idx + "Customer notes:".length).trim();
  // No wrapper. This is either crew-written free-text (show as-is) or an
  // orphan-colour preamble with no customer note attached — which must NOT be
  // handed back to the customer as if they'd typed it. Kate round-3 #31 gave
  // those lines a room header, so strip the header too when everything under
  // it is machine-generated.
  return stripOrphanColorPreamble(s).trim();
}

/** Machine-generated orphan line: "Cabinets: HC-15 Henderson Buff (HC-15) — Semi-Gloss". */
const ORPHAN_LINE_RE =
  /^\s*(?:cabinets?|accent wall|doors?|windows?|closets?|shelves|shelf|other)\s*:\s*\S.*$/i;
/** A bare room header the submit route writes above those lines: "Dining Room:". */
const ROOM_HEADER_RE = /^\s*[^:\n]{1,60}:\s*$/;

function stripOrphanColorPreamble(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ORPHAN_LINE_RE.test(line)) continue;
    // A room header only counts as machine text when the line under it is one
    // of ours — otherwise "Kitchen:" could be a crew note's own heading.
    if (ROOM_HEADER_RE.test(line)) {
      const next = lines[i + 1] ?? "";
      if (ORPHAN_LINE_RE.test(next)) continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}
