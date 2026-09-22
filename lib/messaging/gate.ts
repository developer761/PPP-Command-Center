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
import { hasUnresolved } from "./merge-fields";
import { emailAddressesFor } from "./reply-to";
import {
  withinQuietHours, nextSendableTime, withinDailyCap,
  DEFAULT_DAILY_CAP, FEDERAL_BOUND, type QuietHours,
} from "./compliance";

/** The subset of a workspace row the gate needs. */
export type GateWorkspace = {
  id: string;
  name: string;
  phone_e164: string | null;
  /**
   * What the carrier is told to send FROM, when that is not just the number.
   *
   * PPP's numbers live in an AWS account that is not PPP's own. AWS does not
   * accept ported numbers into End User Messaging, so each number is shared
   * across accounts instead — and a shared number must be addressed by its
   * full ARN in SendTextMessage, not by its digits. NULL means send from
   * phone_e164, which is right for a number this account owns.
   *
   * The customer still sees the number; this only changes what we hand AWS.
   */
  origination_identity?: string | null;
  time_zone: string;
  quiet_hours_start: number;
  quiet_hours_end: number;
  send_on_weekends: boolean;
};

/** PPP campaigns send both channels in one sequence — the CA LA campaign opens
 *  with an SMS and follows with an email fifteen minutes later. */
export type SendChannel = "sms" | "email";

/**
 * The opt-out disclosure, enforced where everything passes.
 *
 * The first automated message to a stranger has to tell them how to stop it.
 * That was being added by the RENDERER, which only covers the agent's own
 * replies — and the message a customer actually receives first is almost
 * always the campaign opener, which is free text somebody typed. Nothing
 * enforced it there, and nothing stopped a reviewer deleting it while editing
 * a draft.
 *
 * So it lives here instead. Every path to a carrier goes through this
 * function; nothing else does.
 *
 * IT DOES NOT CONSTRAIN THE MESSAGE. It is appended, never templated, so the
 * wording above it can be anything. And it is skipped when the text already
 * says it — PPP's own campaigns end "Reply END to stop texts.", which is a
 * perfectly good disclosure, and stapling a second one on would read like a
 * machine wrote it twice.
 */
//
// Defined in first-message.ts so the campaign editor (in the browser) and this
// gate share one test for "already says how to stop". Re-exported so existing
// imports from the gate keep working.
export { OPT_OUT_DISCLOSURE, needsDisclosure, withDisclosure } from "./first-message";
import { withDisclosure } from "./first-message";

export type GateDeps = {
  /**
   * True when this person is suppressed on the channel we are about to use.
   *
   * Takes both identifiers rather than a phone, because 92 of the 213 failed
   * Hatch opt-outs arrived over EMAIL. A list keyed only to a handset cannot
   * stop the email half of a sequence, and honouring one channel while
   * ignoring the other is worse than honouring neither — it looks compliant.
   */
  isSuppressed(target: { phone: E164 | null; email: string | null }, channel: SendChannel): Promise<boolean>;
  /**
   * Have we ever sent this handset anything at all?
   *
   * Decides whether the opt-out disclosure is required. Across every workspace
   * deliberately: somebody who has heard from PPP before has already been told
   * how to stop, and repeating it on every first contact from each of fifteen
   * workspaces would read as spam.
   */
  hasEverSent?(to: E164): Promise<boolean>;
  /** Messages already sent to this handset today, across every agent and workspace. */
  sentToday(to: E164): Promise<number>;
  /**
   * Is there a suppression list at all?
   *
   * THE PORT RAIL. Kate's Hatch export has not been imported: sms_opt_outs
   * holds zero rows. An empty list cannot refuse anybody, so every check above
   * would pass for somebody who told Hatch to stop months ago — and while the
   * numbers are being ported, "live sending" and "a workflow switched on" are
   * two toggles away from each other.
   *
   * So an empty list is not treated as "nobody has opted out". It stops every
   * send until the list is loaded, or until somebody states in the environment
   * that it really is empty (SUPPRESSION_LIST_CONFIRMED_EMPTY=true).
   *
   * Optional: a caller that supplies no answer is not blocked, which keeps
   * every existing test and the simulator working.
   */
  suppressionListLoaded?(): Promise<boolean>;
  /** Supplied only by tests. App callers never hold a transport — the gate
   *  resolves its own — so there is no object to pass around that could be
   *  used to send around this function. */
  transport?: MessageTransport;
  dailyCap?: number;
};

export type SendRequest = {
  workspace: GateWorkspace;
  to: E164;
  /** Required when channel is "email". */
  toEmail?: string | null;
  /** Who an email comes FROM. No workspace has one configured yet, so this is
   *  refused rather than defaulted — a customer receiving PPP mail from an
   *  unexpected address is a deliverability and a trust problem. */
  fromEmail?: string | null;
  /** Where a reply goes: the workspace's own inbox. Optional — without it the
   *  reply goes to the From address. Re-validated here, since this is the last
   *  thing before the header is written. */
  replyToEmail?: string | null;
  /** Email subject. */
  subject?: string | null;
  channel?: SendChannel;
  body: string;
  /** Which agent asked. Recorded, and used for nothing else — no agent gets an
   *  exemption, which is the point. */
  agent: string;
  /**
   * This message ANSWERS one the customer just sent.
   *
   * The single concession in this file, and it is deliberately not keyed on
   * `agent` — no caller earns an exemption by being itself, which is why that
   * field is recorded and never read.
   *
   * What it changes: the workspace's own sending hours (9am-8pm) give way to
   * the FEDERAL bound (8am-9pm). Nothing else. Suppression, the empty-list
   * rail, the daily cap and the federal window itself all still apply, and a
   * message at 2am is still refused.
   *
   * Why that is the right line: the workspace hours exist so PPP does not
   * START conversations at odd times. Somebody who texts at 8:30pm has started
   * one, and answering them is not soliciting them. Karan chose this over
   * replying at any hour, 2026-09-22.
   *
   * It does NOT make the message unconditional. It makes it answerable.
   */
  answersInbound?: boolean;
  now?: Date;
};

/**
 * The longest text the gate will let out.
 *
 * Seven segments. Deliberately generous: PPP's own longest campaign opener is
 * around 280 characters, the editor already warns above 480, and the tone
 * rules ask for something that reads like texting. Anything past this is not a
 * long message, it is a runaway — the model emitting its full 700-token budget
 * as prose, which is about 2,800 characters and eighteen billed texts.
 *
 * A rail catches the catastrophe. Style is somebody else's job.
 */
export const MAX_SMS_CHARS = 1000;

export type GateRefusal =
  | "suppressed"        // they told us to stop. Never retried, never deferred.
  | "quiet_hours"       // legal later — the caller should reschedule.
  | "weekend"           // workspace policy, not law. Also deferrable.
  | "daily_cap"         // five agents talking over each other.
  | "no_workspace_number"
  | "no_email_address"   // an email step with nowhere to send it
  | "empty_body"
  | "unresolved_merge_field"  // "Call us at {{workspace_phone}}" must never send
  | "no_sender_address"       // nowhere for an email to come FROM
  | "channel_not_supported"   // an email step reaching an SMS-only transport;
  | "suppression_list_empty"  // nothing loaded to check against — see GateDeps
  | "too_long"                // a text nobody meant to send — see MAX_SMS_CHARS

export type GateResult =
  /** `body` is what was ACTUALLY sent, which may differ from what was asked:
   *  the opt-out disclosure is appended here on first contact. Callers that
   *  record the message must record this, not their own copy, or the thread
   *  will show something the customer never received. */
  | { ok: true; providerId: string; body: string }
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
  const channel: SendChannel = req.channel ?? "sms";

  // A workspace with no number cannot send from the local area code the
  // customer expects. Thumbtack is in exactly this state today.
  if (channel === "sms" && !ws.phone_e164) return { ok: false, reason: "no_workspace_number" };
  if (channel === "email" && !req.toEmail) return { ok: false, reason: "no_email_address" };
  if (!body.trim()) return { ok: false, reason: "empty_body" };

  // A TEXT NOBODY MEANT TO SEND.
  //
  // Nothing capped the agent's output. runAgentTurn allows max_tokens: 700,
  // which is roughly 2,800 characters — about eighteen texts, billed as
  // eighteen, arriving on a handset as a wall. For the answer_question intent
  // the model's own prose IS the whole message, so there was no template
  // holding it down either.
  //
  // This is a RAIL, not a style rule: it is set well above anything a real
  // message reaches, because brevity belongs to the tone rules and the editor
  // warning at 480 characters, and a gate that enforced taste would start
  // refusing legitimate messages. What it catches is the runaway — the case
  // where something has clearly gone wrong and the customer should not be the
  // one to find out.
  //
  // SMS only. An email is meant to be longer than a text.
  if (channel === "sms" && body.length > MAX_SMS_CHARS) {
    return { ok: false, reason: "too_long" };
  }
  // A placeholder that survived to here is a field nobody defined. Refusing is
  // the only safe answer: a first message reading "Call us at
  // {{workspace_phone}}" is visibly broken, is the first thing that customer
  // ever sees from PPP, and cannot be unsent.
  if (hasUnresolved(body)) return { ok: false, reason: "unresolved_merge_field" };

  // 0. IS THERE A LIST TO CHECK AT ALL? Before suppression, because an empty
  //    list makes the suppression check below answer "not suppressed" for
  //    everybody, including the people most important to refuse.
  if (deps.suppressionListLoaded && !(await deps.suppressionListLoaded())) {
    return { ok: false, reason: "suppression_list_empty" };
  }

  // 1. Suppression, on the channel we are about to use. Absolute, and first,
  //    so nothing below can reorder past it.
  const suppressed = await deps.isSuppressed(
    { phone: to ?? null, email: req.toEmail ?? null },
    channel
  );
  if (suppressed) return { ok: false, reason: "suppressed" };

  // A reply to a message the customer just sent answers within the FEDERAL
  // window rather than the workspace's own narrower one. See answersInbound:
  // the workspace hours exist so PPP does not start conversations at odd
  // times, and somebody who texted at 8:30pm has already started one.
  const hours: QuietHours = req.answersInbound
    ? { ...FEDERAL_BOUND }
    : { startHour: ws.quiet_hours_start, endHour: ws.quiet_hours_end };

  // 2. Quiet hours, in the WORKSPACE's timezone, never the server's.
  //    Applied to EMAIL as well as SMS. Quiet hours are a TCPA bound on texts
  //    and email is CAN-SPAM, which has no such rule — but PPP's own campaign
  //    emails already sit inside the window (09:00, and 15 minutes after a
  //    launch text), so enforcing it cannot delay anything they scheduled, and
  //    it removes any path to an email leaving at 3am.
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

  // LAST THING BEFORE THE CARRIER. Every path — campaign step, agent autosend,
  // a human approving a draft they have edited — arrives here, so this is the
  // only place the disclosure cannot be forgotten or deleted.
  //
  // Deliberately after every refusal above: a message that is not going out
  // does not need a disclosure appended to it first.
  // EMAIL goes out a different door.
  //
  // It used to fall through to transport.send, which takes a phone number —
  // so an email step in a campaign would have been blasted at a handset,
  // subject line and paragraph breaks and all.
  if (channel === "email") {
    const to = req.toEmail!;
    const from = req.fromEmail?.trim() || null;
    if (!from) return { ok: false, reason: "no_sender_address" };

    const transport = deps.transport ?? activeTransport();
    if (!transport.sendEmail) {
      // Refused rather than downgraded. Quietly sending an email as a text is
      // worse than not sending it.
      return { ok: false, reason: "channel_not_supported" };
    }
    // Every caller already validates, but a bad reply-to is a header injection,
    // and this is the one place every email passes. Dropped, not refused: the
    // email is still fine to send from the shared address.
    const replyTo = emailAddressesFor({ workspaceReplyTo: req.replyToEmail, sharedFrom: from }).replyTo;
    const { providerId } = await transport.sendEmail({
      from, to, subject: req.subject?.trim() || "Precision Painting Plus", body, replyTo,
    });
    return { ok: true, providerId, body };
  }

  let outgoing = body;
  if (channel === "sms" && deps.hasEverSent) {
    const seenBefore = await deps.hasEverSent(to);
    if (!seenBefore) outgoing = withDisclosure(body);
  }

  const transport = deps.transport ?? activeTransport();
  // The ARN of a number shared from another AWS account, when there is one;
  // otherwise the number itself. Either is a valid OriginationIdentity, and
  // the customer sees the same number on their handset regardless.
  const from = (ws.origination_identity?.trim() || ws.phone_e164) as E164;
  const { providerId } = await transport.send(from, to, outgoing);
  return { ok: true, providerId, body: outgoing };
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
