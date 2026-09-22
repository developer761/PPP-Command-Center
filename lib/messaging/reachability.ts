/**
 * When the customer has told us not to text them.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────
 *
 * A44, Kate, 2026-09-18: "A STATED CONSTRAINT MOVES THE CADENCE. If the
 * customer has said when they cannot be reached — 'I'm at work until 5',
 * 'don't text me during the day' — every follow-up shifts outside that
 * window, or to a Saturday. The constraint does not need to be repeated and
 * it does not expire: once stated, it binds the whole cadence. A cadence that
 * fires into a window the customer already ruled out is a defect EVEN IF THE
 * CUSTOMER NEVER COMPLAINS."
 *
 * That last clause is why this exists as code rather than as prompt guidance.
 * It is a defect with no feedback signal: the customer does not complain, they
 * just never reply, and the conversation dies looking like disinterest. There
 * is nothing to notice and therefore nothing anyone would ever fix.
 *
 * ── WHY THE PARSER IS DELIBERATELY TIMID ────────────────────────────────
 *
 * Failing to spot a constraint costs one badly timed text. Inventing one moves
 * every future message for that customer to a window nobody asked for, on
 * evidence that was never there, and nothing downstream will question it
 * because a stated constraint is supposed to outrank the default. So every
 * pattern here needs an explicit reachability verb near the time — work, text,
 * call, reach, available — and anything ambiguous returns null.
 *
 * "Until 5" alone is not a constraint. It could be May.
 *
 * Pure. No clock, no database. The caller supplies both.
 */

/**
 * Hours the customer cannot be reached, local, as a half-open range
 * [startHour, endHour). A window that wraps midnight is not representable and
 * is not something anybody says: "don't text me at night" is the default quiet
 * hours rule (A36), not a stated constraint.
 */
export type UnreachableWindow = { startHour: number; endHour: number };

/** Words that make a time a REACHABILITY statement rather than any other number. */
const REACH = /\b(?:work(?:ing|s)?|shift|job|office|text|txt|message|msg|call|talk|speak|chat|reach|available|free|busy|asleep|sleep|home)\b/i;

/** A negation that flips "available" into "unavailable". */
const NEGATED = /\b(?:don'?t|do not|dont|can'?t|cannot|cant|never|no|not|unable|avoid|rather not|please don'?t)\b/i;

/**
 * ── THE INVERSION GUARD, AND WHY IT IS THE MOST IMPORTANT LINE HERE ─────
 *
 * Run against the 332 real customer messages in Kate's corpus, the first
 * version of this parser fired six times and was WRONG five times. One of
 * them was the worst mistake this module can make:
 *
 *   "Anytime 9am - 6:30 pm works"  ->  blocked 09:00-18:00
 *
 * The customer stated their AVAILABILITY and the parser recorded it as the
 * window they cannot be reached, which would have moved every follow-up out
 * of the only hours they said were good. It matched because "works" satisfies
 * the work pattern in REACH.
 *
 * Also caught: "quote my home September 11-13?" read as 11:00-13:00, and a
 * reaction quoting our own message — Loved "Good morning, [NAME]!" — reading
 * as mornings being bad.
 *
 * So a bare time range is no longer a constraint at all, availability wording
 * suppresses the whole message, dates are excluded, and a quoted reaction is
 * not the customer's own words. Every one of these is evidence from real
 * conversations rather than something imagined at a desk.
 */
const FLEXIBLE = /\banytime\b|\bany time\b|\bwhenever\b|\bany day\b/i;

/** A month beside a number range makes it a date, not an hour. */
const MONTH = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d/i;

/** iMessage reactions quote OUR text back. The quoted half is not theirs.
 *  Curly quotes included: the real corpus uses them and straight quotes alone
 *  let this through. */
const REACTION = /^\s*(?:loved|liked|laughed at|emphasi[sz]ed|disliked|questioned)\s+["'‘’“”]/i;

/**
 * Words that make the nearby time a GOOD one, not a blocked one.
 *
 * "I'm usually free in the late afternoons/evenings/weekends but don't know
 * if youre available at those times" — a real message. "afternoons" plus a
 * negation anywhere in the sentence marked afternoons as blocked, when the
 * customer had just said afternoons were when they were free. The negation
 * belonged to "don't know", four clauses away.
 */
const POSITIVE = /\b(?:free|available|good|great|fine|works?|prefer|best|easier|open)\b/i;

/** How far back a negation can sit and still be about this phrase. */
const CLAUSE = 45;

/** "don't work", "can't do" — a refusal wearing a positive word. Collapsed
 *  before POSITIVE is tested, or "afternoons don't work" reads as afternoons
 *  working. */
const REFUSAL = /\b(?:don'?t|doesn'?t|do not|can'?t|cannot|cant|won'?t|not|never)\s+(?:really\s+)?(?:work\w*|good|great|fine|available|free|open|suit\w*)/gi;

/**
 * Is the phrase at `idx` negated by something in its own clause, and not
 * already marked as a good time?
 *
 * Looks both ways. "please don't text me during the day" puts the refusal
 * before the phrase; "afternoons don't work for me" puts it after.
 */
function negatedNear(text: string, idx: number, len: number): boolean {
  const before = text.slice(Math.max(0, idx - CLAUSE), idx);
  const after = text.slice(idx + len, idx + len + CLAUSE);

  // A positive word BEFORE the phrase makes it a good time, not a blocked
  // one: "usually free in the late afternoons".
  if (POSITIVE.test(before.replace(REFUSAL, " "))) return false;

  const refused = REFUSAL.test(before) || REFUSAL.test(after);
  REFUSAL.lastIndex = 0;
  return refused || NEGATED.test(before);
}

/** "I work 9-5" is a constraint. "9-5 works" is not. The pronoun matters. */
const OWN_WORK_HOURS = /\b(?:i|we)\s+(?:usually\s+|normally\s+|generally\s+)?work\b/i;

/** "5", "5pm", "5:30pm", "17:00" to an hour, or null. */
function hourOf(raw: string, meridiem: string | null): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  if (h > 24) return null;
  const mer = meridiem?.toLowerCase().replace(/[.\s]/g, "");
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  // A bare number in a reachability sentence is a working hour, not 3am.
  // "back at 6" means the evening; "until 5" means the afternoon.
  if (!mer && h >= 1 && h <= 7) h += 12;
  if (h > 23) h = 23;
  return h;
}

const TIME = String.raw`(\d{1,2}(?::\d{2})?)\s*([ap]\.?m\.?)?`;

/** Whole-day shorthands people actually use, and what they block. */
const PHRASES: { re: RegExp; win: UnreachableWindow; needsNegation: boolean }[] = [
  // "don't text me during the day", "no texts during the day"
  { re: /\bduring (?:the )?day\b|\bin the day(?:time)?\b|\bdaytime\b/i, win: { startHour: 9, endHour: 17 }, needsNegation: true },
  // "don't call me at work", with no hours given: assume a working day.
  { re: /\b(?:at|during) work\b|\bwhile (?:i'?m |i am )?(?:at )?work(?:ing)?\b/i, win: { startHour: 9, endHour: 17 }, needsNegation: true },
  // "I work nights" — the block is the night, and the bot may not text then
  // anyway, but a stated constraint is still recorded rather than inferred.
  { re: /\bwork(?:s|ing)? (?:the )?night(?:s|shift)?\b|\bnight shift\b/i, win: { startHour: 20, endHour: 23 }, needsNegation: false },
  // "mornings are bad", "can't do mornings"
  { re: /\bmornings?\b/i, win: { startHour: 6, endHour: 12 }, needsNegation: true },
  // "afternoons don't work"
  { re: /\bafternoons?\b/i, win: { startHour: 12, endHour: 17 }, needsNegation: true },
];

/**
 * The window this message rules out, or null.
 *
 * Returns ONE window. A message stating two is rare enough that taking the
 * first and leaving the second is better than merging them into a range the
 * customer never described.
 */
export function statedConstraint(text: string | null | undefined): UnreachableWindow | null {
  const t = (text ?? "").trim();
  if (!t || t.length > 600) return null;
  if (!REACH.test(t)) return null;

  // Everything below is a reason this message is not a stated constraint,
  // each one learned from a real message it got wrong. See the guard above.
  if (REACTION.test(t)) return null;
  if (MONTH.test(t)) return null;

  // A customer saying they are flexible has stated the opposite of a
  // constraint. Reading "anytime 9am - 6:30 pm works" as a blocked window
  // inverted exactly the hours they had just offered.
  if (FLEXIBLE.test(t)) return null;

  const negated = NEGATED.test(t);

  // "at work until 5", "busy till 5:30pm", "can't talk until 6"
  const until = new RegExp(String.raw`\b(?:un)?til+\s+${TIME}`, "i").exec(t);
  if (until) {
    const h = hourOf(until[1], until[2] ?? null);
    if (h !== null && h > 0) return { startHour: 0, endHour: h };
  }

  // "I work 9-5". ONLY with the pronoun: a bare range is a date, a price, a
  // room count or the hours they are free, and it was wrong far more often
  // than it was right.
  const range = OWN_WORK_HOURS.test(t)
    ? new RegExp(String.raw`\b${TIME}\s*(?:-|–|to|until|thru|through)\s*${TIME}`, "i").exec(t)
    : null;
  if (range) {
    // A range with no meridiem on the first part borrows it from the second:
    // "9-5pm" is 9am to 5pm, not 9pm.
    const end = hourOf(range[3], range[4] ?? null);
    let start = hourOf(range[1], range[2] ?? null);
    if (range[2] == null && start !== null && end !== null && start > end) {
      // hourOf's afternoon default overshot: "9 to 5" made 9 into 9, 5 into
      // 17, which is right; "1 to 4" made both afternoon, also right. A start
      // after the end means the default was wrong for the start.
      start = Number(/^(\d{1,2})/.exec(range[1])?.[1] ?? start);
    }
    if (start !== null && end !== null && start < end) return { startHour: start, endHour: end };
  }

  // "after 6 is best" / "only after 6" — everything before is ruled out.
  const after = new RegExp(String.raw`\bafter\s+${TIME}`, "i").exec(t);
  if (after) {
    const h = hourOf(after[1], after[2] ?? null);
    if (h !== null && h > 0) return { startHour: 0, endHour: h };
  }

  // "before 10" only rules something out when it is being refused.
  const before = new RegExp(String.raw`\bbefore\s+${TIME}`, "i").exec(t);
  if (before && negated) {
    const h = hourOf(before[1], before[2] ?? null);
    if (h !== null && h > 0) return { startHour: 0, endHour: h };
  }

  for (const p of PHRASES) {
    const m = p.re.exec(t);
    if (!m) continue;
    // The negation must be in the SAME CLAUSE. A "don't" belonging to another
    // thought entirely is how "free in the late afternoons" became a window
    // the customer supposedly could not be reached in.
    if (p.needsNegation && !negatedNear(t, m.index, m[0].length)) continue;
    return p.win;
  }

  return null;
}

/** Does this local hour fall inside a window the customer ruled out? */
export function blocked(hour: number, win: UnreachableWindow | null | undefined): boolean {
  if (!win) return false;
  return hour >= win.startHour && hour < win.endHour;
}

/**
 * The hour to use instead, staying on the same day where possible.
 *
 * Prefers the first hour AFTER the window, because a follow-up the customer
 * asked to receive in the evening should arrive that evening rather than
 * sliding a day. Falls back to the hour before the window when the window runs
 * to the end of the day.
 *
 * Returns null when the whole usable day is ruled out, which is the caller's
 * signal to move to another day — Kate's "or to a Saturday".
 */
export function reachableHour(
  win: UnreachableWindow | null | undefined,
  preferred: number,
  bounds: { startHour: number; endHour: number }
): number | null {
  const inBounds = (h: number) => h >= bounds.startHour && h < bounds.endHour;
  if (!blocked(preferred, win) && inBounds(preferred)) return preferred;
  if (!win) return inBounds(preferred) ? preferred : null;

  if (inBounds(win.endHour)) return win.endHour;
  const before = win.startHour - 1;
  if (before >= bounds.startHour && !blocked(before, win)) return before;
  return null;
}
