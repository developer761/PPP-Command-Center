/**
 * A44 — WHEN THE CUSTOMER GOES QUIET.
 *
 * Kate: "SILENCE IS NOT A PARK. When the customer simply stops replying, run
 * the follow-up cadence and then hand the conversation on — never end it, and
 * never keep nudging past the cadence."
 *
 * Iteration 1 spec: three follow-ups, one a day, at 10 AM / 3 PM / 6 PM the
 * customer's local time, shifted around any window they said they were
 * unreachable in and around A36's outbound hours. Baseline to beat: of 237
 * stalled conversations, **none ever received three follow-ups and 208
 * received none at all**.
 *
 * ── WHAT COUNTS AS STALLED IS MECHANICAL, NOT A JUDGEMENT ───────────────
 *
 * Spec: "Every conversation that stalls, on a mechanical test: the last turn
 * is a bot turn and no human ever picked it up… Nothing about the lead's
 * status enters into it — an ordinary lead that goes quiet mid-conversation
 * is the normal case, not an edge case."
 *
 * And Kate's own carve-out, which is the harder half: silence is only a stall
 * if the flow was left INCOMPLETE. A conversation that reached a proper
 * ending is not stalled — a decline (A17), an opt-out that stayed out (A24),
 * a failed service-area check (A2), a park with a named time (A40), or a
 * request to be called (A25's phone branch). She flagged on 2026-09-18 that
 * "A DECLINE IS NOT ALWAYS WORDED AS ONE… a keyword sweep for this missed
 * exactly that one", which is why this reads the ENDING INTENT rather than
 * pattern-matching the customer's last message.
 *
 * ── THIS IS NOT THE CAMPAIGN WE ALREADY SEND ────────────────────────────
 *
 * Spec, and it is underlined: "The follow-ups configured at day 1 and day 3,
 * both at 10 AM, are steps 3 and 4 of the Leads Master Campaign, which chases
 * someone who has never replied at all. Different population — leave those
 * steps as they are." Confirmed by reading Hatch on 2026-09-26: the campaign
 * sequence and the bot's stall rule are two separate mechanisms there too.
 *
 * Pure. The caller supplies the clock and does the reading and writing.
 */
import { sendingWindow, nextWindowOpen, OFFICE_ZONE } from "./sending-window";
import { blocked, type UnreachableWindow } from "./reachability";
import { localHour } from "./compliance";

/**
 * 10 AM, 3 PM, 6 PM — the customer's own clock, one per day.
 *
 * Spec: "The three stall follow-ups go out at 10 AM, 3 PM and 6 PM the
 * customer's local time", "one a day". So follow-up 1 lands the next day at
 * 10, follow-up 2 the day after at 15, follow-up 3 the day after that at 18.
 */
export const FOLLOW_UP_HOURS = [10, 15, 18] as const;

/** How many follow-ups a stalled conversation gets. Three, then hand back. */
export const FOLLOW_UP_COUNT = FOLLOW_UP_HOURS.length;

/**
 * A STALL AND A PARK ARE NOT THE SAME SILENCE, AND GET DIFFERENT CADENCES.
 *
 * Kate, 2026-09-28, answering the one question that was blocking:
 *
 *   "I think a parking cadence would make sense here because the CC has a
 *    varied approach and the stalled convo cadence wouldn't kick in on
 *    these... Bare deferral — 'I'll get back to you', 'once I've spoken to
 *    my wife', 'not ready yet', 'still deciding on scope'. Follow up at 2-3
 *    days, three times, then notify the call centre it can resume calling.
 *    Your 3 days was right for the first nudge; the change is not declaring
 *    a stall straight after it."
 *
 * A stall is somebody who went quiet mid-answer: chase tomorrow, then daily.
 * A park is somebody who TOLD us they need time, and chasing them tomorrow is
 * the rudeness A40 exists to prevent.
 *
 * ── WHY THESE NUMBERS AND NOT [3, 6, 9] ─────────────────────────────────
 *
 * These are days after the SWEEP picks the conversation up, and the sweep
 * only sees it once it has been quiet for QUIET_HOURS_BEFORE_STALL — a day.
 * So on the customer's calendar:
 *
 *   day 0  they park
 *   day 1  the sweep sees it and queues the cadence
 *   day 3  first nudge      ← Kate's "3 days was right for the first nudge"
 *   day 6  second
 *   day 9  third, then the call centre is told it may resume calling
 *
 * Writing [3, 6, 9] here would put the first nudge on day four. The offset
 * belongs in the arithmetic rather than in a comment apologising for it.
 */
export const PARK_FOLLOW_UP_DAYS = [2, 5, 8] as const;

/** A stall is chased on consecutive days: tomorrow, then the two after. */
export const STALL_FOLLOW_UP_DAYS = [1, 2, 3] as const;

/**
 * Endings that mean the conversation finished rather than went quiet.
 *
 * Read as INTENTS rather than from the customer's words, because Kate's own
 * warning is that a decline is not always worded as one.
 */
const PROPER_ENDINGS = new Set<string>([
  "bailout",            // A17 — declined, or not the intended person
  "lost",               // chose another company
  "discard",            // not a real lead
  "area_not_serviced",  // A2 — the zip failed the service-area check
  "success",            // the flow completed
  "phone_pricing",      // off-site quote, flow completed
  "transferred",        // a person has it
]);

/**
 * AN ENDING THAT PROMISES A FOLLOW-UP AND SCHEDULES NOTHING IS NOT AN ENDING.
 *
 * `schedule_follow_up` used to sit in the set above, and that reproduced the
 * exact defect A40 was built to fix. Kate: "What has never once happened is
 * the bot coming back."
 *
 * Traced 2026-09-27. A customer who parks WITHOUT naming a time —
 * "let me check with my wife and get back to you", "I'll reach out when I'm
 * ready" — gets:
 *
 *   parkReopenAt(...) → null, because no day was named, so NO reminder row
 *   isStalled(...)    → false, because schedule_follow_up was a proper ending
 *
 * Neither path owns it, so nobody ever comes back. Naming a day worked fine;
 * it is precisely the customers who name none — the ones A40 is about — who
 * fell through. Verified against parkKind, parkReopenAt and isStalled together
 * rather than each on its own, which is why unit tests never saw it: each
 * function was behaving exactly as written.
 *
 * So it is now conditional. The caller answers one question: is anything
 * actually scheduled? A park that named a day has its re-open and is left
 * alone. One that scheduled nothing is chased by the cadence that already
 * exists, already obeys A36's hours and already honours A24.
 *
 * Hatch does the same thing by a different route: its no-time park ends as
 * Schedule Follow Up and falls to the Conversation Rule — "Wait 5 hours /
 * 1 attempt / Stalled / Only in business hours". One mechanism, not a second
 * timer invented for this case.
 */
const PROMISES_A_FOLLOW_UP = "schedule_follow_up";

/**
 * Is this conversation stalled?
 *
 * `lastTurnWasBot` and `everHadHuman` are the mechanical test the spec
 * names. `lastIntent` carries the carve-out: a conversation that ended
 * properly is not stalled however quiet it has gone since.
 */
export function isStalled(input: {
  lastTurnWasBot: boolean;
  everHadHuman: boolean;
  lastIntent?: string | null;
  /** Already suppressed — never chase somebody who opted out (A24). */
  suppressed?: boolean;
  /**
   * True when the conversation ended promising a follow-up and NOTHING is
   * queued to deliver it — no park re-open, no cadence. Only consulted for
   * `schedule_follow_up`; see PROMISES_A_FOLLOW_UP.
   */
  nothingScheduled?: boolean;
}): boolean {
  if (input.suppressed) return false;
  if (!input.lastTurnWasBot) return false;
  if (input.everHadHuman) return false;
  if (input.lastIntent && PROPER_ENDINGS.has(input.lastIntent)) return false;
  /**
   * The park branch. Left alone when something IS scheduled — the re-open owns
   * it — and chased when nothing is, because then no other mechanism will.
   */
  if (input.lastIntent === PROMISES_A_FOLLOW_UP) return !input.nothingScheduled ? false : true;
  return true;
}

/**
 * Move an instant to one the rules actually allow.
 *
 * Two constraints, and they can both push:
 *
 *   A36's outbound hours, which BEAT the 10/3/6 pattern. Spec: "A text is not
 *   exempt: 6 PM Pacific is 9 PM Eastern and past the close, and Saturday
 *   6 PM is past Saturday's close. The third follow-up landing EARLIER for
 *   Pacific and Mountain customers is correct, not a gap."
 *
 *   A window the customer said they cannot be reached in (A44's stated
 *   constraint, parsed by reachability.ts). It does not expire and it binds
 *   the whole cadence.
 *
 * So when the target is shut, this looks BACKWARDS first — the same day, for
 * the latest allowed moment before it — and only falls forward when the day
 * offers nothing. That is what makes the Pacific case land earlier rather
 * than slipping to tomorrow, which would collapse "one a day".
 */
export function shiftIntoWindow(input: {
  target: Date;
  customerZone: string;
  officeZone?: string;
  unreachable?: UnreachableWindow | null;
}): Date | null {
  const officeZone = input.officeZone ?? OFFICE_ZONE;
  const allowed = (at: Date) => {
    if (!sendingWindow({ now: at, customerZone: input.customerZone, officeZone }).open) return false;
    const h = localHour(at, input.customerZone);
    if (h === null) return false;
    return !blocked(h, input.unreachable);
  };

  if (allowed(input.target)) return input.target;

  // Backwards, same day, in quarter hours. The spec wants earlier, not later.
  const back = new Date(input.target.getTime());
  for (let i = 0; i < 4 * 12; i++) {           // up to twelve hours earlier
    back.setUTCMinutes(back.getUTCMinutes() - 15);
    if (sameLocalDay(back, input.target, input.customerZone) && allowed(back)) return back;
    if (!sameLocalDay(back, input.target, input.customerZone)) break;
  }

  // Nothing earlier that day. Fall forward to the next moment that is open.
  const fwd = nextWindowOpen({ now: input.target, customerZone: input.customerZone, officeZone });
  if (!fwd) return null;
  if (allowed(fwd)) return fwd;
  // The customer's own unreachable window can still block the next opening;
  // step through the day until something clears it.
  const c = new Date(fwd.getTime());
  for (let i = 0; i < 4 * 24; i++) {
    c.setUTCMinutes(c.getUTCMinutes() + 15);
    if (allowed(c)) return c;
  }
  return null;
}

function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const f = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    } catch { return ""; }
  };
  const fa = f(a);
  return fa !== "" && fa === f(b);
}

/**
 * The three instants this conversation's follow-ups should go out.
 *
 * `from` is when it went quiet. Day 1 is the NEXT local day, so a
 * conversation that stalls at 4 PM does not get chased at 6 PM the same
 * evening — "one a day" starts tomorrow.
 *
 * An instant that cannot be placed at all comes back null and is dropped
 * rather than guessed at; the caller sends fewer follow-ups instead of
 * sending one at a time nobody allowed.
 */
export function followUpSchedule(input: {
  from: Date;
  customerZone: string;
  officeZone?: string;
  unreachable?: UnreachableWindow | null;
  /**
   * THE CADENCE RUNS FORWARD FROM HERE, WHATEVER `from` SAYS.
   *
   * Caught on 2026-09-26 by dry-running the sweep against production before
   * the deploy landed. Six live conversations had gone quiet twenty-five days
   * earlier, so "the day after it went quiet" was the 1st of September — and
   * all NINE follow-ups came out dated in the past. Every one would have been
   * immediately due, the scheduler would have claimed them on the next tick,
   * and three agent turns per conversation would have gone out back to back
   * in a single minute. Exactly what "one a day" exists to prevent, and it
   * would have looked like the feature working.
   *
   * `from` still anchors the LOCAL DAY so a conversation that went quiet this
   * afternoon is not chased this evening. This only stops the anchor being
   * historical. Defaults to `from`, which is the old behaviour, so a caller
   * that genuinely wants a backdated cadence can still ask for one.
   */
  notBefore?: Date;
  /**
   * How many days after the anchor each follow-up lands.
   *
   * Defaults to the stall cadence. A park passes PARK_FOLLOW_UP_DAYS, which
   * is the whole difference between the two — same three messages, same
   * hours, same ending, spaced for somebody who asked for time rather than
   * somebody who went quiet.
   */
  days?: readonly number[];
}): Date[] {
  const anchor = input.notBefore && input.notBefore.getTime() > input.from.getTime()
    ? input.notBefore
    : input.from;
  const days = input.days ?? STALL_FOLLOW_UP_DAYS;
  const out: Date[] = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const target = atLocalHour(anchor, input.customerZone, day, FOLLOW_UP_HOURS[i]);
    if (!target) continue;
    const placed = shiftIntoWindow({
      target, customerZone: input.customerZone,
      officeZone: input.officeZone, unreachable: input.unreachable,
    });
    if (placed) out.push(placed);
  }
  return out;
}

/**
 * The instant that is `daysAhead` local days after `from`, at `hour` local.
 *
 * Built by stepping in UTC and reading the local clock back, rather than
 * adding 24h — a DST day is 23 or 25 hours long, and the cadence would drift
 * an hour twice a year otherwise.
 */
function atLocalHour(from: Date, timeZone: string, daysAhead: number, hour: number): Date | null {
  const startDay = localDay(from, timeZone);
  if (!startDay) return null;
  const c = new Date(from.getTime());
  c.setUTCMinutes(0, 0, 0);
  // Walk forward in hours until the local calendar day has advanced enough
  // AND the local hour is the one we want.
  for (let i = 0; i < 24 * (daysAhead + 3); i++) {
    c.setUTCHours(c.getUTCHours() + 1);
    const d = localDay(c, timeZone);
    if (!d) return null;
    if (daysBetween(startDay, d) === daysAhead && localHour(c, timeZone) === hour) {
      return new Date(c.getTime());
    }
  }
  return null;
}

function localDay(d: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch { return null; }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
