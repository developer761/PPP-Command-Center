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
import { fillNextOpen } from "./next-open";

/** Marks the message, so "once a day" can be counted without a new column. */
export const AFTER_HOURS_INTENT = "after_hours";

/**
 * WHAT IT SAYS WHEN NOBODY HAS WRITTEN ANYTHING.
 *
 * Checked against production 2026-10-06: `after_hours_message` is NULL on all
 * 33 workspaces and the toggle is false on all 33. The feature has never done
 * anything, while two screens advertise it as working.
 *
 * Needing somebody to type a sentence into every workspace before the feature
 * exists at all is why. Settings already shows this exact wording as a
 * PLACEHOLDER — a suggestion nobody can act on thirty-three times — so it
 * becomes the default and the box becomes an override.
 *
 * Switching the TOGGLE on is deliberately NOT done here. All 33 read false
 * rather than null, so "never configured" and "turned off on purpose" are
 * indistinguishable, and a code change that ignored the setting would make
 * the switch mean nothing. That one is a decision with sending attached to it.
 *
 * Bounded by design: one message, no price, no appointment time, and
 * {{next_open}} resolves against the same function the gate uses, so the hour
 * it promises is the hour the system will act.
 *
 * No em dash. A23 bans it and this is customer-facing.
 */
export const DEFAULT_AFTER_HOURS_MESSAGE =
  "Thanks for reaching out! Our office is closed right now, but we'll pick "
  + "this up and get back to you after we open at {{next_open}}.";

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
  /**
   * The recipient's IANA zone, from customerZone(). Needed only when the
   * message uses the {{next_open}} merge field, and then it decides whose
   * clock the promised hour is on — see next-open.ts.
   */
  customerZone?: string | null;
}): AfterHoursDecision {
  const ws = input.workspace;
  if (!ws.after_hours_autoreply) return { send: false, why: "not switched on for this workspace" };

  // An empty box is "nobody has written one", not "say nothing". Switching the
  // feature on and getting silence because a second field was left blank is
  // the trap this removes; see DEFAULT_AFTER_HOURS_MESSAGE.
  const body = (ws.after_hours_message ?? "").trim() || DEFAULT_AFTER_HOURS_MESSAGE;

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

  /**
   * LAST, and after every other refusal, so a workspace that was never going
   * to send does not get an error about a merge field.
   *
   * This is also where "we open at ___" stops being a sentence somebody typed
   * and starts being a fact resolved from the same window the gate enforces.
   * An unresolved token refuses the whole reply rather than sending a text
   * with `{{next_open}}` in it — see fillNextOpen for why silence beats all
   * three alternatives.
   */
  const filled = fillNextOpen({
    body,
    now: input.now,
    // The customer's zone when we know it. Empty string rather than a guess:
    // fillNextOpen reads that as "unknown" and labels the hour ET.
    customerZone: input.customerZone ?? "",
    officeHours: hours,
  });
  if (!filled.ok) return { send: false, why: filled.why };

  return { send: true, body: filled.body };
}
