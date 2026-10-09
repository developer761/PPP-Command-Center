"use server";

/**
 * Hours and timezone, per workspace.
 *
 * Karan asked for "a settings page for setting times and stuff". This is that,
 * and it needs one thing said clearly, because it looks like it contradicts
 * the Chatbot page:
 *
 *   The Chatbot page refuses to expose quiet hours, and that stands. What it
 *   refuses is letting the AGENT configure them — an agent or a campaign must
 *   not be able to widen its own sending window to reach somebody at 2am.
 *
 *   This is a different thing: an operator setting business hours for a
 *   workspace. That is legitimate and PPP already needs it, because the
 *   workspaces do not all keep the same hours.
 *
 * What makes it safe is that the law is not a setting. clampToFederal in
 * compliance.ts bounds every window to 8am-9pm local no matter what is stored
 * here, and it runs at SEND time rather than at save time — so a row edited
 * directly in the database, or one imported from Hatch with nonsense in it,
 * is still clamped on the way out.
 *
 * WHAT THIS USED TO SAY, AND WHY IT WAS WRONG. It said a wider window could be
 * SAVED and reported back as narrower, with the clamp doing the work at send
 * time. Two other things in this system disagree, and both of them win:
 *
 *   migration 178   CHECK (quiet_hours_start BETWEEN 8 AND 20) and end
 *                   BETWEEN 9 AND 21, under the heading "a campaign author
 *                   must not be able to configure their way past these"
 *   the form        its options stop at the federal bound, "so an illegal
 *                   window cannot be chosen at all rather than being
 *                   silently narrowed later"
 *
 * So saving 6am never worked. It reached Postgres and came back as
 * sms_sub_accounts_quiet_hours_start_check, which is the raw string this file
 * promises elsewhere that nobody at PPP should have to read — and the test
 * covering it passed because it stubs the database.
 *
 * The validation below now says the same thing the column says, in a
 * sentence. `clamped` went with it: every value that can now be saved is
 * already inside the federal bound, so it could only ever have been false,
 * and a flag that is always false is a sentence the UI can never show.
 */
import { messagingDb } from "./db";
import { clampToFederal, FEDERAL_BOUND } from "./compliance";
import { assertMessagingAccess } from "./auth";
import { validateDelay } from "./reply-delay";
import { validateReplyTo } from "./reply-to";

export type WorkspaceHours = {
  id: string;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  time_zone: string | null;
  send_on_weekends: boolean | null;
  send_on_holidays: boolean | null;
  after_hours_autoreply: boolean | null;
  after_hours_message: string | null;
};

const HOUR = (v: unknown): number | null => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : NaN;
};

export async function saveWorkspaceHours(input: {
  workspaceId: string;
  quietStart?: string | number | null;
  quietEnd?: string | number | null;
  timeZone?: string;
  sendOnWeekends?: boolean;
  /** US federal holidays, enforced by the gate. See lib/messaging/holidays.ts. */
  sendOnHolidays?: boolean;
  afterHoursAutoreply?: boolean;
  afterHoursMessage?: string;
  replyDelayMin?: number;
  replyDelayMax?: number;
  replyToEmail?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  await assertMessagingAccess();
  const start = HOUR(input.quietStart);
  const end = HOUR(input.quietEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { ok: false, error: "Hours must be whole numbers from 0 to 23." };
  }
  /**
   * THE BOUNDS THE COLUMN ACTUALLY HAS, in words.
   *
   * This file says of the reply-to address, two checks down: "Validated in
   * words here; the CHECK constraint refuses the same shapes, but with a
   * Postgres string nobody at PPP should have to read." The hours did not
   * follow their own rule. 0 to 23 was accepted here and the column allows
   * start 8-20 and end 9-21, so typing 7am got Kate
   *
   *   new row for relation "sms_sub_accounts" violates check constraint
   *   "sms_sub_accounts_quiet_hours_start_check"
   *
   * and clearing both boxes hit NOT NULL the same way — while the branch
   * below implied "or neither" was a thing she could do.
   *
   * The numbers are the federal bound: nothing may send before 8am or after
   * 9pm wherever the customer is, so a workspace window outside that could
   * only ever be a window the gate refuses.
   */
  /**
   * ONLY WHEN THE CALLER IS ACTUALLY SETTING THE HOURS.
   *
   * This action does partial updates — the timezone alone, the auto-reply
   * alone — and the patch below is built field by field for exactly that
   * reason. The first version of this check ran unconditionally, so saving a
   * timezone came back "both a start and an end are needed". Three existing
   * tests caught it, which is what they are for.
   */
  const settingHours = input.quietStart !== undefined || input.quietEnd !== undefined;
  if (settingHours && (start === null || end === null)) {
    return {
      ok: false,
      error: "Both a start and an end are needed — the sending window cannot be left blank. 9 AM to 8 PM is the default.",
    };
  }
  if (start !== null && (start < 8 || start > 20)) {
    return { ok: false, error: "The earliest a workspace may start sending is 8 AM, and the latest is 8 PM. Federal law sets the 8 AM floor." };
  }
  if (end !== null && (end < 9 || end > 21)) {
    return { ok: false, error: "The earliest a workspace may stop sending is 9 AM, and the latest is 9 PM. Federal law sets the 9 PM ceiling." };
  }
  if (start !== null && end !== null && start >= end) {
    return { ok: false, error: "The start has to come before the end." };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.quietStart !== undefined) patch.quiet_hours_start = start;
  if (input.quietEnd !== undefined) patch.quiet_hours_end = end;
  if (input.timeZone !== undefined) {
    const tz = input.timeZone.trim();
    // A timezone that does not exist means every quiet-hours check for this
    // workspace throws at send time, which is a worse failure than refusing it
    // here — so it is checked against the runtime rather than a list.
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); }
    catch { return { ok: false, error: `"${tz}" is not a timezone this system recognises.` }; }
    patch.time_zone = tz;
  }
  if (input.sendOnWeekends !== undefined) patch.send_on_weekends = input.sendOnWeekends;
  if (input.sendOnHolidays !== undefined) patch.send_on_holidays = input.sendOnHolidays;
  if (input.afterHoursAutoreply !== undefined) patch.after_hours_autoreply = input.afterHoursAutoreply;
  if (input.afterHoursMessage !== undefined) {
    patch.after_hours_message = input.afterHoursMessage.trim() || null;
  }
  // Both bounds move together or neither does: saving one against a stale
  // other is how an inverted range gets written, and the constraint would
  // refuse the whole save with a Postgres string rather than this sentence.
  if (input.replyDelayMin !== undefined || input.replyDelayMax !== undefined) {
    const min = Math.round(input.replyDelayMin ?? 0);
    const max = Math.round(input.replyDelayMax ?? 0);
    const bad = validateDelay(min, max);
    if (bad) return { ok: false, error: bad };
    patch.reply_delay_min_seconds = min;
    patch.reply_delay_max_seconds = max;
  }
  // Validated in words here; the CHECK constraint refuses the same shapes, but
  // with a Postgres string nobody at PPP should have to read.
  if (input.replyToEmail !== undefined) {
    const r = validateReplyTo(input.replyToEmail);
    if (!r.ok) return { ok: false, error: r.error };
    patch.reply_to_email = r.value;
  }

  const sb = messagingDb();
  const { error } = await sb.from("sms_sub_accounts").update(patch).eq("id", input.workspaceId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** The bound, for the page to state rather than the page inventing it. */
export async function federalBound(): Promise<{ startHour: number; endHour: number }> {
  await assertMessagingAccess();
  return { ...FEDERAL_BOUND };
}
