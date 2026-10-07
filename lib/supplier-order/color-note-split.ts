import { ALL_FINISH_VALUES } from "@/lib/customer-form/material-types";

/**
 * One color-note offer, taken apart into the three things an order line needs.
 *
 * Kate, 2026-10-06: adding a color from the parsed notes put the WHOLE string
 * on the order — "All rooms · Ceiling: Super White - Flat" became the color
 * name, and the vendor email read:
 *
 *     3 gal — [NOT SET] — All rooms · Ceiling: Super White - Flat
 *
 * next to properly formed lines like:
 *
 *     4 gal — Ultra Spec INT — HC-172 Revere Pewter · Eggshell
 *
 * Her ask: "Can we make this similar to the order what to buy section where
 * the color + finish are separate from the room/area?"
 *
 * So the three parts separate here, once, at the point the item is created:
 *
 *   color   what the vendor is being asked to mix      → the item's label
 *   finish  the sheen                                  → the item's finish box
 *   scope   where it goes, "Ceiling — All rooms"       → SCREEN ONLY
 *
 * Scope never reaches the vendor. That is not an oversight — R4.25 took room
 * and surface off every other line for the same reason ("the vendor doesn't
 * stock by room"), and a custom line that still carried them is exactly the
 * inconsistency Kate is pointing at.
 *
 * Pure: no DOM, no fetch.
 */

export type SplitColorNote = {
  /** The orderable color, alone. Never empty — falls back to the whole line. */
  color: string;
  /** Sheen named in the note, matched against the real finish vocabulary. */
  finish: string | null;
  /** "Ceiling — All rooms". Shown on the order screen, never emailed. */
  scope: string | null;
};

/**
 * Finishes longest-first, so "Semi-Gloss" is tried before "Gloss" and a
 * semi-gloss line is not read as a gloss one with "Semi-" left on the color.
 */
const FINISHES_BY_LENGTH: readonly string[] = [...ALL_FINISH_VALUES].sort(
  (a, b) => b.length - a.length
);

/**
 * Separators a rep puts between a color and its sheen. Hyphen included, which
 * is why this cannot be a plain "split on the last dash": "HC-172 Revere
 * Pewter" and "2108-40 Stardust" both carry one INSIDE the color, and
 * Benjamin Moore codes are full of them. Matching the known sheen at the END
 * is what keeps those intact.
 *
 * PUNCTUATION IS REQUIRED — one or more of the marks above, never a bare
 * space, and never nothing at all. The first version made the mark optional,
 * which peeled a sheen out of the middle of real strings in the production
 * table:
 *
 *     "Behr 56 Semigloss"      → color "Behr 56 Semi"   finish "Gloss"
 *     "Navajo White Softgloss" → color "Navajo White Soft"
 *     "Black Pearl"            → color "Black"          finish "Pearl"
 *     "Blue Velvet"            → color "Blue"           finish "Velvet"
 *
 * "Semigloss" unhyphenated is how PPP's reps actually write it, and Black
 * Pearl and Blue Velvet are real paint colors. Longest-first ordering only
 * ever protected the hyphenated spelling.
 *
 * So the asymmetry is deliberate, and it is the same one the parser upstream
 * uses: a sheen left sitting inside the color name reaches the vendor as
 * readable text and the estimator can move it, which is exactly what happened
 * before any of this existed. A color with its last word amputated is wrong
 * paint. Under-split on purpose.
 */
const SEPARATOR = String.raw`[\s]*[-–—·,|/]+[\s]*`;

/** Trailing punctuation a note picks up — "Super White - Flat." */
function tidy(s: string): string {
  return s.replace(/^[\s·,|/–—-]+/, "").replace(/[\s·,|/–—-]+$/, "").trim();
}

/**
 * Pull a trailing sheen off a color string.
 *
 * Returns the finish and what is left. A finish is only taken when it sits at
 * the END and something survives in front of it — "Flat" on its own is the
 * whole line, not a sheen with an empty color, and the submit route's own
 * "Finish not available…" trailer already arrives as a bare finish word.
 */
export function splitFinish(text: string): { color: string; finish: string | null } {
  const t = tidy(text);
  if (!t) return { color: "", finish: null };

  // A line that is ONLY a finish is the line, not a sheen on an empty color.
  // Checked up front and returned, never continued past: "High-Gloss" matched
  // itself, was rejected for leaving no color, and then fell through to the
  // shorter "Gloss" — which split it into the color "High" and the sheen
  // "Gloss". Caught by its own test before it reached anyone.
  if (ALL_FINISH_VALUES.has(t) || FINISHES_BY_LENGTH.some((f) => f.toLowerCase() === t.toLowerCase())) {
    return { color: t, finish: null };
  }

  for (const finish of FINISHES_BY_LENGTH) {
    const escaped = finish.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^(.*?)${SEPARATOR}${escaped}\\.?$`, "i");
    const m = t.match(re);
    if (!m) continue;
    const color = tidy(m[1]);
    // "Flat" alone leaves nothing to buy — it is the line, not a sheen on it.
    if (!color) continue;
    // Canonical casing, so "flat" and "FLAT" both store as "Flat" and the
    // finish box shows a value the picker recognizes.
    return { color, finish };
  }
  return { color: t, finish: null };
}

/**
 * "Ceiling: Super White - Flat" → surface "Ceiling", rest "Super White - Flat".
 *
 * Only a SHORT leading label counts, and only when something follows it. A
 * colon deep in a sentence, or one with nothing after it, is not a surface —
 * and a color that happens to contain a colon must not lose its front half.
 */
export function splitSurface(line: string): { surface: string | null; rest: string } {
  const m = line.match(/^([A-Za-z][A-Za-z0-9 ,'&/()+-]{0,40}?):\s*(\S.*)$/);
  if (!m) return { surface: null, rest: tidy(line) };
  const surface = tidy(m[1]);
  const rest = tidy(m[2]);
  if (!surface || !rest) return { surface: null, rest: tidy(line) };
  return { surface, rest };
}

/**
 * Take a parsed offer apart for the order line it is about to become.
 *
 * `room` is the heading the line sat under in the note ("All rooms"), which
 * the parser already keeps separate — this only has to stop it being glued
 * back on. Pass the offer's own room; pass null when it had none.
 */
export function splitColorNoteOffer(
  line: string,
  room?: string | null
): SplitColorNote {
  const { surface, rest } = splitSurface(line ?? "");
  const { color, finish } = splitFinish(rest);

  const r = (room ?? "").trim();
  // "Ceiling — All rooms", the same shape the buy rows use ("Walls — Other").
  // Either half alone is still useful; neither means no scope line at all.
  const scope = [surface, r].filter((x) => x && x.length > 0).join(" — ") || null;

  return {
    // A line that is nothing but a surface and a sheen would leave no color.
    // Keep the original text rather than send an empty line to a vendor.
    color: color || tidy(rest) || tidy(line ?? ""),
    finish,
    scope,
  };
}
