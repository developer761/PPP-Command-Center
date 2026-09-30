/**
 * A45 — THE ONLY TWO THINGS THAT CROSS BETWEEN US AND THE CALL CENTRE.
 *
 * Iteration 1 spec: "Two notifications to the call centre on one
 * conversation. Pause when the customer replies on text or email. Resume if
 * that conversation is still stale at the end of A44's follow-up cadence."
 *
 * Why it exists: "Two teams were working the same customer on two channels
 * with no signal between them. It is the one place the Hub and the call
 * centre are wired together, and it runs in that direction only."
 *
 * ── THREE THINGS THAT ARE EASY TO BUILD WRONG ───────────────────────────
 *
 * 🔴 ONE PAUSE PER CONVERSATION, NOT ONE PER REPLY. Spec: "a customer who
 * sends four messages does not generate four pauses." So the signal is
 * derived from whether a pause has ALREADY been sent, not from the reply.
 *
 * 🔴 A PAUSE IS TEMPORARY; A25 IS PERMANENT. Spec: "A25 fires when the
 * customer names a channel and asks to come off the phone for good. This
 * fires on any reply and lifts by itself. Do not implement one as the
 * other." They are different rules with different lifetimes, and
 * channel-preference.ts owns the other one.
 *
 * 🔴 NEITHER SIGNAL WRITES ANYTHING. Spec: "Neither signal edits the call
 * cadence itself, and neither writes anything to Salesforce." This module
 * returns a value; it does not act.
 *
 * ── WHO OWNS THE FAILURE, FOR THE RATER ─────────────────────────────────
 *
 * Spec: "A45 is the pause only; the hand-back is A44's, as shape (5) in its
 * rating guidance, so a lead never handed back is an A44 defect, not an A45
 * one. A45 carries zero defects and zero good turns in the corpus,
 * correctly — Hatch had no such capability, so a rater producing A45
 * findings on this corpus is miscalibrated."
 *
 * ── DELIVERY IS A SEAM ON PURPOSE ───────────────────────────────────────
 *
 * Spec: "How the notification is delivered is deliberately unspecified and is
 * not a blocker. Build the two signals with the destination left as a seam.
 * Each one carries the lead, the conversation, and which of the two signals
 * it is." So that is exactly the shape below, and nothing here chooses a
 * transport.
 *
 * Pure.
 */

export type CallSignalKind = "pause_calling" | "resume_calling" | "remove_from_cadence";

/**
 * What crosses. The spec names the three fields and no more.
 */
export type CallSignal = {
  kind: CallSignalKind;
  /** The lead this is about, as Salesforce knows it. */
  leadId: string | null;
  /** The conversation it came from, as the Hub knows it. */
  conversationId: string;
  /** Why, in words, for whoever reads the queue. Never a CRM disposition. */
  note: string;
};

/**
 * A25 — THE CUSTOMER NAMED A CHANNEL AND WANTS OFF THE PHONE FOR GOOD.
 *
 * Kate's spec: "the bot continues the conversation in that channel and sends
 * a notification to the team to remove them from the Salesforce call
 * cadence", and, settled 24 September, "this stays a notification and an
 * agent removes them in Salesforce — build the signal, not the cadence edit."
 *
 * PERMANENT, and not to be confused with the pause below. The spec says so
 * outright because the two have already been read as one: "A pause is
 * temporary; A25 is permanent… This fires on any reply and lifts by itself.
 * Do not implement one as the other."
 *
 * The note says what they asked for, never what it means for the lead. They
 * have said how they want to be contacted, not that they are uninterested,
 * and a notification reading "this lead is done" is the failure to avoid.
 */
export function removeFromCadence(input: {
  conversationId: string;
  leadId: string | null;
  preference: "text_only" | "email_only";
}): CallSignal {
  const channel = input.preference === "email_only" ? "email" : "text";
  return {
    kind: "remove_from_cadence",
    conversationId: input.conversationId,
    leadId: input.leadId,
    note: `The customer asked to be contacted by ${channel} rather than by phone. `
      + `They are still in conversation — this is how they want to be reached, not a `
      + `change of interest. Someone needs to take them off the call cadence in Salesforce.`,
  };
}

/**
 * Should a PAUSE go out for this reply?
 *
 * Null means no — either one has already gone, or this is not a customer
 * reply. Deliberately keyed on `alreadyPaused` rather than on the reply
 * count, so four messages produce one signal however they arrive.
 */
export function pauseOnReply(input: {
  conversationId: string;
  leadId: string | null;
  alreadyPaused: boolean;
  /** True when the inbound came from the customer on text or email. */
  customerReplied: boolean;
}): CallSignal | null {
  if (!input.customerReplied) return null;
  if (input.alreadyPaused) return null;
  return {
    kind: "pause_calling",
    leadId: input.leadId,
    conversationId: input.conversationId,
    note: "The customer replied to us, so they are in conversation on text or email. Hold the call cadence.",
  };
}

/**
 * Should a RESUME go out now the cadence is spent?
 *
 * Two conditions, and both matter. Spec: "The resume signal fires only at the
 * end of A44's cadence, and only where the customer was never reached." And:
 * "A conversation that ends properly is not a resume."
 *
 * The note is worded carefully. Spec: "Reaching the end of the cadence is a
 * resume-calling signal, not a disposition — nothing about the lead has
 * changed and no CRM decision is owed. A notification that reads as 'this
 * lead is done' is the failure to avoid."
 */
export function resumeAfterCadence(input: {
  conversationId: string;
  leadId: string | null;
  /** All three follow-ups have gone out. */
  cadenceSpent: boolean;
  /** The customer never replied to any of them. */
  everReplied: boolean;
  /** A resume has already gone for this conversation. */
  alreadyResumed: boolean;
}): CallSignal | null {
  if (!input.cadenceSpent) return null;
  if (input.everReplied) return null;
  if (input.alreadyResumed) return null;
  return {
    kind: "resume_calling",
    leadId: input.leadId,
    conversationId: input.conversationId,
    // Says what happened on OUR side and asks for the cadence back. It does
    // not say anything about the lead.
    note: "Our three follow-ups went unanswered, so the conversation is back with you. Resume the call cadence.",
  };
}

/**
 * HANDING IT BACK WITHOUT HAVING CHASED AT ALL.
 *
 * A40, Kate 2026-09-28: "A CUSTOMER WHO ASKS NOT TO BE CHASED GETS NO
 * CADENCE. Hand the conversation to the call centre and leave it. Following
 * up is the breach."
 *
 * The same kind of signal as the one above, and a different sentence, because
 * that one says "our three follow-ups went unanswered" and here none was
 * sent. Reusing it would tell the call centre we had chased somebody who
 * asked us not to — and this note is the only record of why the conversation
 * moved, so being wrong about what happened is worse than saying nothing.
 *
 * It also says what the request covered. Somebody who asked not to be chased
 * by TEXT has not asked the call centre to stay away, and the note must not
 * let anyone read it that way.
 */
export function resumeWithoutChasing(input: {
  conversationId: string;
  leadId: string | null;
}): CallSignal {
  return {
    kind: "resume_calling",
    leadId: input.leadId,
    conversationId: input.conversationId,
    note: "The customer asked us not to follow up, so no follow-ups were sent and the "
      + "conversation is back with you. That was about the texting, not about calls.",
  };
}

/**
 * A note that reads as a verdict on the lead is the failure the spec names.
 * Exported so the wording can be tested rather than trusted.
 */
export function readsAsADisposition(note: string): boolean {
  return /\b(?:dead|done|closed|lost|unqualified|disqualif\w*|do not (?:call|contact)|write.?off|give up|no longer)\b/i.test(note);
}
