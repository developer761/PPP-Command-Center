/**
 * The colour deadline sentence the customer reads — on the form and in the
 * email, from ONE function so the two can never drift.
 *
 * Kate, 2026-09-04, gave the wording exactly:
 *
 *   "Deadline for submitting colors is [DEADLINE]. You have until 24 hours
 *    before the start date to submit edits."
 *
 *   [DEADLINE] = the deadline set by the sender of the customer form,
 *                falling back to "24 hours before the start date".
 *
 * Taken literally, the fallback makes the two sentences say the same thing:
 * "Deadline for submitting colors is 24 hours before the start date. You have
 * until 24 hours before the start date to submit edits." So when there is no
 * sender deadline the two collapse into one sentence. Same promise, said once.
 *
 * Pure and date-only on purpose. A calendar date is not an instant: anchoring
 * "2026-08-20" to a hardcoded EST offset and formatting in America/New_York
 * rendered it as August 21 through EDT, which is a bug this codebase has
 * already had once (see formatEditDeadline). The numbers are formatted
 * directly — no instant, no timezone, no chance of sliding a day.
 */

/**
 * The regex proves the SHAPE, not that the date exists — "2026-13-45" matches
 * it happily, sorts after today as a string, and formats into a nonsense date
 * for a customer to read. Round-trip through UTC and require the parts to come
 * back unchanged, which rejects month 13, day 45, and Feb 30 alike.
 */
function isRealDate(ymd: RegExpExecArray): boolean {
  const [, y, m, d] = ymd;
  const year = Number(y), month = Number(m), day = Number(d);
  const dt = new Date(Date.UTC(year, month - 1, day, 12));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/** Wording for the edit window, reused in both branches. */
const EDIT_WINDOW = "24 hours before the start date";

export type DeadlineNotice = {
  /** The full sentence(s) to display. Never empty. */
  text: string;
  /** True when a real date is named, i.e. the sender set one and it hasn't
   *  passed. Callers can use this to decide emphasis. */
  hasExplicitDate: boolean;
};

/**
 * @param senderDeadline `customer_form_tokens.color_deadline` — a YYYY-MM-DD
 *        date the sender promised, or null.
 * @param todayEt        Injectable "today" in PPP's timezone (YYYY-MM-DD), so
 *        the past-date rule is testable without freezing the clock.
 */
export function colorDeadlineNotice(
  senderDeadline?: string | null,
  todayEt: string = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })
): DeadlineNotice {
  const promised = (senderDeadline ?? "").trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(promised);

  // A deadline that has already passed is worse than no deadline — it tells the
  // customer they are too late when they are not (migration 147's own note:
  // "regularly shown a deadline that has already expired"). Fall back instead.
  if (ymd && promised >= todayEt && isRealDate(ymd)) {
    const [, y, m, d] = ymd;
    let label: string;
    try {
      label = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12)));
    } catch {
      label = promised;
    }
    return {
      text: `Deadline for submitting colors is ${label}. You have until ${EDIT_WINDOW} to submit edits.`,
      hasExplicitDate: true,
    };
  }

  return {
    text: `Deadline for submitting colors is ${EDIT_WINDOW}, and you have until then to submit edits.`,
    hasExplicitDate: false,
  };
}
