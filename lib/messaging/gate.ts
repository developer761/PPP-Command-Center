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
  withinQuietHours, nextSendableTime, withinDailyCap, isWeekendIn,
  DEFAULT_DAILY_CAP, FEDERAL_BOUND, type QuietHours,
} from "./compliance";
import { customerZone } from "./customer-clock";
import { isHolidayIn } from "./holidays";
import { reportWarn } from "@/lib/observability";
import { sendingWindow, nextWindowOpen } from "./sending-window";

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
  /**
   * Optional so adding it cannot break an existing caller, and ABSENT READS AS
   * FALSE — the column's own default and migration 179's stated policy,
   * "Holidays default OFF". A workspace nobody has asked must not be the one
   * that texts on Christmas morning.
   */
  send_on_holidays?: boolean | null;
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
  /**
   * Messages already sent to this handset today, across every agent and
   * workspace.
   *
   * `since` is the start of the recipient's own calendar day and the GATE
   * works it out, not this dep. It used to be a rolling 24 hours computed in
   * here while the gate deferred to the next calendar day, and two different
   * windows either side of one decision is how a message lands two days late:
   * three sent on Monday evening, refused, retried Tuesday morning, and all
   * three were still inside the rolling 24 hours — refused again, Wednesday.
   */
  sentToday(to: E164, since: Date): Promise<number>;
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
  /**
   * Which US state this handset's owner is in, when the database knows.
   *
   * Decides whose clock the sending window is read against — see
   * customer-clock.ts and sending-window.ts. A dep rather than something each
   * caller passes, because there are four call sites and not all of them hold
   * a conversation: plumbing it through each is exactly how a rule ends up
   * written and never wired, which has happened repeatedly in this codebase.
   *
   * Optional, and null is a fine answer. Without it the zone comes from the
   * area code, and failing that from the most restrictive zone PPP serves —
   * never from the workspace's own clock, which is the bug this replaced.
   */
  customerState?(to: E164): Promise<string | null>;
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
  /**
   * A REPLY THE CARRIER OR THE LAW REQUIRES, which PPP's own rails may not
   * silently swallow.
   *
   * Today this is HELP, and HELP alone. CTIA requires it, carriers test it
   * during A2P vetting, and record-inbound queues it through the ordinary
   * reply queue precisely so that it passes through this gate — which was
   * right, except that two of the rules here are PPP's own volume policy
   * rather than a legal bound, and both of them could eat it:
   *
   *   the daily cap        somebody who has had three messages today and then
   *                        texts HELP gets silence, and the reply becomes a
   *                        draft in a queue
   *   the empty-list rail  a safety rail for the port, which refuses every
   *                        send while sms_opt_outs is empty — so until the
   *                        list was imported, EVERY HELP reply became a draft
   *
   * Suppression and the sending window are deliberately NOT bypassed. Those
   * are legal bounds rather than policy, and relaxing either is a decision for
   * Kate and for whoever owns the compliance answer, not a flag. A HELP reply
   * refused by one of them is reported loudly rather than dropped, so the gap
   * is visible instead of silent.
   */
  required?: boolean;
  /**
   * The customer's state, when the caller knows it — from their zip through
   * sms_service_zips, which is the most authoritative thing PPP holds.
   *
   * Optional and usually absent: 0 of the 10 live conversations carry a zip,
   * so in practice the zone is resolved from the area code of `to`. Supplying
   * it only ever makes the answer more accurate. See customer-clock.ts.
   */
  toState?: string | null;
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
  | "holiday"           // same shape as weekend: policy, deferred to the next open day.
  | "daily_cap"         // five agents talking over each other.
  | "no_workspace_number"
  | "no_email_address"   // an email step with nowhere to send it
  | "empty_body"
  | "unresolved_merge_field"  // "Call us at {{workspace_phone}}" must never send
  | "no_sender_address"       // nowhere for an email to come FROM
  | "channel_not_supported"   // an email step reaching an SMS-only transport;
  | "suppression_list_empty"  // nothing loaded to check against — see GateDeps
  | "too_long"                // a text nobody meant to send — see MAX_SMS_CHARS
  | "office_closed"           // A36: PPP is not working. Deferrable.

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
    // ...unless the law requires this one. The rail exists to stop PPP
    // STARTING conversations with a list that cannot refuse anybody; it was
    // never meant to stop us answering HELP. See SendRequest.required.
    if (!req.required) return { ok: false, reason: "suppression_list_empty" };
  }

  // 1. Suppression, on the channel we are about to use. Absolute, and first,
  //    so nothing below can reorder past it.
  const suppressed = await deps.isSuppressed(
    { phone: to ?? null, email: req.toEmail ?? null },
    channel
  );
  if (suppressed) {
    /**
     * A REQUIRED REPLY REFUSED HERE IS A GAP SOMEBODY HAS TO DECIDE ABOUT.
     *
     * Somebody who opted out and then texts HELP is asking us a question, and
     * CTIA requires an answer — but suppression is the one rule in this file
     * that is absolute, and quietly carving a hole in it is not a change to
     * make from a bug report. Reported so it is visible and can be decided,
     * rather than disappearing into a draft queue.
     */
    if (req.required) {
      reportWarn({
        key: "required_reply_refused_suppressed", platform: "ppp_cc",
        message: "a legally required reply (HELP) was refused because the number is suppressed",
        context: { to: to ?? null, agent: req.agent },
      });
    }
    return { ok: false, reason: "suppressed" };
  }

  // A reply to a message the customer just sent answers within the FEDERAL
  // window rather than the workspace's own narrower one. See answersInbound:
  // the workspace hours exist so PPP does not start conversations at odd
  // times, and somebody who texted at 8:30pm has already started one.
  const hours: QuietHours = req.answersInbound
    ? { ...FEDERAL_BOUND }
    : { startHour: ws.quiet_hours_start, endHour: ws.quiet_hours_end };

  // 2. A36 — THE CALLABLE WINDOW, ON THE RECIPIENT'S CLOCK.
  //
  //    This used to read ws.time_zone for both halves, which is the workspace's
  //    clock and not the customer's. At 9:30am Eastern it let a text go to a
  //    California number at 6:30 in the morning — under the federal 8am floor,
  //    so a violation and not merely outside Kate's preference.
  //
  //    Applied to EMAIL as well as SMS. Quiet hours are a TCPA bound on texts
  //    and email is CAN-SPAM, which has no such rule — but PPP's own campaign
  //    emails already sit inside the window (09:00, and 15 minutes after a
  //    launch text), so enforcing it cannot delay anything they scheduled, and
  //    it removes any path to an email leaving at 3am.
  // The caller's own answer wins when it has one; otherwise ask the database.
  // A dep that throws must not take the send with it — an unknown state is
  // handled (the restrictive zone), an exception is not.
  let toState = req.toState ?? null;
  if (!toState && deps.customerState && to) {
    try { toState = await deps.customerState(to); } catch { toState = null; }
  }
  const zone = customerZone({ zipState: toState, phone: to ?? null });
  const window = sendingWindow({
    now,
    customerZone: zone.timeZone,
    officeZone: ws.time_zone,
    officeHours: hours,
    answersInbound: req.answersInbound,
  });
  if (!window.open) {
    const retryAt = nextWindowOpen({
      now, customerZone: zone.timeZone, officeZone: ws.time_zone,
      officeHours: hours, answersInbound: req.answersInbound,
    });
    // office_closed is PPP's own policy and quiet_hours is the legal bound.
    // Kept as separate refusals because they mean different things to whoever
    // reads the log: one is a setting, the other is a near miss.
    return {
      ok: false,
      reason: window.why === "office_closed" ? "office_closed" : "quiet_hours",
      ...(retryAt ? { retryAt } : {}),
    };
  }

  /**
   * 3. Weekend policy. PPP's own setting, not a legal bound — so it defers to
   *    the next open weekday rather than refusing outright. Narrower than
   *    A36's weekend half-day above, and applied after it, so whichever is
   *    stricter wins.
   *
   * STANDS DOWN FOR A REPLY, like the office window two steps up and for the
   * identical reason, stated there: "somebody who texts at 8:30pm has started
   * the conversation, and replying to them is not a callback to set an
   * appointment — it is an answer." These rules govern contact PPP INITIATES.
   * Not working Saturdays is a reason not to start a conversation on one; it
   * is not a reason to leave somebody who wrote to us unanswered.
   */
  if (!req.answersInbound && !ws.send_on_weekends && isWeekendIn(now, ws.time_zone)) {
    return { ok: false, reason: "weekend", retryAt: nextWeekdayOpen(now, ws.time_zone, hours) };
  }

  /**
   * 3b. HOLIDAYS. The same shape as the weekend above, and for the same
   *     reason: PPP's own policy rather than a legal bound, so it DEFERS to
   *     the next open day instead of refusing outright.
   *
   * `send_on_holidays` has been a column on workspaces and campaigns since
   * migration 179 — "Holidays default OFF: a painting estimate chase on
   * Thanksgiving morning reads badly even where it is legal" — false on all 33
   * workspaces, with no calendar and no check. The data said one thing and
   * this function would have sent on Christmas morning.
   *
   * It is also the condition Kate attached to the event-park cadence,
   * 2026-10-05: "as long as we have a mechanism that keeps customers from
   * being messaged on specific holidays AND THE MSG WOULD SEND THE FOLLOWING
   * OPEN DAY." The retryAt is that second half; a bare refusal would meet half
   * her answer.
   *
   * After the weekend check on purpose, so Thanksgiving Friday defers to
   * Monday rather than to Saturday.
   */
  /**
   * AND IT STANDS DOWN FOR A REPLY TOO, which the first version of this did
   * not and which was a regression I introduced on 2026-10-06.
   *
   * Unconditional, it refused ANY outbound on a holiday — including the ones
   * answering a customer who had just texted us. The worst of those is HELP:
   * record-inbound queues the legally-required HELP reply as a send_reply so
   * it passes this gate, the gate refused it as "holiday", and the reply
   * became a draft sitting in a review queue on a day nobody is reviewing.
   * CTIA requires that reply. The after-hours "we are closed" message and any
   * held reply answering an inbound went the same way.
   *
   * Kate's answer was about not MESSAGING customers on holidays — a chase, a
   * nudge, a campaign step. Nobody meant "do not answer somebody who writes to
   * you on Christmas Eve".
   */
  if (!req.answersInbound && !ws.send_on_holidays && isHolidayIn(now, ws.time_zone)) {
    return { ok: false, reason: "holiday", retryAt: nextOpenDay(now, ws.time_zone, hours, ws.send_on_weekends) };
  }

  /**
   * 4. Daily cap, per handset across every agent. Retried tomorrow, not today:
   *    the cap exists precisely to stop a fourth message today.
   *
   * THE WINDOW AND THE RETRY ARE THE SAME DAY, which they were not.
   *
   * The count was a rolling 24 hours (gate-deps: `now - 24h`) and the retry was
   * the next calendar day. Three messages at 6:00, 6:30 and 7:00 on Monday
   * evening refused the fourth and promised Tuesday 9am — and at Tuesday 9am
   * all three were still inside the rolling 24 hours, so it refused again and
   * promised Wednesday. Every message the cap caught in an evening landed two
   * days late, and nothing in the refusal said so.
   *
   * Fixed by counting the recipient's calendar day, which is what the name
   * sentToday, the constant DEFAULT_DAILY_CAP = 3 and Kate's "three a day" all
   * already said. The alternative — keep the rolling window and retry at
   * oldest+24h — was rejected: it makes "3 a day" mean something nobody said,
   * and it needs the dep to return a timestamp as well as a count, so the two
   * halves could drift apart again.
   *
   * ON THE RECIPIENT'S CLOCK, like the sending window above, and for a reason
   * particular to this rule: the cap is per CUSTOMER across every workspace, so
   * if the boundary were each workspace's own midnight the same three messages
   * would count as three for one agent and two for another, and the fourth
   * message would go out.
   *
   * What this does NOT do is stop 3 late on Monday and 3 early on Tuesday.
   * That is six inside eleven hours and it is deliberate: the sending window
   * two steps up already bounds both ends to the customer's 8am-9pm, "three a
   * day" is the rule PPP agreed, and a rolling window that quietly rations
   * three per 24h is a different promise.
   */
  const cap = deps.dailyCap ?? DEFAULT_DAILY_CAP;
  const dayStart = startOfDayIn(now, zone.timeZone);
  // A required reply is not a fourth marketing message; see SendRequest.required.
  if (!req.required && !withinDailyCap(await deps.sentToday(to, dayStart), cap)) {
    // Anchored at the start of the recipient's NEXT day — the first moment the
    // count above is 0 — and then moved to the first legal sending moment by
    // the same function the window refusal uses, so the two cannot disagree.
    const tomorrow = startOfNextDay(now, zone.timeZone);
    const retryAt = nextWindowOpen({
      now: tomorrow, customerZone: zone.timeZone, officeZone: ws.time_zone,
      officeHours: hours, answersInbound: req.answersInbound,
    }) ?? nextSendableTime(tomorrow, ws.time_zone, hours);
    return { ok: false, reason: "daily_cap", retryAt };
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

// isWeekendIn lived here and in sending-window.ts, two implementations of one
// question. Now one, in compliance.ts with the other clock rules, re-exported
// so the files that import it from the gate keep working.
export { isWeekendIn } from "./compliance";

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

/**
 * The first instant of the local calendar day `now` falls in.
 *
 * Steps BACKWARD until the local day changes rather than subtracting the local
 * clock time, because subtracting is wrong on the two days a year a zone shifts
 * — an hour out, in the direction that makes yesterday evening's messages count
 * as today's. Quarter-hours because a few zones sit at :30 and :45 offsets, so
 * whole-hour steps would land inside yesterday there.
 *
 * Bounded at 100 steps (25 hours, longer than any real day) and returns the
 * oldest candidate if it never finds the boundary: that counts MORE messages
 * than it should, which holds a message back. The other direction sends one.
 */
export function startOfDayIn(now: Date, timeZone: string): Date {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  const today = day.format(now);
  const c = new Date(now.getTime());
  c.setUTCSeconds(0, 0);
  c.setUTCMinutes(Math.floor(c.getUTCMinutes() / 15) * 15);
  for (let i = 0; i < 100; i++) {
    const back = new Date(c.getTime() - 15 * 60_000);
    if (day.format(back) !== today) return c;
    c.setTime(back.getTime());
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

/**
 * Kate's "the following open day", which is not the same as "tomorrow".
 *
 * Holidays come in pairs here — Christmas Eve into Christmas Day, Thanksgiving
 * into the Friday after — and both run into a weekend about half the time.
 * Stepping a single day would defer Christmas Eve onto Christmas Day, which is
 * the thing this rule exists to prevent, so it steps until it finds a day that
 * is neither.
 *
 * Ten days is the bound. The longest real run is Thursday Thanksgiving,
 * Friday, Saturday, Sunday — four — and ten leaves room for a pairing nobody
 * has thought of while still never looping. Falling out of the loop returns
 * the last candidate rather than nothing, so a pathological calendar delays a
 * message instead of dropping it.
 */
function nextOpenDay(now: Date, timeZone: string, hours: QuietHours, sendOnWeekends: boolean): Date {
  let c = now;
  for (let i = 0; i < 10; i++) {
    c = startOfNextDay(c, timeZone);
    const blockedByWeekend = !sendOnWeekends && isWeekendIn(c, timeZone);
    if (!blockedByWeekend && !isHolidayIn(c, timeZone)) {
      return nextSendableTime(c, timeZone, hours);
    }
  }
  return nextSendableTime(c, timeZone, hours);
}
