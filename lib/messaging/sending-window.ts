/**
 * A36 — THE CALLABLE WINDOW, WHICH COVERS TEXTS AND NOT JUST CALLS.
 *
 * Kate's rule, verbatim from sms_class_a_rules:
 *
 *   "CALLBACK WINDOW to SET an appointment (Eastern): Mon-Fri 9 AM - 8 PM ·
 *    Sat and Sun 9 AM - 5:30 PM. Within it: 9 AM-7 PM ET for clients in
 *    Eastern; after 7 PM ET no outbound to Eastern clients until the next day;
 *    7-8 PM ET is the hour for CA/CO (Pacific/Mountain). Never call a Pacific
 *    or Mountain customer before 9 AM THEIR local time."
 *   "🔴 THE WINDOW COVERS TEXTS, NOT JUST CALLS. Any OUTBOUND message the bot
 *    sends obeys these hours."
 *
 * ── READING IT AS TWO WINDOWS, NOT SIX SPECIAL CASES ────────────────────
 *
 * Written out per state it looks like a table of exceptions. It is not. It is
 * two windows that must BOTH be open:
 *
 *   THE OFFICE     9 AM - 8 PM Eastern on weekdays, 9 AM - 5:30 PM at
 *                  weekends. When PPP is working at all.
 *
 *   THE CUSTOMER   9 AM - 7 PM on the CUSTOMER'S OWN CLOCK. When it is a
 *                  civil hour where they are.
 *
 * Every clause above falls out of the intersection. "After 7 PM ET nothing to
 * Eastern clients" is the customer window closing. "7-8 PM ET is the hour for
 * CA/CO" is not a reserved slot — it is simply the only hour where the office
 * is still open and an Eastern customer's window has shut, so Pacific and
 * Mountain are who is left. "Never before 9 AM their local time" is the same
 * customer window opening.
 *
 * Kate's own acceptance test confirms the reading: "Tested at 7:30 PM Eastern
 * with a California lead and an Eastern lead: on the same clock tick, one gets
 * the in-hours behaviour and the other gets the prefix." At 7:30 PM ET the
 * office is open, the Californian is at 4:30 PM (open) and the New Yorker is
 * at 7:30 PM (shut). One tick, two answers.
 *
 * ── WHY THIS IS A BUG FIX AND NOT A FEATURE ─────────────────────────────
 *
 * The gate resolved BOTH windows against the workspace's clock, so at 9:30 AM
 * Eastern it permitted a text to a California number at 6:30 in the morning.
 * That is under the federal 8 AM floor, so it was not merely outside Kate's
 * preference. See customer-clock.ts for how the recipient's zone is resolved
 * and what happens when it cannot be.
 */
import {
  clampToFederal, withinMinuteWindow, isWeekendIn, FEDERAL_BOUND, type QuietHours,
} from "./compliance";

/** A36 is written in Eastern because that is where PPP's office sits. */
export const OFFICE_ZONE = "America/New_York";

/** Mon-Fri 9 AM - 8 PM Eastern. Minutes from midnight. */
export const OFFICE_WEEKDAY = { start: 9 * 60, end: 20 * 60 };
/** Sat and Sun 9 AM - 5:30 PM Eastern. The half hour is why minutes exist. */
export const OFFICE_WEEKEND = { start: 9 * 60, end: 17 * 60 + 30 };

/**
 * 9 AM - 7 PM on the customer's own clock, for a message PPP initiates.
 *
 * Tighter than the federal 8 AM - 9 PM on purpose: Kate's rule is the business
 * one and it is stricter, so it binds first. The federal bound is still the
 * outer rail underneath — clampToFederal can only narrow this.
 */
export const CUSTOMER_OUTBOUND: QuietHours = { startHour: 9, endHour: 19 };

export type WindowRefusal =
  /** It is not a civil hour where the CUSTOMER is. The legal one. */
  | "customer_local_hours"
  /** PPP is not working. PPP's own rule, so it defers rather than refuses. */
  | "office_closed";

export type WindowVerdict =
  | { open: true }
  | { open: false; why: WindowRefusal };

/**
 * May an outbound message go out to this person, at this instant?
 *
 * `customerHours` lets a reply relax the CUSTOMER side to the federal bound —
 * somebody who texted at 8:30 PM has started the conversation, and answering
 * them is not soliciting them (see SendRequest.answersInbound). It never
 * relaxes the office side and it never escapes clampToFederal.
 */
export function sendingWindow(input: {
  now: Date;
  /** The recipient's IANA zone, from customerZone(). Never the workspace's. */
  customerZone: string;
  /** PPP's operating window. Defaults to A36's Eastern office. */
  officeZone?: string;
  /** PPP's configured hours, when a workspace has narrowed them further. */
  officeHours?: QuietHours;
  answersInbound?: boolean;
}): WindowVerdict {
  const officeZone = input.officeZone ?? OFFICE_ZONE;

  // THE CUSTOMER'S CLOCK FIRST, because it is the legal one and the office
  // being open is no defence for a 6:30 AM text.
  const customerHours = clampToFederal(
    input.answersInbound ? { ...FEDERAL_BOUND } : CUSTOMER_OUTBOUND
  );
  if (!withinMinuteWindow(
    input.now, input.customerZone,
    customerHours.startHour * 60, customerHours.endHour * 60,
  )) {
    return { open: false, why: "customer_local_hours" };
  }

  // THE OFFICE — and answering somebody does not need the office to be open.
  //
  // A36 and Karan's 2026-09-22 decision genuinely conflict here, and this is
  // where the line falls. Kate's rule names itself "CALLBACK WINDOW to SET an
  // appointment": it governs contact PPP initiates. Somebody who texts at
  // 8:30pm has started the conversation, and replying to them is not a
  // callback to set an appointment — it is an answer. Karan chose that
  // explicitly when after-hours replies were built, and four tests in
  // gate.test.ts encode it.
  //
  // What does NOT stand down is the customer window above. An inbound reply
  // still obeys the federal 8am-9pm ON THE RECIPIENT'S CLOCK, so the thing
  // this file exists to prevent is unaffected.
  //
  // ── OPEN WITH KATE ──────────────────────────────────────────────────
  // Worth her confirming: does A36's window cover replies to an inbound
  // message, or only outbound PPP starts? This reads it as the latter. If she
  // means the former, delete this early return and the four tests change.
  if (input.answersInbound) return { open: true };

  // A36's weekday/weekend windows, narrowed by whatever the workspace has
  // configured but never widened past them.
  const base = isWeekendIn(input.now, officeZone) ? OFFICE_WEEKEND : OFFICE_WEEKDAY;
  const configured = input.officeHours;
  const start = configured ? Math.max(base.start, configured.startHour * 60) : base.start;
  const end = configured ? Math.min(base.end, configured.endHour * 60) : base.end;
  if (!withinMinuteWindow(input.now, officeZone, start, end)) {
    return { open: false, why: "office_closed" };
  }

  return { open: true };
}

/**
 * The next instant both windows are open, or null when there is no such
 * instant inside a week.
 *
 * Scans against `sendingWindow` itself rather than re-deriving the rule, so a
 * change to the window cannot leave the retry time answering the old one. That
 * exact drift — a predicate and its scheduler disagreeing — has happened four
 * times in this codebase.
 *
 * Half-hour steps because A36's weekend close is 5:30 PM; hour steps would
 * report the office open for the half hour after it shut. Returns null rather
 * than throwing: a gate that crashes on a misconfigured workspace is worse
 * than one that refuses without a retry time.
 */
export function nextWindowOpen(input: Parameters<typeof sendingWindow>[0]): Date | null {
  if (sendingWindow(input).open) return input.now;
  const cursor = new Date(input.now.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() < 30 ? 30 : 60, 0, 0);
  // A week: long enough that only a window which never opens returns null.
  for (let i = 0; i < 7 * 48; i++) {
    if (sendingWindow({ ...input, now: cursor }).open) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 30);
  }
  return null;
}
