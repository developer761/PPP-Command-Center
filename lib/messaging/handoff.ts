/**
 * Handoff — the rules, with no database in them.
 *
 * Deliberately NOT a "use server" file. That module may export only async
 * functions: a single exported const silently drops every export in the
 * production build, which broke this app once already and which tsc cannot
 * see. Constants and pure logic live here; the actions live in
 * handoff-write.ts and import from this.
 */

/** The ten reasons migration 193's CHECK constraint allows, in the order a
 *  person scanning them would expect. */
export const TAKEOVER_REASONS = [
  "customer_asked_human",
  "complaint",
  "pricing_pressure",
  "out_of_scope",
  "media_received",
  "repeated_confusion",
  "language",
  "low_confidence",
  "manual_review",
  "other",
] as const;

export type TakeoverReason = (typeof TAKEOVER_REASONS)[number];

/** What each one means, in the words someone would actually use. */
export function takeoverReasonLabel(r: TakeoverReason): string {
  switch (r) {
    case "customer_asked_human":  return "They asked for a person";
    case "complaint":             return "They are unhappy";
    case "pricing_pressure":      return "They want a price";
    case "out_of_scope":          return "Work we do not do";
    case "media_received":        return "They sent a photo";
    case "repeated_confusion":    return "The bot is going in circles";
    case "language":              return "Not in English";
    case "low_confidence":        return "The bot was unsure";
    case "manual_review":         return "Sending it myself";
    case "other":                 return "Something else";
  }
}

export function isTakeoverReason(v: string): v is TakeoverReason {
  return (TAKEOVER_REASONS as readonly string[]).includes(v);
}

/**
 * Why the BOT handed a conversation over, from what it reported.
 *
 * Only two of the ten are ever attributable from the agent's own output: it
 * either fell under the confidence threshold, which is exactly
 * 'low_confidence', or it chose to escalate for a reason it does not name. The
 * rest describe something a person recognises — a complaint, a photo, a
 * language — and guessing between them would fill the reporting column with
 * confident nonsense.
 *
 * So an unexplained escalation is 'other' and stays 'other' until somebody
 * claims it and says what it actually was.
 */
export function takeoverReasonFor(input: {
  intent: string;
  confidence: number;
  threshold: number;
}): TakeoverReason {
  if (input.intent === "escalate") return "other";
  if (input.confidence < input.threshold) return "low_confidence";
  return "other";
}

/**
 * Where a conversation goes when a person hands it back.
 *
 * It cannot simply return to 'ai_active', because that state means the bot owes
 * a reply. If the human already answered, the bot owes nothing and the
 * conversation is waiting on the customer — putting it back in 'ai_active'
 * would queue a second reply to a message that has been answered, which reads
 * to the customer as the bot not listening.
 */
export function stateOnRelease(lastDirection: "inbound" | "outbound" | null):
  "ai_active" | "awaiting_customer" {
  return lastDirection === "outbound" ? "awaiting_customer" : "ai_active";
}

/**
 * Does the bot still owe this conversation a reply?
 *
 * The last message being OUTBOUND means somebody already answered — a person
 * who took the conversation over, a campaign step, or the bot itself. In every
 * one of those cases there is nothing left to reply to.
 *
 * THE BUG THIS CLOSES needs the whole sequence to see:
 *
 *   A customer texts and an agent_turn is queued. A person claims the
 *   conversation, so the turn is DEFERRED an hour rather than cancelled —
 *   correctly, since they may hand it straight back. The person answers the
 *   customer themselves and releases. stateOnRelease sees an outbound last
 *   message and returns 'awaiting_customer', which is right, and because that
 *   is not 'ai_active' nothing re-queues and nothing cancels. An hour later
 *   the deferred turn runs. draftReply guarded only 'ended' and 'human_active'
 *   and the conversation is now neither — so Emily answers a message a person
 *   has already answered.
 *
 *   Worse: `history.slice(0, -1)` assumes the last message is the customer's,
 *   so the human's reply was stripped out of the transcript and the model was
 *   told the customer had just sent the message it had already been answered.
 *
 * Checking the TRANSCRIPT rather than the state is what makes this hold. State
 * cannot carry it: a conversation sitting in 'awaiting_customer' must still get
 * a turn when the customer writes again, so that state on its own is no reason
 * to stay quiet. A reply already sitting after their last word is.
 */
export function latestInboundIsAnswered(
  msgs: { direction: string; created_at: string }[]
): boolean {
  if (!msgs.length) return true; // nothing said, nothing owed
  let last = msgs[0];
  for (const m of msgs) {
    if (new Date(m.created_at).getTime() >= new Date(last.created_at).getTime()) last = m;
  }
  return last.direction === "outbound";
}

/** How long somebody has been sitting on a conversation, in plain words. */
export function heldFor(since: string, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
