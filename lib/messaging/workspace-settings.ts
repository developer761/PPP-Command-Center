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
 * is still clamped. Saving a wider window here does not widen anything; it
 * just gets narrowed again on the way out.
 */
import { messagingDb } from "./db";
import { clampToFederal, FEDERAL_BOUND } from "./compliance";

export type WorkspaceHours = {
  id: string;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  time_zone: string | null;
  send_on_weekends: boolean | null;
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
  afterHoursAutoreply?: boolean;
  afterHoursMessage?: string;
}): Promise<{ ok: true; clamped: boolean } | { ok: false; error: string }> {
  const start = HOUR(input.quietStart);
  const end = HOUR(input.quietEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { ok: false, error: "Hours must be whole numbers from 0 to 23." };
  }
  if ((start === null) !== (end === null)) {
    return { ok: false, error: "Set both the start and the end, or neither." };
  }
  if (start !== null && end !== null && start >= end) {
    return { ok: false, error: "The start has to come before the end." };
  }

  // Report, do not correct. Silently narrowing what somebody typed teaches
  // them the field does something it does not; saying so teaches them the law.
  let clamped = false;
  if (start !== null && end !== null) {
    const c = clampToFederal({ startHour: start, endHour: end });
    clamped = c.startHour !== start || c.endHour !== end;
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
  if (input.afterHoursAutoreply !== undefined) patch.after_hours_autoreply = input.afterHoursAutoreply;
  if (input.afterHoursMessage !== undefined) {
    patch.after_hours_message = input.afterHoursMessage.trim() || null;
  }

  const sb = messagingDb();
  const { error } = await sb.from("sms_sub_accounts").update(patch).eq("id", input.workspaceId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, clamped };
}

/** The bound, for the page to state rather than the page inventing it. */
export async function federalBound(): Promise<{ startHour: number; endHour: number }> {
  return { ...FEDERAL_BOUND };
}
