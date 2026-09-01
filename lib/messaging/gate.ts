/**
 * The single chokepoint. Nothing reaches a customer except through here.
 *
 * Five agents, an office UI and a campaign scheduler all want to send. If each
 * carried its own copy of the rules there would be five places to get TCPA
 * wrong, and the one that was missed would be discovered by a plaintiff.
 *
 * So the rules live once, here, and the transport is unreachable from anywhere
 * else. A campaign author cannot configure past this — there is deliberately no
 * "urgent, ignore quiet hours" flag, because somebody would set it at 10pm.
 *
 * The database work is injected rather than imported, so every rule is testable
 * without a database and `now` is an argument rather than ambient. The edge
 * cases that cost money — 8:00pm exactly, a workspace in California, the fourth
 * message of the day — are only testable if they can be constructed.
 */
import type { E164 } from "./phone";
import { activeTransport, type MessageTransport } from "./transport";
import {
  withinQuietHours, nextSendableTime, withinDailyCap,
  DEFAULT_DAILY_CAP, type QuietHours,
} from "./compliance";

/** The subset of a workspace row the gate needs. */
export type GateWorkspace = {
  id: string;
  name: string;
  phone_e164: string | null;
  time_zone: string;
  quiet_hours_start: number;
  quiet_hours_end: number;
  send_on_weekends: boolean;
};

export type GateDeps = {
  /** True when the number is on the suppression list and has not re-subscribed. */
  isSuppressed(to: E164): Promise<boolean>;
  /** Messages already sent to this handset today, across every agent and workspace. */
  sentToday(to: E164): Promise<number>;
  /** Supplied only by tests. App callers never hold a transport — the gate
   *  resolves its own — so there is no object to pass around that could be
   *  used to send around this function. */
  transport?: MessageTransport;
  dailyCap?: number;
};

export type SendRequest = {
  workspace: GateWorkspace;
  to: E164;
  body: string;
  /** Which agent asked. Recorded, and used for nothing else — no agent gets an
   *  exemption, which is the point. */
  agent: string;
  now?: Date;
};

export type GateRefusal =
  | "suppressed"        // they told us to stop. Never retried, never deferred.
  | "quiet_hours"       // legal later — the caller should reschedule.
  | "weekend"           // workspace policy, not law. Also deferrable.
  | "daily_cap"         // five agents talking over each other.
  | "no_workspace_number"
  | "empty_body";

export type GateResult =
  | { ok: true; providerId: string }
  | { ok: false; reason: GateRefusal; retryAt?: Date };

/**
 * The ONLY way to send a message.
 *
 * Order matters. Suppression is checked first and is absolute: a customer who
 * opted out is never deferred to a better time, because there isn't one.
 * Everything after it is a "not now" rather than a "no", and returns `retryAt`
 * so the scheduler can requeue instead of silently dropping a message.
 */
export async function gatedSend(req: SendRequest, deps: GateDeps): Promise<GateResult> {
  const now = req.now ?? new Date();
  const { workspace: ws, to, body } = req;

  // A workspace with no number cannot send from the local area code the
  // customer expects. Thumbtack is in exactly this state today.
  if (!ws.phone_e164) return { ok: false, reason: "no_workspace_number" };
  if (!body.trim()) return { ok: false, reason: "empty_body" };

  // 1. Suppression. Absolute, and first, so nothing below can reorder past it.
  if (await deps.isSuppressed(to)) return { ok: false, reason: "suppressed" };

  const hours: QuietHours = {
    startHour: ws.quiet_hours_start,
    endHour: ws.quiet_hours_end,
  };

  // 2. Quiet hours, in the WORKSPACE's timezone, never the server's.
  if (!withinQuietHours(now, ws.time_zone, hours)) {
    return { ok: false, reason: "quiet_hours", retryAt: nextSendableTime(now, ws.time_zone, hours) };
  }

  // 3. Weekend policy. PPP's own setting, not a legal bound — so it defers to
  //    the next open weekday rather than refusing outright.
  if (!ws.send_on_weekends && isWeekendIn(now, ws.time_zone)) {
    return { ok: false, reason: "weekend", retryAt: nextWeekdayOpen(now, ws.time_zone, hours) };
  }

  // 4. Daily cap, per handset across every agent. Retried tomorrow, not today:
  //    the cap exists precisely to stop a fourth message today.
  const cap = deps.dailyCap ?? DEFAULT_DAILY_CAP;
  if (!withinDailyCap(await deps.sentToday(to), cap)) {
    return { ok: false, reason: "daily_cap", retryAt: nextSendableTime(startOfNextDay(now, ws.time_zone), ws.time_zone, hours) };
  }

  const transport = deps.transport ?? activeTransport();
  const { providerId } = await transport.send(ws.phone_e164 as E164, to, body);
  return { ok: true, providerId };
}

/* ── helpers, all timezone-aware for the same reason as the rest ── */

function weekdayIn(now: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function isWeekendIn(now: Date, timeZone: string): boolean {
  const d = weekdayIn(now, timeZone);
  return d === 0 || d === 6;
}

function startOfNextDay(now: Date, timeZone: string): Date {
  // Step forward in hours until the local calendar day changes, rather than
  // adding 24h — a DST day is 23 or 25 hours long.
  const day = new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" });
  const today = day.format(now);
  const c = new Date(now.getTime());
  for (let i = 0; i < 48; i++) {
    c.setUTCHours(c.getUTCHours() + 1);
    if (day.format(c) !== today) return c;
  }
  return c;
}

function nextWeekdayOpen(now: Date, timeZone: string, hours: QuietHours): Date {
  let c = now;
  for (let i = 0; i < 7; i++) {
    c = startOfNextDay(c, timeZone);
    if (!isWeekendIn(c, timeZone)) return nextSendableTime(c, timeZone, hours);
  }
  return nextSendableTime(c, timeZone, hours);
}
