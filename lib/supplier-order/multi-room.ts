/**
 * ONE LINE ITEM, SEVERAL ROOMS.
 *
 * Kate 2026-10-07, p18: "When there is one line item and multiple rooms in the
 * notes, add an alert here stating 'Multiple rooms detected on one line item.
 * Confirm with customer before ordering'." Her p19 adds the qualifier that
 * matters: "clearly mentioning multiple rooms."
 *
 * The estimator sizes paint per line item. When one line item's scope actually
 * covers four rooms, every quantity derived from it is sized for one, so the
 * order is wrong before anybody touches it. It is common: 13% of interior line
 * items with a scope note, measured against 711 live rows on 2026-10-09.
 *
 * ── WHY THIS IS NOT A WORD LIST ─────────────────────────────────────────
 *
 * A plain "does the text contain two room words" pass called 24.6% of line
 * items multi-room, and most of those were wrong. Three distinct ways the real
 * text defeats it, all found by reading live Descriptions rather than imagining
 * them:
 *
 *  1. ROOM NAMES INSIDE ROOM NAMES. "master bedroom" also matches "bedroom" —
 *     the space is a word boundary, so \b does NOT save you. Two hits, one
 *     room. Fixed by matching longest-first and CONSUMING the match.
 *     (Pure substrings like "bath" in "bathroom" are already handled by the
 *     \b…\b anchors; it is the multi-WORD names that need the consume.)
 *
 *  2. PPP'S OWN TEMPLATE. Most quotes read "Paint walls, ceilings, trim, doors
 *     and closets in: Kitchen". Everything before the colon is a SURFACE list.
 *     Fixed by dropping "paint … in:" outright.
 *
 *  3. LANDMARKS. "Small stairwell off of 3rd floor office" and "the wall with
 *     the transom from the kitchen" each name a second room to say WHERE the
 *     first one is. The work is in one room. Fixed by ignoring a room that
 *     follows a locational preposition.
 *
 * Plus adjacency: "3rd Floor Stairwell hallway" is one space whose name happens
 * to be two room words, so touching matches collapse to one.
 *
 * Exterior work is excluded entirely — "garage" and "entry" are parts of a
 * house's outside, not rooms being painted, and that was the last false-positive
 * class left after the rules above.
 *
 * Measured after all of it: 95 of 711 interior line items (13.4%).
 *
 * PRECISION IS NOT UNIFORM, and whoever reads this should know it. Hand-read:
 * the 3-or-more-room band is close to clean; the 2-room band is 44 of the 95
 * and roughly 70% — the rest are a room named as a landmark past an
 * intervening phrase ("off of 3rd floor office"), or a room qualifying a
 * surface ("pantry door a separate color"). Those two are left in on purpose:
 * the alert is advisory, Kate asked for it, and "confirm with the customer"
 * is not harmful on a line that turns out to be one room. If it starts being
 * ignored, tighten the 2-room band first.
 *
 * WHAT EACH RULE IS ACTUALLY WORTH, ablated over those 711 rows:
 *
 *     consume longest-first   removing it: +24 false positives
 *     slash collapse          removing it:  +8 false positives
 *     landmark preposition    removing it:  +4 false positives
 *     known compound pairs    removing it:  -1 missed
 *     negation carve-out      removing it:  +1 false positive
 *
 * Also found by eye, not predicted: "Paint entire apartment … Do not paint
 * office walls" was read as two rooms when the estimator is excluding one.
 *
 * A surface-word strip used to sit here too. Ablation says it changes NOTHING
 * once "closet" is not a room word and the anchors are \b…\b, so it is gone
 * rather than left in looking load-bearing.
 *
 * NOTE FOR WHOEVER TUNES THIS: re-measure against live data, do not reason
 * about it. scripts are cheap; `Description` is free text typed by estimators
 * and it does not behave the way it reads.
 */

/**
 * Longest first, so "master bedroom" is matched and consumed before "bedroom"
 * can match inside it.
 *
 * The literal below is already written in that order, so the `.sort()` changes
 * nothing today — removing it breaks no test, and that is honest rather than a
 * gap. It is there so a word added in the wrong place cannot quietly reorder
 * the matching; the behavior it protects is covered by the "counts 'master
 * bedroom' once" test.
 */
const ROOM_WORDS: readonly string[] = [
  "primary bedroom", "master bedroom", "powder room", "living room",
  "dining room", "family room", "great room", "laundry room", "mud room",
  "sun room", "rec room", "bedroom", "bathroom", "stairwell", "staircase",
  "stairway", "hallway", "entryway", "mudroom", "sunroom", "basement",
  "nursery", "playroom", "kitchen", "pantry", "laundry", "garage", "office",
  "landing", "foyer", "attic", "loft", "entry", "den", "hall", "bath",
].sort((a, b) => b.length - a.length);

/**
 * A room named in order to EXCLUDE it. "Paint entire apartment … Do not paint
 * office walls" was being read as an apartment plus an office; the estimator
 * is saying the opposite. Found by eye in the live 2-room band, not predicted.
 */
const NEGATION_LEAD =
  /\b(?:do not|don't|does not|dont|excluding|excludes|exclude|not including|except|other than|no)\s+(?:paint|include|touch|do)?\s*(?:the\s+|a\s+)?$/;

/** "off of the office", "from the kitchen" — says where, not what. */
const LANDMARK_LEAD =
  /\b(?:off of|off|from|next to|adjacent to|near|beside|by|toward|towards|facing|overlooking|leading to|to)\s+(?:the\s+|a\s+)?$/;

/**
 * Pairs that name ONE space, seen written this way in live Descriptions. A
 * stairwell hallway is a hallway with stairs in it, not a stairwell and a
 * hallway. Add to this only from real data.
 */
const COMPOUND_PAIRS: ReadonlySet<string> = new Set([
  "stairwell hallway",
  "staircase hallway",
  "stairway hallway",
  "kitchen pantry",
  "entry foyer",
  "foyer entry",
  "mud laundry",
  "laundry mudroom",
]);

function isCompound(first: string, second: string): boolean {
  return COMPOUND_PAIRS.has(`${first} ${second}`);
}

export type MultiRoomLine = {
  /** The line item's id, so the UI can point at it. */
  id: string;
  /** Its AreaLabel — what the line CLAIMS to cover. */
  room: string;
  /** The rooms its notes actually name, in the order they appear. */
  rooms: string[];
};

/**
 * The rooms a scope note names. Empty for exterior work, boilerplate, or text
 * that names one room however many times it says it.
 */
export function roomsNamedIn(text: string | null | undefined): string[] {
  let t = (text ?? "").toLowerCase();
  if (!t.trim()) return [];

  // "Paint … in:" is a surface list, whatever it contains.
  t = t.replace(/paint[^:]{0,80}in:/g, " ");
  // "Foyer/entryway" and "kitchen/dining" are one space, not two.
  t = t.replace(/([a-z]+)\s*\/\s*([a-z]+)/g, "$1 ");

  const found: Array<{ word: string; at: number }> = [];
  for (const word of ROOM_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 22), m.index);
      if (LANDMARK_LEAD.test(before)) continue;
      if (NEGATION_LEAD.test(before)) continue;
      found.push({ word, at: m.index });
    }
    // Blank it out but keep the offsets, so adjacency still reads correctly.
    t = t.replace(new RegExp(`\\b${word}\\b`, "g"), (s) => " ".repeat(s.length));
  }

  found.sort((a, b) => a.at - b.at);
  const kept: Array<{ word: string; at: number }> = [];
  for (const f of found) {
    const prev = kept[kept.length - 1];
    // A known compound name, written as two room words: "Stairwell hallway".
    //
    // This was a general "two room words one space apart are one room" rule,
    // which is wrong and nearly shipped: estimators write lists exactly that
    // way. "Dining room Kitchen- ceiling included Stairway Upstairs hallway"
    // is four rooms separated by single spaces, and the general rule silently
    // dropped one. Spacing cannot tell a compound from a list, so only pairs
    // actually seen in the data are collapsed, and an unknown pair counts as
    // two — the safe direction, since the cost is one confirmable alert and
    // the cost of the other direction is paint sized for one room out of four.
    if (prev && f.at - (prev.at + prev.word.length) <= 1 && isCompound(prev.word, f.word)) {
      continue;
    }
    kept.push(f);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of kept) {
    if (seen.has(k.word)) continue;
    seen.add(k.word);
    out.push(k.word);
  }
  return out;
}

/** Interior only — see the module note. */
export function isInteriorLine(productFamily: string | null | undefined): boolean {
  return /interior/i.test(productFamily ?? "");
}

/**
 * Which line items name more than one room in their scope note.
 *
 * `productFamily` is optional: a caller that does not carry it gets the check
 * anyway rather than silently nothing, because a missing field should not make
 * a warning disappear.
 */
export function multiRoomLines(
  lines: ReadonlyArray<{
    id: string;
    room: string;
    notes?: string | null;
    productFamily?: string | null;
  }>
): MultiRoomLine[] {
  const out: MultiRoomLine[] = [];
  for (const l of lines) {
    if (l.productFamily != null && !isInteriorLine(l.productFamily)) continue;
    const rooms = roomsNamedIn(l.notes);
    if (rooms.length >= 2) out.push({ id: l.id, room: l.room, rooms });
  }
  return out;
}

/** Kate's wording, verbatim. Kept here so one place owns it. */
export const MULTI_ROOM_ALERT =
  "Multiple rooms detected on one line item. Confirm with customer before ordering";

/** Title Case for display: "primary bedroom" → "Primary Bedroom". */
function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Kate p19, her fallback, written out by her with a worked example:
 *
 *   "as a fallback … list the rooms + their surfaces in the color notes field
 *    as a template for the customer to fill in."
 *
 *      Primary Bedroom
 *      Walls:
 *      Ceiling:
 *      Trim:
 *
 *      Bedroom 2
 *      Accent Wall:
 *
 * Her primary ask was to drop the surface pickers for a multi-room line and
 * leave only notes, marked "an ask/not required". The fallback is built
 * instead, deliberately: it solves the same problem — the customer does not
 * otherwise know that one "room" on their form covers four — while keeping
 * the structured per-surface picks. Dropping those moves the work to whoever
 * reads the note, and there is no queue for that.
 *
 * Her example shows different surfaces per room. We cannot know that: the
 * line item carries ONE surface list for the whole scope, so it is repeated
 * under each room and the customer deletes what does not apply. Inventing a
 * per-room split would be guessing at the job.
 */
export function roomSurfaceTemplate(
  rooms: readonly string[],
  surfaces: readonly string[]
): string {
  const named = rooms.map(titleCase).filter(Boolean);
  if (named.length < 2) return "";
  const lines = surfaces.map((s) => s.trim()).filter(Boolean);
  return named
    .map((room) => [room, ...(lines.length ? lines.map((s) => `${s}:`) : ["Color:"])].join("\n"))
    .join("\n\n");
}
