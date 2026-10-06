/**
 * Days PPP does not text on.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * `send_on_holidays` has been a column on both sms_sub_accounts and
 * sms_campaigns since migration 179, which says in capitals: "Holidays default
 * OFF: a painting estimate chase on Thanksgiving morning reads badly even
 * where it is legal." It is false on all 33 workspaces and on the one
 * campaign.
 *
 * There was no holiday check anywhere, and no calendar. So the data said "we
 * do not text on holidays" everywhere, and the gate would have sent on
 * Christmas morning. Found 2026-10-06 by auditing for settings that are saved
 * and never read.
 *
 * ── IT IS ALSO KATE'S CONDITION ─────────────────────────────────────────
 *
 * Her answer on the event-park cadence, 2026-10-05, was conditional and the
 * condition is this file: "That sounds right AS LONG AS we have a mechanism
 * that keeps customers from being messaged on specific holidays and the msg
 * would send the following open day."
 *
 * Both halves matter. Not sending is the easy half; "the following open day"
 * is why the gate defers with a retryAt rather than refusing, exactly as the
 * weekend rule already does.
 *
 * ── WHICH DAYS, AND WHY NOT MORE ────────────────────────────────────────
 *
 * The federal holidays on which an unsolicited text about painting reads
 * badly. Deliberately NOT every federal holiday: Columbus Day and Presidents'
 * Day are ordinary working days for a contractor, and silence on them would
 * cost real leads for no gain.
 *
 * Christmas Eve is included though it is not federal, because it is the one
 * most people have actually stopped working on, and the migration's own
 * example is the day before a holiday morning.
 *
 * NO OBSERVED-DAY SHIFTING. Federal offices move Independence Day to the 3rd
 * when the 4th is a Saturday; people do not. The rule here is about whose
 * living room the phone is buzzing in, so it matches the real date. When a
 * holiday falls at a weekend the weekend rule covers it anyway.
 *
 * Pure. The caller supplies the clock and the zone.
 */

/** Y/M/D as they read on a wall clock in that zone, not the server's. */
function localParts(now: Date, timeZone: string): { y: number; m: number; d: number; dow: number } | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
    });
    const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
    const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
    if (!y || !m || !d || dow < 0) return null;
    return { y, m, d, dow };
  } catch {
    // An unusable zone is not a holiday. The gate has its own refusal for a
    // workspace with no timezone; inventing one here would hide it.
    return null;
  }
}

/** The date of the Nth given weekday in a month. nth = -1 means the last. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

/**
 * The holiday falling on this instant in this zone, by name, or null.
 *
 * Named rather than boolean so a refusal can say WHICH, which is the
 * difference between a log line somebody can act on and one they cannot.
 */
export function holidayIn(now: Date, timeZone: string): string | null {
  const p = localParts(now, timeZone);
  if (!p) return null;
  const { y, m, d } = p;

  if (m === 1 && d === 1) return "New Year's Day";
  if (m === 7 && d === 4) return "Independence Day";
  if (m === 12 && d === 24) return "Christmas Eve";
  if (m === 12 && d === 25) return "Christmas Day";
  // Last Monday in May.
  if (m === 5 && d === nthWeekday(y, 5, 1, -1)) return "Memorial Day";
  // First Monday in September.
  if (m === 9 && d === nthWeekday(y, 9, 1, 1)) return "Labor Day";
  // Fourth Thursday in November, and the Friday after it.
  if (m === 11) {
    const thanksgiving = nthWeekday(y, 11, 4, 4);
    if (d === thanksgiving) return "Thanksgiving";
    if (d === thanksgiving + 1) return "the day after Thanksgiving";
  }
  return null;
}

/** Convenience for the gate, which only needs the yes/no. */
export function isHolidayIn(now: Date, timeZone: string): boolean {
  return holidayIn(now, timeZone) !== null;
}
