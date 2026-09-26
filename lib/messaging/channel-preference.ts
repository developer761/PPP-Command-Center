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
export function statedChannelPreference(
  text: string | null | undefined
): ChannelPreference | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  // A7, not A25. "Can you just email me the quote" is a delivery request.
  if (QUOTE_DELIVERY.test(t)) return null;

  const exclusive = EXCLUSIVE.test(t);
  const email = EMAIL_WORD.test(t);
  const texting = TEXT_WORD.test(t);
  const phone = ASKED_FOR_A_CALL.test(t);

  // "email me instead of texting", "email only", "stop texting me, use email"
  if (email && exclusive) return "email_only";

  // "text only", "don't call me, just text". Needs the exclusivity word, so
  // somebody simply replying by text is not read as declaring a preference —
  // Kate: carrying on THIS conversation by text "is neither".
  if (texting && exclusive && !email) return "text_only";

  if (phone) return "phone";

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
}): boolean {
  if (typeof input.unreachableStartHour === "number") return true;
  return Boolean((input.availability ?? "").trim());
}

export type PhoneBranch =
  /** Ask when to call, then hand over on the next turn. */
  | "ask_callback_time"
  /** We know when. Notify a person and let them take it. */
  | "hand_to_human";

/**
 * What the phone branch should do this turn.
 *
 * Kate, 2026-09-18: "The bot cannot make a call, so a customer who wants to
 * speak is handed to a human — and the bot must GATHER THEIR CALLBACK TIME
 * PREFERENCE FIRST if it does not already have it. Ending without capturing
 * when to call is the defect."
 */
export function phoneBranch(input: {
  unreachableStartHour?: number | null;
  availability?: string | null;
}): PhoneBranch {
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
