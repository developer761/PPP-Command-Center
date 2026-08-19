import { ORPHAN_SURFACES } from "@/lib/customer-form/surface-mapping";

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

/**
 * A MACHINE-generated orphan line, e.g.
 *   "Cabinets: HC-15 Henderson Buff (HC-15) — Semi-Gloss"
 *   "Door: Super White (OC-152)"
 *
 * The surface prefix alone is NOT enough to identify one. A rep typing
 * "Cabinets: needs sanding before paint" into Color Notes matches that shape
 * exactly, and stripping it would blank the note from the form — which then
 * rewrites ColorNotes__c without it and destroys the rep's words.
 *
 * So the line must also carry a machine fingerprint: the " — <finish>" suffix
 * the submit route writes, or a parenthesised colour code. Anything else is
 * treated as human text and kept. Erring toward keeping is deliberate: a
 * duplicated machine line in a textarea is cosmetic, an erased crew note is
 * data loss.
 */
// DERIVED from the shared set, never re-typed. A second hand-written list is
// exactly how round-2 #04 came back: add "Railing" to ORPHAN_SURFACES and a
// literal regex here would silently stop recognising it, leaking our own
// machine text back to the customer as if they'd typed it.
const ORPHAN_SURFACE_PREFIX = new RegExp(
  `^\\s*(?:${[...ORPHAN_SURFACES]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|")})\\s*:\\s*\\S`,
  "i"
);
/** " — Semi-Gloss" / " (HC-15)" — written by us, not typed by a person. */
const MACHINE_FINGERPRINT = /\s—\s\S|\([A-Za-z0-9][A-Za-z0-9.\-\/ ]{0,14}\)\s*$/;
const ORPHAN_LINE_RE = {
  test: (line: string) => ORPHAN_SURFACE_PREFIX.test(line) && MACHINE_FINGERPRINT.test(line),
};
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

/**
 * The inverse of {@link extractCustomerFreeText}: the MACHINE-written colour
 * records in a WorkOrderLineItem's ColorNotes__c, without the customer's own
 * words and without the "don't paint" lines.
 *
 * Kate round-3 #16: "Color Notes ... hold the color and finish for orphaned
 * surfaces and for line items with non-Benjamin-Moore / non-Sherwin-Williams
 * colors. Anyone previewing the order is missing part of it."
 *
 * That matters more than a display gap. When a line carries two or more
 * surfaces with no dedicated Salesforce colour field (Cabinets AND Door), the
 * colours go to Color Notes and the shared Other slot is deliberately left
 * blank — so those colours are absent from the order's line items and would
 * never reach the vendor. Pulling them back out here puts them in the order's
 * Color Notes, which does go in the email.
 *
 * The customer's free text and the "don't paint" lines are excluded because the
 * builder already sources those separately; including them would duplicate.
 */
export function extractMachineColorLines(raw: string | null | undefined): string[] {
  const s = String(raw ?? "");
  if (!s.trim()) return [];
  // Everything before the "Customer notes:" wrapper is machine-written.
  const idx = s.indexOf("Customer notes:");
  const machine = idx === -1 ? s : s.slice(0, idx);
  return machine
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // Keep ONLY lines carrying a machine fingerprint. Exact complement of what
    // extractCustomerFreeText strips, so a rep's typed "Cabinets: needs
    // sanding" is treated as human text in both directions — kept on the form,
    // and not pushed into the vendor's order as if it were a colour.
    .filter((l) => ORPHAN_LINE_RE.test(l));
}

/**
 * Parse the machine colour lines back into structured surface → colour records.
 *
 * The submit route writes one line per orphan surface in the 2+ case:
 *
 *     Cabinets: White Dove (OC-17) — Satin
 *
 * and deliberately leaves ColorOther__c blank, because a single Salesforce
 * field can't hold two colours. Every reader that shows orphan surfaces was
 * sourcing them from that blank field, so a room where the customer picked
 * Cabinets AND Wainscoting displayed both as having no colour at all — and the
 * team chased the customer for something they'd already provided.
 *
 * Kept in this file, immediately under the writer's format, because a parser
 * living anywhere else drifts the moment the written shape changes.
 */
export type ParsedOrphanColor = {
  surface: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
};

export function parseMachineColorLines(raw: string | null | undefined): ParsedOrphanColor[] {
  const out: ParsedOrphanColor[] = [];
  for (const line of extractMachineColorLines(raw)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const surface = line.slice(0, sep).trim();
    let rest = line.slice(sep + 1).trim();
    if (!surface || !rest) continue;

    // Finish is the LAST " — " segment. Split from the right: a colour name can
    // legitimately contain an em dash, the finish suffix is always terminal.
    let finish: string | null = null;
    const dash = rest.lastIndexOf(" — ");
    if (dash !== -1) {
      finish = rest.slice(dash + 3).trim() || null;
      rest = rest.slice(0, dash).trim();
    }

    // Trailing "(CODE)" — same shape the fingerprint recognises, so a name with
    // a parenthetical that isn't a code ("White (Custom Mix)") won't be eaten.
    let colorCode: string | null = null;
    const codeMatch = rest.match(/\(([A-Za-z0-9][A-Za-z0-9.\-/ ]{0,14})\)\s*$/);
    if (codeMatch) {
      colorCode = codeMatch[1].trim();
      rest = rest.slice(0, codeMatch.index).trim();
    }

    const colorName = rest.trim();
    if (!colorName) continue;
    out.push({ surface, colorName, colorCode, finish });
  }
  return out;
}
