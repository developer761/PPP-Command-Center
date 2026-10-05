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

/**
 * ── SPANISH, AND WHY IT IS IN THE SAME REGEXES ──────────────────────────
 *
 * Played live 2026-10-05: a Spanish conversation ran the whole flow in
 * Spanish, the customer answered "el miércoles", and `success` was refused
 * with "no day and no time of day has been given anywhere in the
 * conversation (A4)". Wednesday had been given. The day was simply in a
 * language these patterns did not read.
 *
 * Two costs, and the second is the expensive one. The close is blocked, so a
 * Spanish lead that answered every question still goes to a person — the
 * unsatisfiable shape this repo keeps producing, where the BEST lead is the
 * one that cannot convert. And ASK_AVAILABILITY_GAP_ES, the Spanish "and
 * roughly what time of day?", could never fire either: the gap is only
 * "window" once a DAY has been found, so a whole set of translated templates
 * was unreachable rather than merely unused.
 *
 * Same regexes rather than a language-switched pair, because a Spanish day
 * name means the same thing in a thread we have labelled English — people
 * code-switch, and nothing here depends on the rest of the sentence.
 *
 * ── ONE WORD NEEDS CARE: "mañana" ───────────────────────────────────────
 *
 * It is both TOMORROW and MORNING. Bare, it is the day; with an article and
 * a preposition ("por la mañana", "en la mañana") it is the window. So it is
 * a DAY on its own and a WINDOW only in that phrase — which makes "mañana
 * por la mañana" match both, correctly. The same shape covers "la tarde" and
 * "la noche", where the bare words also mean "late" and "night".
 *
 * Erring tight on purpose: a false DAY would let a conversation close as
 * booked against nothing, which is the whole thing A4 exists to stop.
 */
/** A named day, or a relative one people actually use. */
const DAY =
  /\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b|\b(?:today|tomorrow|tmrw|weekday|weekend)s?\b|\b(?:next|this)\s+week\b|\b\d{1,2}\s*\/\s*\d{1,2}\b|\b(?:lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bados?|domingos?)\b|\bhoy\b|\bpasado\s+ma[ñn]ana\b|(?<!la\s)(?<!las\s)\bma[ñn]ana\b|\bfin(?:es)?\s+de\s+semana\b|\bentre\s+semana\b|\b(?:la\s+)?(?:pr[óo]xima|siguiente)\s+semana\b|\besta\s+semana\b/i;

/**
 * A time window. A clock time counts, because "2pm" tells an estimator when
 * to turn up even without an explicit range.
 */
const WINDOW =
  /\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)\b|\b\d{1,2}\s*(?:-|–|to|until|til+)\s*\d{1,2}\s*(?:[ap]\.?m\.?)?\b|\b(?:mornings?|afternoons?|evenings?|noon|midday|lunchtime|first thing|after work|before work|early|late)\b|\b(?:por|en|de)\s+la(?:s)?\s+(?:ma[ñn]anas?|tardes?|noches?)\b|\b(?:medio\s?d[íi]a|mediod[íi]a)\b|\ba\s+las?\s+\d{1,2}(?::\d{2})?\b|\b(?:temprano|tempranito)\b/i;

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
    // The same set in Spanish. "cuando sea" and "cuando guste" are the two a
    // person actually types; "soy flexible" is the direct equivalent of the
    // English one above it. Kept to phrases, because bare "cualquier" or
    // bare "hora" appear in questions about OUR availability too.
    String.raw`\bcuando\s+(?:sea|guste|quiera|pueda[ns]?|le\s+(?:sirva|convenga|quede))\b`,
    String.raw`\bcualquier\s+(?:d[íi]a|hora|momento)\b`,
    String.raw`\ba\s+cualquier\s+hora\b`,
    String.raw`\b(?:soy|estoy|somos|estamos)\s+flexibles?\b`,
    String.raw`\blo\s+que\s+(?:le\s+)?(?:sirva|convenga|quede\s+mejor)\b`,
  ].join("|"),
  "i"
);

/**
 * "Yes please" in reply to an availability question is availability received.
 * A non-answer counts, in Kate's words, so the caller tells us whether we had
 * just asked and a bare assent is enough.
 */
/**
 * Spanish assent sits in the same anchored shape, and the anchor is what
 * makes it safe: unaccented "si" is the conditional IF, so "si puede el
 * jueves" is an answer about Thursday and not a bare yes. `^…$` means it only
 * matches a message that is NOTHING but the assent.
 *
 * Missed when DAY and WINDOW were given Spanish: a Spanish lead who replied
 * "sí, perfecto" to the availability question still could not be closed, which
 * is the exact outcome that change was made to prevent.
 */
const ASSENT = /^\s*(?:yes|yep|yeah|yup|sure|ok(?:ay)?|sounds good|please|yes please|that works|works for me|perfect|great|s[íi]|claro|perfecto|de acuerdo|est[áa] bien|esta bien|me sirve|s[íi] por favor|excelente|vale)\b[\s.!]*$/i;

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

/**
 * THE GAP ACROSS A WHOLE CONVERSATION, NOT ONE MESSAGE.
 *
 * availabilityGap answers "does THIS message contain bookable availability",
 * which is the right question for the renderer — it is wording the follow-up
 * ask about what the customer just said.
 *
 * It is the wrong question for the close guard. Found in the sandbox
 * 2026-10-01, running two properties end to end:
 *
 *   customer  "Wednesday afternoon works"        -> gap null, bookable
 *   BOT       "And what's the address for the second property?"
 *   customer  "45 Pine St, Garden City NY 11530"
 *   BOT       success  ->  BLOCKED: "they named a time but no day (A4)"
 *
 * Availability had been collected two turns earlier and the progress panel
 * showed it held. The guard re-read the CURRENT message, found an address,
 * and reported that nothing bookable existed. Every turn after availability
 * is collected does this — an address, a name, even "yes that's right" — so a
 * conversation that has all four legs cannot close and goes to a person.
 *
 * The guard's own comment already said it should not work this way: "It does
 * not re-litigate a conversation whose availability was collected earlier."
 * This is the function that makes that true.
 *
 * The two halves ACCUMULATE, because they genuinely arrive apart: "Wednesday"
 * in one message and "afternoon" in the next is a day and a window, and Kate's
 * test — could a person reply "you're booked for X" without asking anything
 * further — is satisfied by the pair.
 */
export function availabilityGapAcross(
  texts: readonly (string | null | undefined)[],
  opts: { justAskedForAvailability?: boolean } = {}
): AvailabilityGap {
  let haveDay = false;
  let haveWindow = false;
  for (const text of texts) {
    const gap = availabilityGap(text, opts);
    if (gap === null) return null;
    // "window" means a DAY was found and the window is what is missing.
    if (gap === "window") haveDay = true;
    if (gap === "day") haveWindow = true;
  }
  if (haveDay && haveWindow) return null;
  if (haveDay) return "window";
  if (haveWindow) return "day";
  return "both";
}

/** Could a person reply "you're booked for X" without asking anything else? */
export function availabilityIsBookable(
  text: string | null | undefined,
  opts: { justAskedForAvailability?: boolean } = {}
): boolean {
  return availabilityGap(text, opts) === null;
}
