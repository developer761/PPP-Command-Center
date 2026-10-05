/**
 * A25 — HONOUR A STATED COMMUNICATION PREFERENCE.
 *
 * Kate's rule: "Honor a stated communication preference — if they say email
 * or call only, STOP TEXTING." Severity critical, binds true.
 *
 * ── THREE BRANCHES, AND ENDING IS THE DEFECT IN TWO OF THEM ─────────────
 *
 * Kate, on what honouring it looks like:
 *
 *   TEXT ONLY    keep texting. Behind the scenes, take them off the call
 *                cadence in Salesforce.
 *   EMAIL ONLY   stop texting, carry on by email. Off the call cadence too.
 *   PHONE        the bot cannot make a call, so hand to a human — but
 *                GATHER THE CALLBACK TIME FIRST if we do not hold one.
 *                "Ending without capturing when to call is the defect."
 *
 * And the line that makes this a fix rather than a feature: "EVERYWHERE ELSE
 * IN THIS RULE, ENDING IS THE DEFECT. Ending was the Hatch splint (guard B8),
 * not the rule: the text-only and email-only branches continue the
 * conversation in the channel the customer named."
 *
 * THE INTENT GUIDE SAID THE OPPOSITE. `transferred` read "Use this for a
 * text-only preference" — instructing the model to hand off exactly where
 * Kate says handing off is the defect. That is corrected alongside this file.
 *
 * ── WHAT THIS RULE IS NOT ───────────────────────────────────────────────
 *
 * Kate: "THE PREFERENCE IS A CHANNEL, NOT A QUOTE FORMAT. Someone asking to
 * be emailed instead of texted is this rule. Someone asking for the QUOTE
 * ITSELF by text is an A7 off-site reason — different thing, and wanting to
 * carry on THIS conversation by text rather than take calls is neither."
 *
 * So a quote-delivery request must not be read as a channel preference. That
 * carve-out is enforced below and tested, because misreading it would route
 * an off-site quote request into a handoff.
 *
 * ── WHY THE PARSER IS TIMID, IN THE SAME WAY reachability.ts IS ─────────
 *
 * Missing a preference costs one message in the wrong channel. Inventing an
 * email-only preference STOPS TEXTING a live lead on evidence that was never
 * there, and nothing downstream questions it because a stated preference is
 * supposed to outrank the default. Every pattern needs the channel word AND
 * an exclusivity or redirection signal. Anything ambiguous returns null.
 *
 * Pure. No clock, no database.
 */

export type ChannelPreference = "text_only" | "email_only" | "phone";

/**
 * A request for the QUOTE to arrive by some channel, which is A7 and not this
 * rule. Checked first and it wins, because "just email me the quote" contains
 * every word an email-only preference does.
 */
const QUOTE_DELIVERY =
  /\b(?:quote|estimate|price|pricing|bid|proposal|number|numbers|figure)\b/i;

/** Being asked to stop using a channel, rather than merely offered another. */
const EXCLUSIVE = /\b(?:only|just|instead|rather|prefer|don['’]?t|do\s+not|no\s+more|stop)\b/i;

const EMAIL_WORD = /\b(?:e-?mail(?:s|ed|ing)?)\b/i;
const TEXT_WORD = /\b(?:text(?:s|ed|ing)?|sms|message\s+me)\b/i;

/**
 * Asking to be phoned. Imported rather than rewritten — render.ts already
 * owns this question for schedule_follow_up, and a second copy of it is the
 * most common root cause in this codebase.
 */
import { ASKED_FOR_A_CALL } from "./customer-asks";

/**
 * The channel the customer asked for, or null when they did not ask.
 *
 * Order matters. Quote delivery is excluded before anything else; then the
 * branches that STOP a channel are read before the one that merely adds one,
 * because "email me instead of texting" names both channels.
 */
/**
 * Words that REFUSE a channel rather than ask for one.
 *
 * Kept apart from EXCLUSIVE because the two do opposite jobs, and conflating
 * them is exactly what broke this function: "just" and "don't" both signal
 * exclusivity, but one wants the channel and the other refuses it.
 */
const REFUSAL = /\b(?:don['’]?t|do\s+not|no\s+more|never|stop|quit|cease|halt|discontinue)\b/i;

/**
 * "instead of texting" and "rather than email" REFUSE what follows them,
 * which is the opposite of a bare trailing "instead" ("call me instead"),
 * where the channel named is the one they want. Marked before splitting so
 * the distinction survives it.
 */
const EXCLUSIVE_WORD = /\b(?:instead|rather|prefer(?:s|red)?)\b/i;

/**
 * A request shape that is not an exclusivity word. "use email", "send it by
 * text" and "email ME" are all asking for a channel; "I'll email YOU the
 * photos tonight" is not, and the difference is who is being asked to do it.
 * Without this, "stop texting me, use email please" read as no preference at
 * all — the refusal landed and the request did not.
 */
const REQUEST_SHAPE = /\b(?:use|send|switch\s+to|reach\s+me|contact\s+me|get\s+me)\b/i;
const CHANNEL_AT_ME = /\b(?:text\w*|sms|e-?mail\w*|call\w*|phone\w*)\s+(?:to\s+)?me\b/i;
const REFUSED_AFTER = /\b(?:instead\s+of|rather\s+than)\b/gi;
const MARK = "\u0000";

/**
 * A preference is almost always TWO statements — one refusing a channel, one
 * asking for another. Reading the whole string at once cannot tell which word
 * belongs to which channel, which is how "don't text me, just call me" was
 * read as a request for text.
 *
 * Split on punctuation and on the connectives that separate the two halves.
 * "just" and "only" are included because people write them without commas:
 * "dont text me just call me".
 *
 * Then, WITHIN each clause, anything after "instead of" or "rather than" is
 * refused and anything before it is wanted — "call me instead of texting"
 * names both channels in one breath and means opposite things by them. A
 * bare trailing "instead" is left alone, because there the channel named is
 * the one they want: "call me instead".
 *
 * KNOWN LIMIT, AND IT FAILS SAFE. A refusal that OPENS the sentence — "rather
 * than texting can you call" — leaves no clause before the marker, so both
 * channels read as refused and the answer is null. No preference recorded
 * rather than the wrong one, which is this module's stated preference: a
 * missed preference costs one message in the wrong channel, an invented one
 * stops a live lead.
 */
function clauses(text: string): { text: string; refused: boolean; exclusive: boolean }[] {
  const marked = text.replace(REFUSED_AFTER, MARK);
  // Capturing split, so each piece knows which delimiter sat on either side.
  const pieces = marked.split(/([,;.!?]+|\b(?:and|but|please|just|only)\b)/i);
  const isExclusiveDelim = (d: string | undefined) => !!d && /\b(?:just|only)\b/i.test(d);

  const out: { text: string; refused: boolean; exclusive: boolean }[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const piece = pieces[i];
    if (!piece) continue;
    /**
     * "just text me" puts the marker BEFORE the channel and "text only" puts
     * it after, so both neighbours count. Without this, splitting on the very
     * word that signals exclusivity threw the signal away.
     */
    const neighbourExclusive =
      isExclusiveDelim(pieces[i - 1]) || isExclusiveDelim(pieces[i + 1]);

    const [before, ...after] = piece.split(MARK);
    if (before.trim()) {
      out.push({
        text: before.trim(),
        refused: false,
        // Naming a channel immediately before "instead of" IS the request:
        // "email me instead of texting".
        exclusive: neighbourExclusive || after.length > 0
          || EXCLUSIVE_WORD.test(before) || REQUEST_SHAPE.test(before) || CHANNEL_AT_ME.test(before),
      });
    }
    for (const tail of after) {
      if (tail.trim()) out.push({ text: tail.trim(), refused: true, exclusive: false });
    }
  }
  return out;
}

/**
 * Does the customer want this channel, refuse it, or not mention it?
 *
 * `needsExclusivity` is the difference between a request and a mention.
 * "I'll email you the photos tonight" names email and asks for nothing;
 * reading that as an email-only preference stops texting a live lead on
 * evidence that was never there. A call is the exception — ASKED_FOR_A_CALL
 * only matches phrasings that ARE a request.
 */
function stance(
  text: string,
  channel: RegExp,
  needsExclusivity: boolean,
): "wanted" | "refused" | null {
  let seen: "wanted" | "refused" | null = null;
  for (const c of clauses(text)) {
    if (!channel.test(c.text)) continue;
    if (c.refused || REFUSAL.test(c.text)) return "refused";
    if (needsExclusivity && !c.exclusive) continue;
    seen = "wanted";
  }
  return seen;
}

/**
 * The channel the customer asked for, or null when they did not ask.
 *
 * Order matters. Quote delivery is excluded before anything else; then the
 * branches that STOP a channel are read before the one that merely adds one,
 * because "email me instead of texting" names both channels.
 */
/**
 * The channel the customer asked for, or null when they did not ask.
 *
 * ── THE INVERSION THIS FIXES, 2026-10-05 ────────────────────────────────
 *
 * The old version asked "is there a text word AND an exclusivity word", with
 * "don't" counted as exclusivity. So all of these returned text_only:
 *
 *   "please call me instead of texting"
 *   "stop texting me and call me instead"
 *   "dont text me just call me"
 *
 * The exact opposite of what the customer asked for — and worse than
 * useless, because a stated preference outranks the default and A25's
 * notification would have told the team to take them off the CALL cadence,
 * which is the one channel they had just asked for. Found while wiring Kate's
 * 2026-10-05 ruling that this case routes to a person.
 *
 * Order still matters: quote delivery is A7 and wins outright; a refusal of
 * one channel alongside a request for another resolves to the requested one;
 * and a message that only refuses, naming no alternative, is not a preference
 * at all — it is an opt-out, and compliance.ts owns that.
 */
export function statedChannelPreference(
  text: string | null | undefined
): ChannelPreference | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  // A7, not A25. "Can you just email me the quote" is a delivery request.
  if (QUOTE_DELIVERY.test(t)) return null;

  const wanted: ChannelPreference[] = [];
  if (stance(t, EMAIL_WORD, true) === "wanted") wanted.push("email_only");
  if (stance(t, TEXT_WORD, true) === "wanted") wanted.push("text_only");
  if (stance(t, ASKED_FOR_A_CALL, false) === "wanted") wanted.push("phone");

  // Exactly one channel asked for is a preference. Two is ambiguous, and
  // inventing one here stops a live lead on evidence never given.
  if (wanted.length === 1) return wanted[0];
  return null;
}

/**
 * Do we already know when to call this person?
 *
 * A25's phone branch may only end once we do. Either a stated reachability
 * constraint (A44's parser, "I'm at work until 5") or captured availability
 * counts — both answer "when to call" and asking again would be an A11
 * redundant ask.
 */
export function holdsCallbackTime(input: {
  unreachableStartHour?: number | null;
  availability?: string | null;
  requestedHour?: number | null;
}): boolean {
  /**
   * AND AN HOUR THEY NAMED OUTRIGHT, which is the most direct answer of the
   * three and was the one this did not count.
   *
   * "Call me at 6" left holdsCallbackTime false, so the branch asked "what's
   * a good time to reach you?" — asking for the thing they had just said,
   * which is the A11 redundant ask this function exists to prevent. Caught
   * by walking the branch rather than by a test: the two named inputs were
   * both present and correct, and the new one was simply not consulted.
   */
  if (typeof input.requestedHour === "number") return true;
  if (typeof input.unreachableStartHour === "number") return true;
  return Boolean((input.availability ?? "").trim());
}

export type PhoneBranch =
  /** Ask when to call, then hand over on the next turn. */
  | "ask_callback_time"
  /** They named a time nobody is there for. Say the hours, ask for one inside. */
  | "callback_outside_hours"
  /** We know when. Notify a person and let them take it. */
  | "hand_to_human";

/**
 * THE HOURS SOMEBODY IS ACTUALLY THERE TO PLACE THE CALL.
 *
 * A36's weekday office window, and deliberately that one rather than the
 * weekend's narrower 9-5:30: a bare "call me at 6" names no day, so the wider
 * window is the one that can be stated without ruling out a time the customer
 * could in fact have had.
 *
 * ── THE ZONE, SAID PLAINLY RATHER THAN APPROXIMATED ─────────────────────
 *
 * This compares the hour the customer NAMED against the office's window, and
 * a bare "6pm" carries no date, so there is nothing to convert with. Every
 * workspace currently runs America/New_York and the call centre is Eastern,
 * so the two coincide today. They would not for a Pacific customer on a
 * Pacific workspace — their "6pm" is 9pm here — and the fix then is to
 * resolve the stated hour against customerZone, not to guess a date. Written
 * down rather than silently got wrong.
 */
export const CALLBACK_WINDOW = { startHour: 9, endHour: 20 } as const;

/**
 * Is a named callback hour one we could place a call in?
 *
 * `null` when they named no hour, which is NOT the same as "outside": it
 * means there is nothing to check, and the caller must not turn a missing
 * answer into a correction.
 */
export function callbackIsInHours(hour: number | null | undefined): boolean | null {
  if (typeof hour !== "number" || !Number.isFinite(hour)) return null;
  return hour >= CALLBACK_WINDOW.startHour && hour < CALLBACK_WINDOW.endHour;
}

/**
 * What the phone branch should do this turn.
 *
 * Kate, 2026-09-18: "The bot cannot make a call, so a customer who wants to
 * speak is handed to a human — and the bot must GATHER THEIR CALLBACK TIME
 * PREFERENCE FIRST if it does not already have it. Ending without capturing
 * when to call is the defect."
 *
 * And 2026-09-28, spelling the cadence out: "if call back time is within
 * business hours, state 'we will reach out then', if call back time is
 * outside of business hours, state business hours + ask if there is a time
 * that works for them within that timeframe."
 *
 * So a time we cannot act on is its own branch, checked BEFORE the handover:
 * holding "call me at 11pm" is holding a time, and handing that to a person
 * as though it were bookable is the same defect as capturing nothing.
 */
export function phoneBranch(input: {
  unreachableStartHour?: number | null;
  availability?: string | null;
  /** The clock hour they asked to be called at, 0-23, if they named one. */
  requestedHour?: number | null;
}): PhoneBranch {
  if (callbackIsInHours(input.requestedHour) === false) return "callback_outside_hours";
  return holdsCallbackTime(input) ? "hand_to_human" : "ask_callback_time";
}

/**
 * 🔴 CONCEALING THE HANDOFF IS NOT REQUIRED, and must never be built in.
 *
 * Kate, 2026-09-18: "'Without the customer knowing' was a HATCH guard, not a
 * business rule: Hatch could not transfer without emitting a message of its
 * own, so the instruction told it to hide the seam. The replacement has no
 * such limit — the bot notifies the agent, the agent enters the conversation
 * and answers. Do not write concealment into any rule, and never tag a bot
 * for failing to conceal a handoff."
 *
 * Exported as a named constant so the intent that this is NOT a requirement
 * survives somebody reading only the code.
 *
 * ── AN INCONSISTENCY IN KATE'S OWN TEXT, FOR HER TO SETTLE ──────────────
 * (docs/QUESTIONS_FOR_KATE.md, item 4.)
 * A25's corrective_action column still reads "made a silent transfer to a
 * human", which predates the 2026-09-18 note above and contradicts it. The
 * rule card is treated as current here because it is dated and explicit.
 */
export const HANDOFF_MAY_BE_VISIBLE = true;

/**
 * Taking somebody off the call cadence is a SALESFORCE WRITE WE DO NOT MAKE.
 *
 * Both the text-only and email-only branches ask for it. Salesforce is
 * read-only from Connect Hub except the opt-out writeback, which is itself
 * gated behind SF_OPTOUT_WRITEBACK and Katie's approval. So the preference is
 * recorded here and surfaced for a person, rather than written across.
 *
 * Flagged rather than quietly skipped: a rule that half-runs and reports
 * success is worse than one that says what it did not do.
 */
export const CALL_CADENCE_IS_MANUAL = true;
