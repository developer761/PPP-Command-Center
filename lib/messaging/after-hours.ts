/**
 * Telling somebody who texts out of hours that we will be in touch.
 *
 * The toggle and the message field have been on the Settings screen since
 * workspace hours were built — saved by the form, read back into the form, and
 * consumed by absolutely nothing. Two other screens advertise "after-hours
 * replies" as a working feature. A customer texting at 10pm got silence.
 *
 * THE CONFLICT THIS RESOLVES. An after-hours reply is, by definition, a
 * message sent outside the workspace's sending hours — which the gate refuses.
 * Karan chose the middle line on 2026-09-22: answer inside the FEDERAL window
 * (8am-9pm local), stay silent from 9pm to 8am, and never send more than one
 * per person per day. The workspace hours exist so PPP does not START
 * conversations at odd times; somebody who texted at 8:30pm has started one,
 * and answering them is not soliciting them. See SendRequest.answersInbound,
 * which is the only concession in the gate and does not touch anything else.
 *
 * Pure. The caller does the reading and writing.
 */
import { withinQuietHours, FEDERAL_BOUND, type QuietHours } from "./compliance";

/** Marks the message, so "once a day" can be counted without a new column. */
export const AFTER_HOURS_INTENT = "after_hours";

export type AfterHoursWorkspace = {
  after_hours_autoreply?: boolean | null;
  after_hours_message?: string | null;
  time_zone?: string | null;
  quiet_hours_start?: number | null;
  quiet_hours_end?: number | null;
};

export type AfterHoursDecision =
  | { send: false; why: string }
  | { send: true; body: string };

/**
 * Should this inbound message get an out-of-hours reply?
 *
 * `alreadySentToday` is the caller's count of auto-replies already sent on
 * this conversation in the last 24 hours. One is the cap: somebody texting
 * five times at midnight is having a conversation with themselves, and five
 * identical "we are closed" replies is worse than none.
 */
export function afterHoursReply(input: {
  workspace: AfterHoursWorkspace;
  now: Date;
  alreadySentToday: number;
  /** STOP and HELP are answered elsewhere and must never get this instead. */
  keyword: "opt_out" | "opt_in" | "help" | null;
}): AfterHoursDecision {
  const ws = input.workspace;
  if (!ws.after_hours_autoreply) return { send: false, why: "not switched on for this workspace" };

  const body = (ws.after_hours_message ?? "").trim();
  if (!body) return { send: false, why: "no after-hours message has been written" };

  // Somebody saying STOP gets suppressed, not chatted to; HELP has its own
  // legally required reply. Neither is an out-of-hours enquiry.
  if (input.keyword) return { send: false, why: `${input.keyword} is answered on its own path` };

  if (input.alreadySentToday > 0) return { send: false, why: "already sent one today" };

  const tz = ws.time_zone;
  if (!tz) return { send: false, why: "the workspace has no timezone, so there is no such thing as out of hours" };

  const hours: QuietHours = {
    startHour: ws.quiet_hours_start ?? 9,
    endHour: ws.quiet_hours_end ?? 20,
  };

  // IN hours means the ordinary flow answers them. This is only for the gap.
  if (withinQuietHours(input.now, tz, hours)) {
    return { send: false, why: "the office is open, so the ordinary reply covers it" };
  }

  // Out of hours, but still the middle of the night. Silence is correct: they
  // will get a real answer when the agent turn runs in the morning.
  if (!withinQuietHours(input.now, tz, { ...FEDERAL_BOUND })) {
    return { send: false, why: "outside the 8am-9pm federal window" };
  }

  return { send: true, body };
}
