import { extractCustomerFreeText, extractMachineColorLines } from "@/lib/customer-form/notes";
import { isMachineNoteHeading } from "@/lib/customer-form/machine-notes";

/**
 * Color Notes, read as a small document instead of a list of lines.
 *
 * Katie, 2026-10-01, after testing a realistic note: "when customers add more
 * than just color information, those notes are added to the fields below, and
 * if they state 'all ceilings' or something similar, that isn't captured" …
 * "rooms aren't mentioned — expand the scope to split up the room notes in
 * general, not just the colors."
 *
 * The note she wrote looks like this, and every part of it matters:
 *
 *     I want different colors for different rooms, so I'm entering it here
 *     instead. Also curious if I could add an accent wall…        ← a REMARK
 *
 *     All rooms:                                                  ← a ROOM
 *     Ceiling: Super White - Flat (eggshell for the bathroom ceiling)
 *                                   ↑ an OFFER with a QUALIFIER
 *     Trim: OC-17 White Dove - Semigloss
 *
 *     Wall color for each room --                                 ← a HEADING
 *     Living Room:                                                ← a ROOM
 *     Walls: HC-172 Revere Pewter - Eggshell                      ← an OFFER
 *
 * The old parser had one bucket. Her sentence about accent walls became a
 * buy-list row with a quantity box next to it; so did "Wall color for each
 * room --"; and "(eggshell for the bathroom ceiling)" was glued to the end of
 * a color so that the one instruction in the note nobody could afford to miss
 * read as part of a product name. Rooms were never read at all, so seven
 * rooms' worth of wall colors all carried the single line item's name.
 *
 * Pure, and deliberately conservative: anything it cannot confidently call a
 * remark stays an offer. Dropping a color the estimator needed to order is a
 * worse failure than showing one line too many, and that asymmetry is why the
 * prose rules below all require the line NOT to look like "Surface: color".
 */

export type ColorNoteOffer = {
  /** The orderable text, qualifier removed. */
  line: string;
  /** Room heading this line sat under in the note, if any. */
  room: string | null;
  /** A trailing parenthetical instruction — "eggshell for the bathroom ceiling". */
  qualifier: string | null;
};

export type ParsedColorNotes = {
  /** Candidates the estimator can add to the order. */
  offers: ColorNoteOffer[];
  /** Everything the customer said that is not a thing to buy. Shown, never
   *  offered — this is where "all ceilings" survives instead of vanishing. */
  remarks: string[];
};

/** "Siding:", "Walls: HC-172 …" — a surface naming its color on the same line. */
const SURFACE_LEAD = /^[A-Za-z][A-Za-z0-9 ,'&/()+-]{0,60}:\s*\S/;

/** The submit route's own cap marker. Never a color. */
const TRUNCATION_MARKER = /^\[…?\s*truncated/i;

/** A section header the rep wrote with a dash: "Wall color for each room --". */
const DASH_HEADING = /[\s][-–—]{1,3}\s*$/;

/** Headings that name a SURFACE rather than a room, so they must not become
 *  the room every following line inherits. */
const SURFACE_WORDS =
  /^(walls?|ceilings?|trim|doors?|windows?|siding|shutters?|soffits?|fascia|railings?|cabinets?|floors?|baseboards?|crown|decks?|fences?|gutters?|columns?|posts?)\b/i;

/**
 * Words that mark a line as somebody talking rather than specifying.
 *
 * First person and modals, because that is how a customer writes an aside —
 * "I want…", "could I add…", "maybe in a plum". A rep specifying a color does
 * not use them.
 */
const PROSE_WORDS =
  /\b(i|i'm|i'd|i've|we|we're|you|my|our|could|would|should|can|curious|wondering|maybe|perhaps|please|thanks|thank|instead|prefer|like to|not sure|unsure|let me|let us)\b/i;

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Two or more sentences, or one that ends in a question. */
function readsAsSentences(line: string): boolean {
  if (/\?\s*$/.test(line)) return true;
  return /[.!?]\s+[A-Z]/.test(line);
}

/**
 * Is this line commentary rather than something to buy?
 *
 * Never true for a "Surface: color" line, whatever else it contains — that
 * guard is what stops a chatty but real instruction ("Trim: OC-17 White Dove,
 * please use the leftover") from being filed away as a remark and silently
 * dropped from the order.
 */
export function isRemark(line: string): boolean {
  if (SURFACE_LEAD.test(line)) return false;
  if (readsAsSentences(line)) return true;
  return PROSE_WORDS.test(line) && words(line) >= 5;
}

/** Pull a trailing "(…)" instruction off a line, when it is a phrase rather
 *  than a code. "(eggshell for the bathroom ceiling)" yes; "(HC-6)" no. */
export function splitQualifier(line: string): { line: string; qualifier: string | null } {
  const m = /^(.*\S)\s*\(([^()]{3,120})\)\s*$/.exec(line);
  if (!m) return { line, qualifier: null };
  const inner = m[2].trim();
  // A single token is part of the color: "(HC-6)".
  if (words(inner) < 2) return { line, qualifier: null };
  // So is a quantity — "(2 gal)" tells the estimator how much, not where, and
  // belongs on the line it qualifies. Named explicitly rather than handled by
  // a word count, because the shortest instruction Katie actually cited is
  // "all ceilings", which is also two words.
  if (/^\d+(\.\d+)?\s*(gal|gallons?|qt|quarts?|cans?|pails?|coats?|ea)\b/i.test(inner)) {
    return { line, qualifier: null };
  }
  return { line: m[1].trim(), qualifier: inner };
}

/** Split "Siding: HC-6. Trim: OC-95." into one entry per named surface. */
function splitRun(line: string): string[] {
  const parts: string[] = [];
  let rest = line;
  const BREAK = /\.\s+(?=[A-Za-z][A-Za-z0-9 ,'&/()+-]{0,60}:\s*\S)/;
  for (;;) {
    const m = BREAK.exec(rest);
    if (!m) break;
    parts.push(rest.slice(0, m.index).trim());
    rest = rest.slice(m.index + m[0].length);
  }
  parts.push(rest.trim());
  return parts.filter(Boolean).map((p) => p.replace(/\.$/, "").trim());
}

export function parseColorNotes(raw: string | null | undefined): ParsedColorNotes {
  const machine = extractMachineColorLines(raw);
  const rawHuman = extractCustomerFreeText(raw).replace(/\r\n?/g, "\n").split("\n");

  const offers: ColorNoteOffer[] = [];
  const remarks: string[] = [];
  // Machine-written lines are the form's own output and already carry their
  // room through the line item they were written on.
  for (const m of machine) offers.push({ line: m, room: null, qualifier: null });

  let room: string | null = null;
  let inFinishTrailer = false;
  for (const original of rawHuman) {
    const indented = /^\s{2,}\S/.test(original);
    const line = original
      .replace(/^\s*(?:[-–—•*]|\d+[.)])\s+/, "")
      .trim();
    if (!line) { inFinishTrailer = false; continue; }
    if (isMachineNoteHeading(line)) { inFinishTrailer = true; continue; }
    if (inFinishTrailer && indented) continue;
    inFinishTrailer = false;
    if (TRUNCATION_MARKER.test(line)) continue;
    if (!/[A-Za-z0-9]/.test(line)) continue;

    // "Living Room:" / "All rooms:" — a bare heading. It names the room the
    // lines beneath it belong to, unless it names a surface instead.
    if (/:\s*$/.test(line)) {
      const label = line.replace(/:\s*$/, "").trim();
      room = SURFACE_WORDS.test(label) ? room : label;
      continue;
    }
    // "Wall color for each room --" — a section header. It introduces what
    // follows without naming a room, and the room headings come after it.
    if (DASH_HEADING.test(line)) {
      room = null;
      continue;
    }
    if (isRemark(line)) {
      remarks.push(line);
      continue;
    }
    const pieces = SURFACE_LEAD.test(line) ? splitRun(line) : [line];
    for (const piece of pieces) {
      const { line: clean, qualifier } = splitQualifier(piece);
      offers.push({ line: clean, room, qualifier });
    }
  }

  // Same text under the same room is one offer. The room is part of the key
  // because "Walls: OC-117 Simply White" in the Kitchen and in a Bedroom are
  // two cans, which is the whole reason rooms are read at all.
  const seen = new Set<string>();
  const deduped: ColorNoteOffer[] = [];
  for (const o of offers) {
    const k = `${(o.room ?? "").toLowerCase()}|${o.line.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (k === "|" || seen.has(k)) continue;
    seen.add(k);
    deduped.push(o);
  }

  const seenRemark = new Set<string>();
  const dedupedRemarks = remarks.filter((r) => {
    const k = r.replace(/\s+/g, " ").trim().toLowerCase();
    if (!k || seenRemark.has(k)) return false;
    seenRemark.add(k);
    return true;
  });

  return { offers: deduped, remarks: dedupedRemarks };
}
