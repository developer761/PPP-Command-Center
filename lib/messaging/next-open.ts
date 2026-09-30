/**
 * "We'll get back to you after we open at ___." Hatch parity, the
 * `[[[[Next Open Time]]]]` merge field.
 *
 * Hatch's out-of-hours reply resolves the workspace's next opening against its
 * hours. Ours is static text in `after_hours_message`, so the only way to say
 * when we open is for somebody to type an hour into a settings box — in every
 * workspace, and again whenever the hours change, and with nothing checking
 * that what they typed is true.
 *
 * ── THE TIME WE PROMISE IS THE TIME THE SYSTEM WILL ACT ─────────────────
 *
 * This resolves against `nextWindowOpen` — the SAME function the gate uses to
 * decide when a message may actually go out — rather than reading the hours
 * and formatting them itself. That is the whole design. A second reading of
 * the rule is how a predicate and its scheduler drift apart, which this
 * codebase has done four times, and here the drift would be a promise to a
 * customer: "we open at 9" followed by silence until noon.
 *
 * So the sentence cannot be wrong unless the gate is wrong, in which case the
 * sentence is accurately describing a broken gate.
 *
 * ── WHOSE CLOCK ─────────────────────────────────────────────────────────
 *
 * The customer's. `nextWindowOpen` returns the next instant BOTH windows are
 * open — PPP's office and the customer's own civil hours — so for somebody in
 * California at 11pm that instant is 9 AM Pacific, which is noon in the
 * office. Telling them "9 AM" in their own zone is both friendlier and the
 * only honest rendering: it is when their phone will actually buzz.
 *
 * When their zone cannot be resolved the office zone is used and the phrase
 * says "ET", because an unqualified hour in the wrong zone is worse than a
 * qualified one they have to convert.
 *
 * Pure. The caller does the reading and the sending.
 */
import { nextWindowOpen } from "./sending-window";
import { OFFICE_ZONE } from "./sending-window";
import type { QuietHours } from "./compliance";

/**
 * The tokens we replace.
 *
 * `{{next_open}}` is ours and matches the merge fields already in use
 * (`{{customer_name}}`). `[[[[Next Open Time]]]]` is HATCH's, accepted
 * because the migration story is somebody pasting their existing message in,
 * and a token that silently survives into a text message is the worst
 * possible way to find out we did not recognise it.
 */
const TOKENS = /\{\{\s*next_open(?:_time)?\s*\}\}|\[{4}\s*Next Open Time\s*\]{4}/gi;

/** Does this message ask for the next opening time at all? */
export function wantsNextOpen(body: string): boolean {
  TOKENS.lastIndex = 0;
  return TOKENS.test(body ?? "");
}

const hourLabel = (d: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true,
  })
    .format(d)
    // "9:00 AM" reads like a machine. "9:30 AM" has to keep its minutes,
    // which is why the weekend close of 5:30 PM exists in the window at all.
    .replace(/:00\s/, " ");

/**
 * "EDT", "PST". Read from the date rather than hardcoded, so the label is
 * right on both sides of a daylight-saving change.
 */
const zoneAbbrev = (d: Date, timeZone: string): string => {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(d).find((p) => p.type === "timeZoneName");
  return part?.value ?? "ET";
};

const dayName = (d: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(d);

/** The calendar day in a zone, as a comparable string. */
const dayKey = (d: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);

/**
 * How a person would say it: "9 AM", "9 AM tomorrow", "Monday at 9 AM".
 *
 * Deliberately no date. "We open at 9 AM on 09/29" is how software talks, and
 * the reply is going to somebody who texted us twenty minutes ago — the next
 * opening is always within a couple of days, so a weekday name is unambiguous
 * and reads like a person wrote it.
 */
export function nextOpenPhrase(when: Date, now: Date, timeZone: string): string {
  const hour = hourLabel(when, timeZone);

  const today = dayKey(now, timeZone);
  const target = dayKey(when, timeZone);
  if (target === today) return hour;

  const tomorrow = dayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
  if (target === tomorrow) return `${hour} tomorrow`;

  return `${dayName(when, timeZone)} at ${hour}`;
}

export type NextOpenFill =
  | { ok: true; body: string }
  /**
   * The message asked for a time and there is no answer. The caller must NOT
   * send — see the note on `fillNextOpen`.
   */
  | { ok: false; why: string };

/**
 * Put the next opening time into an out-of-hours message.
 *
 * ── AN UNRESOLVED TOKEN IS A REFUSAL, NOT A BLANK ───────────────────────
 *
 * If the window never opens inside a week — a misconfigured workspace, an
 * unresolvable customer zone — there is no honest sentence to send. The three
 * alternatives are all worse than silence:
 *
 *   leave the token   the customer gets a text containing "{{next_open}}"
 *   delete the token  "We'll get back to you after we open at ."
 *   guess an hour     we tell somebody a time nobody will honour
 *
 * An out-of-hours auto-reply is additive: not sending one leaves the customer
 * exactly where they were, waiting for the real reply that the morning's
 * agent turn will send. So refusing costs nothing and the alternatives cost
 * trust. This is the same direction the rest of this file's callers take — a
 * fact we do not have is a refusal, never a guess.
 */
export function fillNextOpen(input: {
  body: string;
  now: Date;
  customerZone: string;
  officeZone?: string;
  officeHours?: QuietHours;
}): NextOpenFill {
  const body = input.body ?? "";
  if (!wantsNextOpen(body)) return { ok: true, body };

  /**
   * With no customer zone there is nothing to solve the window against —
   * sendingWindow needs one, and passing "" made nextWindowOpen return null,
   * which turned "we do not know where they are" into "refuse to reply". That
   * is the wrong direction: not knowing the zone is ordinary (an 800 number,
   * an unmapped area code), and the reply is still worth sending.
   *
   * So the office's own zone stands in, and the phrase carries the zone's
   * name so the hour is never an unqualified time in a zone the reader does
   * not share.
   */
  const knowsZone = Boolean(input.customerZone);
  const zone = knowsZone ? input.customerZone : (input.officeZone ?? OFFICE_ZONE);

  const when = nextWindowOpen({
    now: input.now,
    customerZone: zone,
    officeZone: input.officeZone,
    officeHours: input.officeHours,
    // The question the sentence asks is "when will you get back to me", and
    // the answer is governed by the OUTBOUND window. answersInbound would
    // widen it to the federal bound and promise a time nobody is working.
    answersInbound: false,
  });

  if (!when) {
    return {
      ok: false,
      why: "the message asks for the next opening time and the sending window does not "
        + "open inside a week — check the workspace's hours and timezone",
    };
  }

  /**
   * Rendered in the CUSTOMER'S zone, which is the zone nextWindowOpen was
   * solved in. Falling back to the office zone carries "ET" with it, because
   * an unqualified hour in a zone the reader does not share is a wrong time
   * stated confidently.
   */
  const phrase = nextOpenPhrase(when, input.now, zone)
    + (knowsZone ? "" : ` ${zoneAbbrev(when, zone)}`);

  TOKENS.lastIndex = 0;
  return { ok: true, body: body.replace(TOKENS, phrase) };
}
