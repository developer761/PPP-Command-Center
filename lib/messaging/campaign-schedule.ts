/**
 * When each step of a campaign should go out.
 *
 * Three modes, taken from what Hatch's sequences actually do:
 *
 *   at_launch         the opener, the moment somebody enters
 *   delay_after_last  "two days after the last one"
 *   absolute_on_day   "day 5 at 10am", regardless of when the previous went
 *
 * Pure, and the clock is passed in — a schedule that cannot be computed for an
 * arbitrary "now" cannot be tested for the cases that matter, which are all
 * about boundaries.
 *
 * WHAT THIS DOES NOT DO: quiet hours, weekends, the daily cap. Those are the
 * gate's, applied when the message is actually sent. A scheduler that also
 * tried to avoid them would be a second implementation of the rules that
 * decide whether a message is allowed to exist, and the two would drift.
 * Scheduling something for 2am is fine; the gate will hold it until 9.
 */

export type ScheduleMode = "at_launch" | "delay_after_last" | "absolute_on_day";

export type CampaignStep = {
  ordinal: number;
  scheduleMode: ScheduleMode;
  delayMinutes: number | null;
  dayOffset: number | null;
  /** "HH:MM" or "HH:MM:SS" in the workspace's own timezone. */
  timeOfDay: string | null;
  channel: "sms" | "email";
  body: string;
  subject: string | null;
};

export type ScheduledStep = { ordinal: number; runAt: Date };

/** Minutes past midnight, or null when the string is not a time. */
export function parseTimeOfDay(t: string | null): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The offset between UTC and a timezone at a given instant, in minutes.
 *
 * Worked out by asking Intl what the local time is and comparing, rather than
 * assuming a fixed offset — New York is four hours behind in July and five in
 * January, and a campaign scheduled across that boundary would otherwise send
 * an hour out for half the year.
 */
function offsetMinutes(at: Date, timeZone: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second)
    );
    return (asUtc - at.getTime()) / 60_000;
  } catch {
    return null;
  }
}

/** A specific local time, N days after a start, as an instant. */
export function localTimeOnDay(
  start: Date, dayOffset: number, minutesPastMidnight: number, timeZone: string
): Date {
  const off = offsetMinutes(start, timeZone) ?? 0;
  // Midnight local on the start day, expressed in UTC.
  const local = new Date(start.getTime() + off * 60_000);
  const midnightLocalAsUtc = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()
  );
  const target = new Date(midnightLocalAsUtc + (dayOffset * 86_400_000) + minutesPastMidnight * 60_000);
  // Re-read the offset AT the target: a step five days out can land the other
  // side of a daylight-saving change from the day it was scheduled on.
  const targetOff = offsetMinutes(target, timeZone) ?? off;
  return new Date(target.getTime() - targetOff * 60_000);
}

/**
 * Turn a campaign's steps into instants.
 *
 * Steps are cumulative: delay_after_last stacks on whatever the previous step
 * resolved to, which is why this returns the whole sequence rather than
 * answering one step at a time.
 */
export function scheduleSteps(
  steps: CampaignStep[], enrolledAt: Date, timeZone: string
): ScheduledStep[] {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const out: ScheduledStep[] = [];
  let last = enrolledAt;

  for (const step of ordered) {
    let runAt: Date;
    switch (step.scheduleMode) {
      case "at_launch":
        runAt = enrolledAt;
        break;
      case "delay_after_last":
        runAt = new Date(last.getTime() + (step.delayMinutes ?? 0) * 60_000);
        break;
      case "absolute_on_day": {
        const mins = parseTimeOfDay(step.timeOfDay);
        if (mins === null) {
          // An unreadable time would otherwise schedule at midnight, which is
          // the one hour the gate will not send in — the step would sit
          // deferred until 9am and look broken. Falling back to the previous
          // step keeps the sequence intact and visible.
          runAt = last;
          break;
        }
        runAt = localTimeOnDay(enrolledAt, step.dayOffset ?? 0, mins, timeZone);
        break;
      }
    }
    // Never earlier than the step before it. A day-5-at-9am step behind a
    // day-6 delay would otherwise arrive out of order.
    if (runAt < last) runAt = last;
    out.push({ ordinal: step.ordinal, runAt });
    last = runAt;
  }
  return out;
}
