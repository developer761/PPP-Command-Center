/**
 * HOW WE ASK FOR AVAILABILITY, AND WHAT TO DO WHEN THEY ASK BACK.
 *
 * Two Hatch behaviours we did not have (HATCH_PARITY_GAPS gaps 1 and 5),
 * found by reading its live prompt. Neither is in the Iteration 1 spec.
 *
 * ── 1. THE ASK IS DAY-DEPENDENT ─────────────────────────────────────────
 *
 * Hatch, verbatim:
 *   Sunday through Wednesday: "We have a few openings this week to meet with
 *   you, what would work best for you?"
 *   Thursday through Saturday: "We have a few openings next week to meet with
 *   you, what would work best for you?"
 *
 * Ours asked "What days generally work best for you?" — an open question that
 * invites "sometime next month". Naming the week sets an expectation and
 * makes the answer usable.
 *
 * 🔴 THIS IS NOT A15. A15 forbids offering, confirming or inventing a TIME.
 * "a few openings this week" names no day and no hour; it describes that we
 * have capacity, which is true and is not a slot. The line is Hatch's
 * approved copy and the distinction is exactly the one A15 draws — a rough
 * window is not an appointment.
 *
 * The cut is Wednesday/Thursday because by Thursday "this week" is two days
 * that are mostly gone, and offering them reads as pressure.
 *
 * ── 2. THEY ASK US FIRST ────────────────────────────────────────────────
 *
 * Hatch: "If they insist on knowing our availability before providing theirs,
 * End: Schedule Follow Up."
 *
 * Without this the bot and the customer can pass the question back and forth:
 * we ask when suits them, they ask what we have, we ask again. The bot cannot
 * answer — it has no calendar, and A15 forbids inventing one — so the honest
 * move is to stop asking and get a person to call with real times.
 *
 * Pure. The caller supplies the clock.
 */

/** Sunday = 0. The customer's own day, not the server's. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function weekdayIn(now: Date, timeZone: string): Weekday | null {
  let name: string;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  } catch { return null; }
  const i = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  return i < 0 ? null : (i as Weekday);
}

/**
 * Which week to offer. Sunday-Wednesday is this one; Thursday-Saturday is
 * next. Null when the zone is unusable, and the caller falls back to the
 * generic ask rather than guessing a week.
 */
export function weekToOffer(now: Date, timeZone: string): "this" | "next" | null {
  const d = weekdayIn(now, timeZone);
  if (d === null) return null;
  return d >= 0 && d <= 3 ? "this" : "next";
}

/** Hatch's approved wording, with the week filled in. */
export function askAvailability(week: "this" | "next"): string {
  return `We have a few openings ${week} week to meet with you, what would work best for you?`;
}

export function askAvailabilityEs(week: "this" | "next"): string {
  return week === "this"
    ? "Tenemos algunos espacios disponibles esta semana para reunirnos con usted. ¿Qué le viene mejor?"
    : "Tenemos algunos espacios disponibles la próxima semana para reunirnos con usted. ¿Qué le viene mejor?";
}

/**
 * ARE THEY ASKING US FOR OUR TIMES?
 *
 * Deliberately narrow. It has to be a question aimed at OUR availability, not
 * any mention of time. "What days work for you?" echoed back, "when are you
 * free", "what times do you have" — those are the stand-off. "I'm free
 * Tuesday" is an answer, and must never match.
 */
const ASKS_OUR_AVAILABILITY =
  /\b(?:what|which|when)\b[^.?!]{0,40}\b(?:times?|slots?|openings?|availability|days?|dates?)\b[^.?!]{0,30}\b(?:do you|have you|you have|are you|you got|works? for you|on your end|available)\b|\bwhen\s+(?:are|can)\s+you\b|\bwhat(?:'s| is)\s+your\s+availability\b|\bwhat\s+(?:have|do)\s+you\s+got\b|\byou\s+tell\s+me\s+(?:what|when)\b/i;

/** An answer, not a question — checked first so it can never be a stand-off. */
const GIVES_THEIR_OWN =
  /\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:free|available|open|around)\b|\b(?:mornings?|afternoons?|evenings?|weekends?|weekdays?)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.?!]{0,20}\b(?:works?|is good|suits|fine)\b|\banytime\b|\bwhenever\b/i;

export function asksOurAvailability(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (GIVES_THEIR_OWN.test(t)) return false;
  return ASKS_OUR_AVAILABILITY.test(t);
}

/**
 * Has the customer now asked twice without answering?
 *
 * Hatch says "insist", not "ask". Asking once is reasonable — a person would
 * answer it. Asking again after we have already put the question back is the
 * stand-off, and that is when it goes to a human.
 */
export function isAvailabilityStandOff(customerMessages: readonly string[]): boolean {
  return customerMessages.filter((m) => asksOurAvailability(m)).length >= 2;
}
