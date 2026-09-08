/**
 * What to do with a message a customer just sent us.
 *
 * Deliberately decides and does not act. The route does the writing; this
 * decides what the writing should be, so every branch is testable without a
 * database or a network — and the branches are the part that matters, because
 * one of them is somebody telling us to stop.
 *
 * ORDER IS THE WHOLE DESIGN HERE. Opt-out is decided before threading, before
 * the workspace lookup, before anything that can fail. A STOP that is dropped
 * because we could not work out which conversation it belonged to is a STOP we
 * ignored, and "we could not match your number to a campaign" is not a defence
 * anybody has ever accepted. Suppression is keyed on the handset alone for the
 * same reason.
 */
import { classifyInbound } from "./compliance";
import { toE164, type E164 } from "./phone";

/** The shape AWS End User Messaging publishes to SNS for an inbound SMS. */
export type EumInbound = {
  originationNumber?: string;
  destinationNumber?: string;
  messageBody?: string;
  inboundMessageId?: string;
  messageKeyword?: string;
  /** Present on MMS. We never fetch the media; that it EXISTS is what the
   *  agent reasons about, and fetching customer photos server-side is a
   *  storage and privacy problem nobody has asked for. */
  mediaUrls?: string[];
};

/**
 * Why a message was dropped, WITHOUT the value that caused it.
 *
 * The reason string names the offending number so a person debugging has
 * something to go on, and that string was going straight into a Slack alert —
 * which put a customer's handset into a chat channel. The code is what gets
 * logged; the reason stays in the HTTP response, which only AWS ever reads.
 */
export type RejectCode =
  | "bad_origination" | "bad_destination" | "empty_message" | "no_message_id";

export type InboundDecision =
  | { kind: "reject"; code: RejectCode; reason: string }
  | {
      kind: "accept";
      from: E164;
      to: E164;
      body: string;
      providerId: string;
      mediaCount: number;
      /** Set when the customer is opting out or asking for help. Handled
       *  before anything else and never answered by the agent — the carrier
       *  replies to both, and a second reply is a second message to somebody
       *  who just asked for fewer. */
      keyword: "opt_out" | "opt_in" | "help" | null;
    };

export function decideInbound(raw: EumInbound): InboundDecision {
  const from = toE164(raw.originationNumber);
  const to = toE164(raw.destinationNumber);

  // Refuse rather than guess. A message we cannot attribute to a real handset
  // cannot be suppressed later either, so storing it half-known is worse than
  // not storing it.
  if (!from) return { kind: "reject", code: "bad_origination", reason: `origination number "${raw.originationNumber ?? ""}" is not a usable phone number` };
  if (!to) return { kind: "reject", code: "bad_destination", reason: `destination number "${raw.destinationNumber ?? ""}" is not a usable phone number` };

  const body = (raw.messageBody ?? "").trim();
  const mediaCount = raw.mediaUrls?.length ?? 0;
  if (!body && mediaCount === 0) return { kind: "reject", code: "empty_message", reason: "message has no text and no media" };

  // The provider id is what makes this idempotent — SNS delivers at least
  // once, so the same reply can arrive twice.
  const providerId = raw.inboundMessageId?.trim();
  if (!providerId) return { kind: "reject", code: "no_message_id", reason: "no inbound message id, so a retry could not be recognised" };

  // AWS reports the keyword it matched, but its list is not PPP's list, so our
  // own classifier is authoritative and AWS's is only a fallback for a body we
  // read as ordinary text.
  const narrow = (v: ReturnType<typeof classifyInbound>) =>
    v === "normal" ? null : v;

  const keyword = narrow(classifyInbound(body))
    ?? (raw.messageKeyword ? narrow(classifyInbound(raw.messageKeyword)) : null);

  return { kind: "accept", from, to, body, providerId, mediaCount, keyword };
}
