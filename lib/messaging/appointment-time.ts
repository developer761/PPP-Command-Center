/**
 * WHEN THE CUSTOMER NAMES A TIME.
 *
 * Three behaviours Hatch has and we did not, found by reading its live prompt
 * on 2026-09-26 (HATCH_PARITY_GAPS.md, gaps 2-4). None is in the Iteration 1
 * spec, and all three are the likeliest way we produce a visibly wrong
 * message to a real customer.
 *
 * ── 1. A BARE HOUR IS AMBIGUOUS, AND HATCH RESOLVES IT ──────────────────
 *
 * Its prompt: "Assume times between 8 and 11 are AM and 12 to 7 are PM."
 *
 * Without that, "3 works" is 3am to anything reading it. Nothing downstream
 * asks the customer which they meant, so the ambiguity survives all the way
 * to whoever reads the appointment.
 *
 * ── 2. A REQUESTED TIME MUST NOT BE CONFIRMED ───────────────────────────
 *
 * Its prompt: "If they ask for a specific time within business hours… Do not
 * restate or confirm their time → Reply: 'I'll check the calendar for that
 * time.' → Then continue the flow normally."
 *
 * This is the likeliest A15 breach in the whole system. A customer says
 * "how about Tuesday at 2?" and the natural, helpful-sounding reply is
 * "Tuesday at 2 works!" — which invents an appointment nobody booked. A15
 * already refuses that at the validator; what was missing is the RIGHT thing
 * to say instead, so the model is not left choosing.
 *
 * ── 3. OUT OF HOURS, REDIRECT RATHER THAN REFUSE ────────────────────────
 *
 * Its prompt gives a line for each side of the day. We do not copy the
 * wording, because Hatch contradicts itself: the prompt says the latest slot
 * is 5 PM and its own FAQ says 6 PM, in the same agent. See
 * QUESTIONS_FOR_KATE. What is built here is the SHAPE — too early, too late,
 * or fine — and the wording stays ours until she settles the hours.
 *
 * Pure.
 */

/**
 * The hour a bare number means, per Hatch's rule.
 *
 * 8, 9, 10, 11  -> morning
 * 12, 1 … 7     -> afternoon or evening
 *
 * Deliberately NOT applied to a number the customer already qualified: "8pm"
 * is 8pm, and "at 8 in the morning" is 8am. This only resolves a bare one.
 */
export function resolveBareHour(hour: number): number | null {
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
  if (hour >= 8 && hour <= 11) return hour;          // morning
  if (hour === 12) return 12;                        // noon
  return hour + 12;                                  // 1-7 -> 13-19
}

export type RequestedTime = {
  /** 0-23, the customer's own clock. */
  hour: number;
  minute: number;
  /** True when they said am/pm and we did not have to assume. */
  explicit: boolean;
};

/**
 * A specific clock time in what the customer wrote, or null.
 *
 * Timid in the usual direction: a number that is not clearly a time is left
 * alone. "4821 Oak Lane" must never read as 48:21, and "2 rooms" is not 2pm.
 * So a bare number needs a time-ish preposition in front of it — "at 2",
 * "around 3", "by 10" — or an explicit am/pm, or a colon.
 */
export function requestedTime(text: string | null | undefined): RequestedTime | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;

  // "2:30pm", "10:15", "2 pm", "2pm"
  const withMeridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/.exec(t);
  if (withMeridiem) {
    let h = Number(withMeridiem[1]);
    const m = Number(withMeridiem[2] ?? 0);
    if (h < 1 || h > 12 || m > 59) return null;
    const pm = withMeridiem[3].startsWith("p");
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { hour: h, minute: m, explicit: true };
  }

  // "at 2:30", "around 10:15" — a colon makes it a time without am/pm.
  const withColon = /\b(?:at|around|by|after|before)?\s*(\d{1,2}):(\d{2})\b/.exec(t);
  if (withColon) {
    const h = Number(withColon[1]);
    const m = Number(withColon[2]);
    if (h > 23 || m > 59) return null;
    // 13:00 and up are already unambiguous.
    const resolved = h > 12 ? h : resolveBareHour(h);
    if (resolved === null) return null;
    return { hour: resolved, minute: m, explicit: h > 12 };
  }

  // A BARE HOUR, and only with a time preposition. "in the morning" and "in
  // the afternoon" qualify it, so those are read too.
  const bare = /\b(?:at|around|by)\s+(\d{1,2})\b(?!\s*(?:rooms?|beds?|baths?|cars?|doors?|windows?|sq|square|feet|ft|\d))/.exec(t);
  if (bare) {
    const h = Number(bare[1]);
    if (h < 1 || h > 12) return null;
    const morning = /\b(?:in the )?morning\b|\bam\b/.test(t);
    const evening = /\b(?:in the )?(?:afternoon|evening)\b|\bpm\b/.test(t);
    if (morning && !evening) return { hour: h === 12 ? 0 : h, minute: 0, explicit: true };
    if (evening && !morning) return { hour: h === 12 ? 12 : h + 12, minute: 0, explicit: true };
    const resolved = resolveBareHour(h);
    if (resolved === null) return null;
    return { hour: resolved, minute: 0, explicit: false };
  }

  return null;
}

export type SlotVerdict =
  /** Inside the appointment day. Hold it, never confirm it. */
  | "in_hours"
  /** Before the first slot. */
  | "too_early"
  /** After the last slot. */
  | "too_late";

/**
 * THE APPOINTMENT DAY IS NOT THE MESSAGING WINDOW.
 *
 * A36's callback window governs when the bot may SEND. This is when an
 * estimator can VISIT, which is a different thing and a narrower one — Hatch
 * runs them together and that is part of why its hours contradict each other.
 *
 * The values below are Hatch's prompt ("Our earliest slot is usually 10 AM"
 * / "Our latest slot is usually 5 PM"), and they are the half of the
 * contradiction that is stated twice rather than once. Its FAQ says 6 PM.
 * Kate has not settled it, so these are named constants in one place and the
 * answer is one edit when she does.
 */
export const FIRST_SLOT_HOUR = 10;
export const LAST_SLOT_HOUR = 17;

export function slotVerdict(t: RequestedTime): SlotVerdict {
  if (t.hour < FIRST_SLOT_HOUR) return "too_early";
  if (t.hour > LAST_SLOT_HOUR || (t.hour === LAST_SLOT_HOUR && t.minute > 0)) return "too_late";
  return "in_hours";
}

/**
 * What to say about a time the customer asked for.
 *
 * `null` means they named no time and this rule has nothing to say.
 *
 * NONE OF THESE RESTATE THE TIME. Hatch says it twice — "Do not restate or
 * confirm their time", "Don't thank them" — and it is the whole point: a
 * reply that repeats the time back reads as agreement, and A15 forbids
 * agreeing to a slot nobody checked.
 */
export function replyToRequestedTime(
  text: string | null | undefined
): { verdict: SlotVerdict; reply: string } | null {
  const t = requestedTime(text);
  if (!t) return null;
  const verdict = slotVerdict(t);

  if (verdict === "in_hours") {
    // Holds the moment without promising it. The flow carries on after.
    return { verdict, reply: "I'll check the calendar for that time." };
  }
  if (verdict === "too_early") {
    return {
      verdict,
      reply: `Our earliest visit is usually ${hour12(FIRST_SLOT_HOUR)}, though I can ask about earlier or a Saturday. What works best for you?`,
    };
  }
  return {
    verdict,
    reply: `Our latest visit is usually ${hour12(LAST_SLOT_HOUR)}, though I can ask about later or a Saturday. What works best for you?`,
  };
}

function hour12(h: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const n = h % 12 === 0 ? 12 : h % 12;
  return `${n} ${suffix}`;
}
