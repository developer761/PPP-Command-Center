/**
 * Has the customer actually given us something an estimator can be booked
 * against?
 *
 * ── THE TEST IS KATE'S, AND IT IS MECHANICAL ────────────────────────────
 *
 * A4, 2026-09-21: "A DAY IS NOT A WINDOW, AND BOTH ARE REQUIRED. 'Wed &
 * Friday this week works best' is NOT availability collected — the estimator
 * cannot be booked against it. THE TEST: could a person reply 'you're booked
 * for X' without asking anything further? If they would still have to ask
 * 'does 2 to 3 work?', collection has not happened."
 *
 * So this answers one question: is there a day AND a window, or one of the
 * carve-outs that makes a window meaningless?
 *
 * ── THE CARVE-OUTS ARE NOT SOFTENING, THEY ARE THE RULE ─────────────────
 *
 * "The carve-outs stand — 'anytime', 'all day', 'I'm open' IS availability
 * received, because there is nothing left to narrow." Somebody who says
 * "anytime" has given a complete answer, and asking them to pick a window is
 * the redundant ask the rest of the grading is about. Same for "yes please"
 * in reply to an availability question: "A non-answer counts."
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────
 *
 * It does not decide WHICH week to offer, which is A43. It does not book
 * anything, because the bot has no calendar and never books. It only says
 * whether what we were told is bookable.
 *
 * Pure.
 */

/** A named day, or a relative one people actually use. */
const DAY =
  /\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b|\b(?:today|tomorrow|tmrw|weekday|weekend)s?\b|\b(?:next|this)\s+week\b|\b\d{1,2}\s*\/\s*\d{1,2}\b/i;

/**
 * A time window. A clock time counts, because "2pm" tells an estimator when
 * to turn up even without an explicit range.
 */
const WINDOW =
  /\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)\b|\b\d{1,2}\s*(?:-|–|to|until|til+)\s*\d{1,2}\s*(?:[ap]\.?m\.?)?\b|\b(?:mornings?|afternoons?|evenings?|noon|midday|lunchtime|first thing|after work|before work|early|late)\b/i;

/**
 * Nothing left to narrow. Kate names these explicitly as availability
 * RECEIVED, so they satisfy the rule outright rather than being treated as a
 * missing window.
 */
const OPEN_ENDED = new RegExp(
  [
    String.raw`\banytime\b`, String.raw`\bany time\b`, String.raw`\bwhenever\b`,
    String.raw`\bany day\b`, String.raw`\bflexible\b`,
    String.raw`\bi(?:'?m| am) open\b`, String.raw`\bwe(?:'?re| are) open\b`,
    String.raw`\bopen all\b`,
    String.raw`\bwhatever (?:works|suits|is easiest)\b`,
    // "all day" NEEDS an availability word beside it. Bare matching read
    // "Hi sorry was working all day yesterday" as availability received —
    // an apology about the past, offered as a bookable slot.
    String.raw`\b(?:available|free|open|home|around|here)\b[^.!?]{0,20}\ball day\b`,
    String.raw`\ball day\b[^.!?]{0,15}\b(?:works?|is fine|is good|suits)\b`,
  ].join("|"),
  "i"
);

/**
 * "Yes please" in reply to an availability question is availability received.
 * A non-answer counts, in Kate's words, so the caller tells us whether we had
 * just asked and a bare assent is enough.
 */
const ASSENT = /^\s*(?:yes|yep|yeah|yup|sure|ok(?:ay)?|sounds good|please|yes please|that works|works for me|perfect|great)\b[\s.!]*$/i;

export type AvailabilityGap =
  /** Nothing usable at all. */
  | "both"
  /** A day, but no window an estimator could be booked into. */
  | "window"
  /** A time, but no day it belongs to. */
  | "day"
  /** Nothing missing. */
  | null;

export function availabilityGap(
  text: string | null | undefined,
  opts: { justAskedForAvailability?: boolean } = {}
): AvailabilityGap {
  const t = (text ?? "").trim();
  if (!t) return "both";

  // "Anytime" answers both halves at once.
  if (OPEN_ENDED.test(t)) return null;

  // A bare yes only means something if we had just asked.
  if (opts.justAskedForAvailability && ASSENT.test(t)) return null;

  const day = DAY.test(t);
  const window = WINDOW.test(t);
  if (day && window) return null;
  if (day) return "window";
  if (window) return "day";
  return "both";
}

/** Could a person reply "you're booked for X" without asking anything else? */
export function availabilityIsBookable(
  text: string | null | undefined,
  opts: { justAskedForAvailability?: boolean } = {}
): boolean {
  return availabilityGap(text, opts) === null;
}
