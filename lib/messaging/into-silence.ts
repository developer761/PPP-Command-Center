/**
 * A message that may land with nobody having said anything.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────
 *
 * A28: "A message sent into SILENCE must read as a close, not as a reply.
 * Never open with 'Got it' / 'Perfect' / 'Great' when no customer message
 * preceded it."
 *
 * ── WHERE IT CAN ACTUALLY HAPPEN HERE, WHICH IS NARROW ──────────────────
 *
 * The agent cannot do this. scheduler-db refuses an agent turn whenever the
 * most recent message is outbound (latestInboundIsAnswered), so every turn the
 * model takes is a reply to something a customer just said. That is a
 * structural guarantee, not a habit, and A28 cannot be breached through it.
 *
 * Campaign steps are the exception, because they fire on a schedule rather
 * than in response to anything. A day-1 follow-up goes out whether or not the
 * customer ever replied to the opener, so its body must read as a follow-up
 * rather than as an answer to a message that was never sent.
 *
 * And only the OPENER's body is validated today. campaign-write checks
 * firstMessageProblem when the step is the opener and checks nothing at all
 * otherwise, so a follow-up body is the one piece of customer-facing text in
 * the system with no check on it — and it is exactly the text A28 governs.
 *
 * Pure.
 */

/**
 * Openers that acknowledge something.
 *
 * Every one of these is quoted in Kate's A28 findings as the actual first
 * words of a message that went into silence: "Got it.", "Perfect", "Great",
 * "You're...", "To...", "I hear you."
 *
 * Anchored to the START of the message, because that is where the rule is.
 * "Got it" in the middle of a sentence is not what she is describing, and
 * matching it anywhere would fail bodies that are perfectly fine.
 */
const ACKNOWLEDGING_OPENER =
  /^\s*(?:got it|perfect|great|awesome|excellent|wonderful|sounds good|understood|noted|thanks for (?:that|letting|sharing|confirming)|i hear you|you'?re (?:welcome|all set)|happy to help|no problem|absolutely|of course|sure thing|okay|ok|yes|yep|right)\b/i;

/**
 * Why this body must not be sent into silence, or null when it is fine.
 *
 * Returns the offending words so the person editing the step can see what to
 * change, rather than being told the rule and left to guess.
 */
export function silenceOpenerProblem(body: string | null | undefined): string | null {
  const t = (body ?? "").trim();
  if (!t) return null; // emptiness is a different check's problem

  const m = ACKNOWLEDGING_OPENER.exec(t);
  if (!m) return null;

  return (
    `This step can go out when the customer has not replied to anything, so it cannot open ` +
    `with "${m[0].trim()}" — that reads as an answer to a message they never sent. ` +
    `Open it as a follow-up instead, the way "Just following up on your estimate request" does.`
  );
}
