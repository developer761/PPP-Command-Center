/**
 * A40's OTHER HALF — WHEN TO COME BACK.
 *
 * The spec: "The bot sets its own reminder and re-initiates the conversation
 * at that time… The conversation resumes in the same thread with full
 * context, at the time the customer named — 'after the 15th'."
 *
 * And the line that says why this is worth care: "What has never once
 * happened is the bot coming back. That half is untested in the corpus, so
 * expect to adjudicate the first few."
 *
 * ── WHY THIS IS THE TIMID KIND OF PARSER ────────────────────────────────
 *
 * Failing to read a time costs one park that a person has to notice. Reading
 * one WRONG re-opens the conversation at a moment the customer did not ask
 * for — which is a nag, from a bot, about something they already told us they
 * would come back to. That is the failure A40 exists to prevent, delivered by
 * the mechanism meant to honour it.
 *
 * So every pattern here needs an explicit, unambiguous date expression.
 * Anything vague returns null and the park simply has no reminder, which is
 * the same place we were before this file existed.
 *
 * WHAT IS DELIBERATELY NOT PARSED, and each of these was considered:
 *
 *   "in a few days"      — a few is not a number
 *   "after the holidays" — which holidays, and whose
 *   "soon", "later"      — not a time
 *   "next year"          — too far to hold a thread open against
 *   "once I've spoken to my wife"  — the no-time case the spec says is
 *                                    PPP's to decide. Do not infer one.
 *
 * ── A PARK IS NOT AN APPOINTMENT ────────────────────────────────────────
 *
 * Spec: "A park is a reminder to come back, not an appointment: nothing is
 * reserved on the customer's behalf, and no message may imply otherwise."
 * Nothing in this file books anything; it produces an instant for a reminder
 * and that is all.
 *
 * Pure. The caller supplies the clock and the customer's zone.
 */
import { shiftIntoWindow } from "./stalled";
import type { UnreachableWindow } from "./reachability";

/** The hour a re-opened conversation lands on, the customer's own clock. */
export const REOPEN_HOUR = 10;

/** How far out a park may reach. Beyond this we do not hold a thread. */
export const MAX_PARK_DAYS = 120;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Which local calendar day the customer named, or null.
 *
 * Returned as a {year, month, day} rather than a Date so the caller can place
 * it at REOPEN_HOUR in the CUSTOMER's zone — building a Date here would fix
 * the hour in whatever zone this code happens to run in.
 */
export type NamedDay = { year: number; month: number; day: number };

/**
 * Read a return date out of what the customer said.
 *
 * `today` is their local calendar day, so "the 15th" resolves against THEIR
 * month rather than the server's.
 */
export function namedReturnDay(
  text: string | null | undefined,
  today: NamedDay
): NamedDay | null {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return null;

  const addDays = (d: NamedDay, n: number): NamedDay => {
    const js = new Date(Date.UTC(d.year, d.month - 1, d.day));
    js.setUTCDate(js.getUTCDate() + n);
    return { year: js.getUTCFullYear(), month: js.getUTCMonth() + 1, day: js.getUTCDate() };
  };

  // "tomorrow"
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);

  // "in 3 weeks", "in a couple of weeks", "next week", "in two weeks"
  const weeks = /\bin\s+(\d+|a|one|two|three|a\s+couple\s+of|a\s+couple)\s+weeks?\b/.exec(t)
    ?? (/\bnext\s+week\b/.test(t) ? ["", "one"] as unknown as RegExpExecArray : null);
  if (weeks) {
    const n = wordToNumber(weeks[1]);
    if (n !== null && n <= 16) return addDays(today, n * 7);
  }

  // "in 10 days"
  const days = /\bin\s+(\d+)\s+days?\b/.exec(t);
  if (days) {
    const n = Number(days[1]);
    if (n >= 1 && n <= MAX_PARK_DAYS) return addDays(today, n);
  }

  // "next month"
  if (/\bnext\s+month\b/.test(t)) {
    const m = today.month === 12 ? 1 : today.month + 1;
    const y = today.month === 12 ? today.year + 1 : today.year;
    return { year: y, month: m, day: Math.min(today.day, 28) };
  }

  // "after the 15th", "on the 15th", "the 15th". A bare number is NOT enough
  // — "15" on its own could be anything — so an ordinal suffix or a leading
  // "the" is required.
  const ordinal = /\b(?:after|on|from|around)?\s*the\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(t)
    ?? /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (ordinal) {
    const day = Number(ordinal[1]);
    if (day >= 1 && day <= 31) {
      // This month if it is still ahead of them, otherwise next month.
      const thisMonth = { year: today.year, month: today.month, day };
      if (day > today.day && isRealDate(thisMonth)) return thisMonth;
      const m = today.month === 12 ? 1 : today.month + 1;
      const y = today.month === 12 ? today.year + 1 : today.year;
      const next = { year: y, month: m, day };
      if (isRealDate(next)) return next;
      return null;
    }
  }

  // "in March", "after March", "March" — the 1st of it.
  const month = new RegExp(`\\b(?:in|after|from|around|during)?\\s*(${MONTHS.join("|")})\\b`).exec(t);
  if (month) {
    const m = MONTHS.indexOf(month[1]) + 1;
    // A named month always means the NEXT one of that name. Said in
    // September, "March" is March next year, not the March that has gone.
    let y = today.year;
    if (m < today.month) y = today.year + 1;
    else if (m === today.month && today.day > 1) y = today.year + 1;
    return { year: y, month: m, day: 1 };
  }

  // "Monday", "next Tuesday" — the NEXT one, never today.
  const weekday = new RegExp(`\\b(?:next\\s+|on\\s+)?(${WEEKDAYS.join("|")})\\b`).exec(t);
  if (weekday) {
    const want = WEEKDAYS.indexOf(weekday[1]);
    const cur = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    let ahead = (want - cur + 7) % 7;
    if (ahead === 0) ahead = 7;                      // "Monday" said on a Monday means next one
    if (/\bnext\s/.test(t) && ahead < 7) ahead += 7; // "next Tuesday" is not this Tuesday
    return addDays(today, ahead);
  }

  return null;
}

function wordToNumber(w: string): number | null {
  const s = w.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^(?:a|one)$/.test(s)) return 1;
  if (/^two$/.test(s)) return 2;
  if (/^three$/.test(s)) return 3;
  if (/^a\s+couple(?:\s+of)?$/.test(s)) return 2;
  return null;
}

function isRealDate(d: NamedDay): boolean {
  const js = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return js.getUTCFullYear() === d.year && js.getUTCMonth() + 1 === d.month && js.getUTCDate() === d.day;
}

/**
 * When the thread should re-open, as an instant — or null.
 *
 * Placed at REOPEN_HOUR on the customer's own clock, then moved into A36's
 * window by the SAME function the stall cadence uses. A re-open is an
 * outbound message the bot initiates, so it obeys the callback window exactly
 * as a follow-up does; using shiftIntoWindow rather than a second
 * implementation is what stops the two drifting.
 */
export function parkReopenAt(input: {
  text: string | null | undefined;
  /** The customer's local calendar day right now. */
  today: NamedDay;
  customerZone: string;
  officeZone?: string;
  unreachable?: UnreachableWindow | null;
  /** Never schedule before this — the caller's clock. */
  notBefore: Date;
}): Date | null {
  const day = namedReturnDay(input.text, input.today);
  if (!day) return null;

  const target = instantAtLocalHour(day, REOPEN_HOUR, input.customerZone);
  if (!target) return null;

  // Too far out to hold a thread against, or somehow in the past.
  const days = (target.getTime() - input.notBefore.getTime()) / 86_400_000;
  if (days > MAX_PARK_DAYS) return null;
  if (target.getTime() <= input.notBefore.getTime()) return null;

  return shiftIntoWindow({
    target,
    customerZone: input.customerZone,
    officeZone: input.officeZone,
    unreachable: input.unreachable,
  });
}

/**
 * The instant at which it is `hour` o'clock on `day` in `timeZone`.
 *
 * Searched rather than computed, because the offset for a given local day is
 * the thing being solved for — and it changes twice a year.
 */
function instantAtLocalHour(day: NamedDay, hour: number, timeZone: string): Date | null {
  const noonUtc = Date.UTC(day.year, day.month - 1, day.day, 12, 0, 0);
  for (let offset = -14; offset <= 14; offset++) {
    const c = new Date(noonUtc + offset * 3600_000);
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
      }).formatToParts(c);
    } catch { return null; }
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    if (get("year") === day.year && get("month") === day.month
        && get("day") === day.day && get("hour") % 24 === hour) {
      return c;
    }
  }
  return null;
}
