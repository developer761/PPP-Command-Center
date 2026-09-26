/**
 * How long Emily waits before replying.
 *
 * A reply that arrives the instant a customer hits send reads as a machine.
 * A couple of minutes reads as somebody who picked up their phone. This is the
 * whole of that decision, kept pure so it can be tested without a database, a
 * clock or a carrier.
 *
 * WHY A RANGE. A fixed delay is its own tell: every gap identical to the
 * second, forever. One is drawn per turn from between the bounds.
 *
 * WHY IT DOES NOT APPLY WHEN AUTOSEND IS OFF. With a person approving each
 * reply, the gap the customer experiences is however long review takes, and
 * that is already far longer than any delay set here. Delaying the draft would
 * only mean the reviewer sees it later — the customer waits no less, and the
 * queue moves slower. The caller decides that; this module is told.
 *
 * THE DELAY IS TIME TO DELIVERY. Karan, 2026-09-15: Emily should answer 30
 * seconds to a minute and a half after the customer's text. It used to delay
 * when the turn STARTED, so writing the reply and waiting for the next tick
 * came on top, and "90 seconds" could be two minutes. Now the turn is queued
 * at once, the reply is written on the next tick and held, and it goes at
 * replyDueAt: a moment drawn from the range, measured from the customer's
 * message, less one tick so the tick that picks it up still lands inside it.
 */
import { sendingWindow } from "./sending-window";

/** Same bound the database CHECK enforces. Thirty minutes. */
export const MAX_DELAY_SECONDS = 1800;

/** What every workspace starts with. Karan, 2026-09-15. */
export const DEFAULT_DELAY = { minSeconds: 30, maxSeconds: 90 } as const;

/**
 * How often the scheduler runs. PPP moved to Vercel Pro on 2026-09-15, whose
 * crons run at most once a minute (vercel.json: "* * * * *"), so this is 60.
 *
 * A held reply waits up to one tick past its moment before a tick picks it up,
 * so the moment is drawn one tick short of the top of the range. At 60 that
 * collapses a 30-90 range to "due at 30, delivered whenever the next tick
 * fires": still 30-90 seconds after the text, with the spread coming from
 * where the text lands in the minute rather than from the draw. A faster
 * trigger — the same route called every 10 seconds — would restore the drawn
 * spread and tighten everything else; nothing else would need to change.
 */
export const TICK_SECONDS = 60;

/**
 * When Emily starts writing, after the customer's text.
 *
 * Zero: the turn is queued immediately and written by the next tick, so the
 * reply exists before its moment comes. It was 15 seconds when the tick ran
 * every 10; at a minute that only risked writing the reply after it was due.
 *
 * A burst of texts still gets ONE answer: they are all in the queue by the
 * time the tick runs, and a held reply answering an older message is dropped
 * when a newer one exists (scheduler-db.ts).
 */
export const TURN_START_SECONDS = 0;

export type DelayConfig = { minSeconds: number; maxSeconds: number };

/** Both at zero: reply as soon as the turn is ready. */
export function isDelayOff(c: DelayConfig): boolean {
  return c.maxSeconds <= 0;
}

/**
 * Draw one delay from the range.
 *
 * `rand` is injected so a test can pin the draw. Inclusive of both bounds:
 * a range of 120–300 must be able to produce exactly 120 and exactly 300, or
 * the range a person typed is not the range they get.
 */
export function pickDelaySeconds(c: DelayConfig, rand: () => number = Math.random): number {
  if (isDelayOff(c)) return 0;
  const min = Math.max(0, Math.min(c.minSeconds, c.maxSeconds));
  const max = Math.min(MAX_DELAY_SECONDS, Math.max(c.minSeconds, c.maxSeconds));
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * When the turn should run.
 *
 * THE ONE CASE THAT IS NOT JUST now + delay. The gate refuses a send outside
 * quiet hours and reschedules it to the next morning. So a message arriving at
 * 8:58pm, which today gets an answer at 8:58pm, would with a five-minute delay
 * be attempted at 9:03pm, refused, and answered at 8am tomorrow. A delay meant
 * to make the bot feel human would have quietly converted a same-evening reply
 * into a next-day one, for the leads most likely to go elsewhere overnight.
 *
 * So the delay never carries a reply across that boundary: if we can answer
 * now and the delayed time cannot, the delay is dropped for this turn.
 */
export function delayedRunAt(input: {
  now: Date;
  config: DelayConfig;
  /** PPP's own zone, for the office side of A36. */
  timeZone: string;
  /** The RECIPIENT's zone, which is the one the legal window is read in. */
  customerZone: string;
  rand?: () => number;
}): Date {
  const { now, config, timeZone, customerZone } = input;
  if (isDelayOff(config)) return now;

  const seconds = pickDelaySeconds(config, input.rand);
  if (seconds <= 0) return now;

  const candidate = new Date(now.getTime() + seconds * 1000);

  // ASKED OF THE SAME FUNCTION THE GATE WILL ASK.
  //
  // This used to call withinQuietHours against the WORKSPACE's timezone and
  // the WORKSPACE's 9-8 hours. The gate sends a held reply with
  // answersInbound, which means the federal 8am-9pm on the CUSTOMER's clock —
  // so the boundary being protected here was not the boundary that would
  // actually refuse the message.
  //
  // It failed in the direction that costs a lead: somebody texting at 8:58pm
  // reads as out-of-hours on the workspace's 9-8, so the delay was applied,
  // the send was attempted at 9:03pm, the gate refused it against the federal
  // 9pm, and a lead who texted just before nine was answered the next
  // morning. Precisely what this function exists to prevent, one hour later.
  const open = (at: Date) => sendingWindow({
    now: at, customerZone, officeZone: timeZone, answersInbound: true,
  }).open;
  if (open(now) && !open(candidate)) return now;

  return candidate;
}

/**
 * The moment a held reply should reach the customer, counted from their text.
 *
 * Drawn between min and (max - one tick), so that even a reply picked up a
 * full tick late lands inside the range somebody set. The quiet-hours rule is
 * delayedRunAt's: the delay never carries a reply past the evening cut-off.
 */
export function replyDueAt(input: {
  receivedAt: Date;
  config: DelayConfig;
  timeZone: string;
  customerZone: string;
  rand?: () => number;
}): Date {
  const { config } = input;
  if (isDelayOff(config)) return input.receivedAt;
  const top = Math.max(config.minSeconds, config.maxSeconds - TICK_SECONDS);
  return delayedRunAt({
    now: input.receivedAt,
    config: { minSeconds: config.minSeconds, maxSeconds: top },
    timeZone: input.timeZone,
    customerZone: input.customerZone,
    rand: input.rand,
  });
}

/**
 * What a person typed into the settings box, checked before it reaches a
 * constraint. The database refuses the same things; this says why in words.
 */
export function validateDelay(min: number, max: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    return "Use whole seconds.";
  }
  if (min < 0 || max < 0) return "A delay cannot be negative.";
  if (max > MAX_DELAY_SECONDS) {
    return `Thirty minutes is the most you can wait — past that a lead has gone cold.`;
  }
  if (max < min) {
    // An inverted window silently disabled a workspace once already.
    return "The longest wait has to be at least the shortest.";
  }
  return null;
}

/** "2–5 min", for a screen. */
export function describeDelay(c: DelayConfig): string {
  if (isDelayOff(c)) return "Replies straight away";
  const m = (s: number) =>
    s < 60 ? `${s}s` : s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60}s`;
  if (c.minSeconds === c.maxSeconds) return `Waits ${m(c.minSeconds)}`;
  return `Waits ${m(c.minSeconds)}–${m(c.maxSeconds)}`;
}
