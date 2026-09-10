/**
 * Drafts waiting for a person, and what a reviewer needs to know about them.
 *
 * Pure. The queue shape, staleness, and the wording of why something is here.
 */

export type DraftReviewReason =
  | "autosend_off" | "low_confidence" | "escalated" | "negative_reaction" | "first_contact";

export type DraftForReview = {
  id: string;
  conversationId: string;
  workspaceName: string;
  customerPhone: string;
  customerName: string | null;
  intent: string | null;
  confidence: number | null;
  reasoning: string | null;
  body: string;
  reviewReason: DraftReviewReason;
  createdAt: string;
  /** The inbound this replies to. */
  answersMessageId: string | null;
  /** The most recent inbound on the conversation right now. */
  latestInboundId: string | null;
  latestInboundAt: string | null;
};

/**
 * Why a person is looking at this, in words rather than a column value.
 *
 * Kate should not have to learn an enum to understand her own queue, and the
 * reason changes what she is actually being asked. "The bot was unsure" is a
 * request for judgement; "nothing sends without you yet" is a request for a
 * rubber stamp, and reading one as the other wastes her time or hers ours.
 */
export function reviewReasonText(reason: DraftReviewReason): string {
  switch (reason) {
    case "low_confidence":    return "The bot was not confident about this one.";
    case "escalated":         return "The bot asked for a person.";
    case "negative_reaction": return "The customer reacted badly to the last message.";
    case "first_contact":     return "This is the first thing we would ever send them.";
    case "autosend_off":      return "Nothing sends without you while we are testing.";
  }
}

/**
 * A draft is STALE when the customer has said something since it was written.
 *
 * Sending it then answers a question they have already moved past, which is
 * the exact "nobody is reading" failure Kate graded conversations down for.
 * Worth catching in the UI rather than at send time, because by send time the
 * reviewer has already decided.
 */
export function isStale(d: DraftForReview): boolean {
  if (!d.latestInboundId) return false;
  return d.latestInboundId !== d.answersMessageId;
}

/**
 * Oldest first — a queue where the longest-waiting customer is last is not a
 * queue. Stale ones surface first within that, because they need a decision
 * that is not "send".
 */
export function orderQueue(drafts: DraftForReview[]): DraftForReview[] {
  return [...drafts].sort((a, b) => {
    const s = Number(isStale(b)) - Number(isStale(a));
    if (s !== 0) return s;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/** How long somebody has been waiting, for the screen to show plainly. */
export function waitingSeconds(d: DraftForReview, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - new Date(d.createdAt).getTime()) / 1000));
}

/**
 * Did the reviewer change it, ignoring whitespace they did not mean to add.
 *
 * Only a real edit is worth storing as a correction — recording "they added a
 * trailing space" as a training signal would bury the ones that matter.
 */
export function wasEdited(original: string, sent: string): boolean {
  return original.trim().replace(/\s+/g, " ") !== sent.trim().replace(/\s+/g, " ");
}

/** Plain English for a gate refusal, for a reviewer rather than a log. */
export function refusalText(reason: string): string {
  switch (reason) {
    case "suppressed":          return "This person has opted out. Nothing can be sent to them.";
    case "quiet_hours":         return "It is outside this workspace's sending hours. It will go out when they reopen.";
    case "weekend":             return "This workspace does not send at weekends.";
    case "daily_cap":           return "They have already had the maximum messages for today.";
    case "no_workspace_number": return "This workspace has no phone number, so it cannot send.";
    case "no_email_address":    return "There is no email address to send to.";
    case "empty_body":          return "There is nothing to send.";
    default:                    return `The send was refused: ${reason}.`;
  }
}
