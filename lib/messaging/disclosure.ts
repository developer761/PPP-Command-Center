/**
 * A46 — THE BOT NEVER CLAIMS TO BE A PERSON.
 *
 * Created 2026-09-25, and new: there is no AI disclosure anywhere in Hatch.
 * Its FAQ answers "Who am I talking to?" with "This is Emily with Precision
 * Painting Plus", and its prompt instructs the bot to say "I'm a real
 * person!". Retiring that instruction is the point of this rule.
 *
 * ── TWO WORDINGS, SPLIT BY WHETHER ANYONE IS ONLINE ─────────────────────
 *
 *   IN HOURS      the bot does not announce itself, and answers truthfully
 *                 only if asked.
 *   OUT OF HOURS  it discloses up front, unprompted, on the front of the
 *                 reply it was going to send anyway.
 *
 * Both strings below are APPROVED FINAL TEXT from the Iteration 1 Build
 * Spec, which says to build against them "byte for byte, straight
 * apostrophes included". They are not to be reworded, reflowed, or had their
 * punctuation tidied — the straight apostrophe in "I'm" is deliberate, and
 * the house style that prefers a typographic one does not apply to approved
 * copy. Tested byte-for-byte for that reason.
 *
 * ── THE OUT-OF-HOURS LINE CARRIES NO ASK, AND MUST NOT GROW ONE ─────────
 *
 * Spec: "An earlier draft offered a callback and then appended a question,
 * which stacks two asks in one message — A22's second failure shape is
 * exactly two questions a bare 'yes' cannot disambiguate. The approved
 * wording is a statement plus the reply already being sent, so it
 * contributes no ask of its own. Do not reintroduce an offer or a question
 * into the prefix — and no callback either: out of hours there is nobody to
 * connect them to, and a promise with no owner is worse than none."
 *
 * The in-hours string DOES end in a question, which is correct: it is the
 * whole message, replacing the reply rather than prefixing one, so there is
 * no second ask to collide with.
 *
 * ── WHY THIS IS NOT A COMPLIANCE FEATURE ────────────────────────────────
 *
 * Spec, settled 25 Sep: "We are not legally required to disclose —
 * California and New Jersey both write their rule around a bot on a website
 * or an app, and a text message is arguably neither. Build to the wording
 * anyway: it is how we have decided to come across." It applies in every
 * state, not only CA and NJ.
 */

/**
 * Sent ONLY in reply to being asked, during business hours.
 *
 * APPROVED FINAL TEXT. Byte for byte.
 */
export const DISCLOSURE_IN_HOURS =
  "I'm an AI assistant, but I can take your project details and get you set up with an estimator. Would you prefer to speak with a member of our team?";

/**
 * Prefixed to the reply already being sent, on the FIRST reply of an
 * out-of-hours conversation only.
 *
 * APPROVED FINAL TEXT. Byte for byte. Carries no ask — see the header.
 */
export const DISCLOSURE_OUT_OF_HOURS =
  "I'm an AI assistant, but I can take your project details and pass them along once we open.";


/**
 * ── SPANISH, AND IT IS NOT APPROVED COPY ────────────────────────────────
 *
 * A46's two strings are supplied in English only. But A30 says we answer
 * Spanish ourselves, and A46 says the bot "never denies being a bot, IN ANY
 * STATE" — so a Spanish speaker asking cannot be the one case that gets the
 * retired hand-off instead of an answer. That is what shipped before this:
 * the Spanish bot_suspected template still read "Permítame pasarlo con
 * alguien de nuestro equipo", which neither discloses nor keeps going.
 *
 * These are faithful translations in the usted register the rest of
 * render-es.ts uses. They are MINE, not Kate's, and they carry no approval.
 * Logged in docs/QUESTIONS_FOR_KATE.md for sign-off; if she supplies her own
 * wording, replace these byte for byte as with the English.
 */
export const DISCLOSURE_IN_HOURS_ES =
  "Soy un asistente de inteligencia artificial, pero puedo tomar los detalles de su proyecto y coordinarle una cita con un estimador. ¿Prefiere hablar con alguien de nuestro equipo?";

export const DISCLOSURE_OUT_OF_HOURS_ES =
  "Soy un asistente de inteligencia artificial, pero puedo tomar los detalles de su proyecto y pasarlos cuando abramos.";

export type DisclosureMove =
  /** Out of hours, first reply: prefix the approved line to the real reply. */
  | "prefix"
  /** They asked in hours: the approved line IS the message. */
  | "answer"
  /** Nothing to do. */
  | null;

/**
 * What A46 requires of this turn.
 *
 * `askedIfBot` is the model's own reading, carried by the bot_suspected
 * intent — the question is asked in too many ways to pattern-match safely,
 * and getting it wrong in the silent direction is the failure that matters.
 *
 * `outOfHours` is resolved against THE CUSTOMER's own callable window, never
 * one global "are we open" flag. Spec: "In hours is per customer, not per
 * clock… a single flag gets two of the six states wrong every evening." See
 * sending-window.ts, which owns that question.
 *
 * `alreadyDisclosed` stops the prefix repeating. Spec: "Out of hours the
 * prefix goes on the first reply of the conversation, followed by the reply
 * itself — not on every message."
 */
export function disclosureMove(input: {
  askedIfBot: boolean;
  outOfHours: boolean;
  alreadyDisclosed: boolean;
}): DisclosureMove {
  // Being asked outright is answered truthfully whatever the clock says. The
  // bot never denies being a bot, in any state.
  if (input.askedIfBot) return "answer";
  if (input.outOfHours && !input.alreadyDisclosed) return "prefix";
  return null;
}

/**
 * The message this turn actually sends.
 *
 * `reply` is whatever the renderer produced. The prefix goes in front of it,
 * separated by a single space, so the customer reads one message rather than
 * two stacked sentences that look like a system notice.
 */
export function applyDisclosure(move: DisclosureMove, reply: string, es = false): string {
  if (move === "answer") return es ? DISCLOSURE_IN_HOURS_ES : DISCLOSURE_IN_HOURS;
  if (move === "prefix") {
    const line = es ? DISCLOSURE_OUT_OF_HOURS_ES : DISCLOSURE_OUT_OF_HOURS;
    const body = reply.trim();
    return body ? `${line} ${body}` : line;
  }
  return reply;
}

/**
 * Has this conversation already carried the out-of-hours disclosure?
 *
 * Matched on the approved string itself rather than a flag column, so it
 * cannot drift out of step with what was actually sent — and so a message a
 * human sent carrying the line also counts.
 */
export function alreadyDisclosed(outbound: readonly string[]): boolean {
  return outbound.some(
    (m) => m.includes(DISCLOSURE_OUT_OF_HOURS) || m.includes(DISCLOSURE_OUT_OF_HOURS_ES)
  );
}
