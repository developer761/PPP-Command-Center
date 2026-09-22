/**
 * What the carrier says happened to a message after we handed it over.
 *
 * delivery_status was written once as "sent" and never updated, and
 * failure_reason was never written at all. So a message the carrier filtered,
 * rejected, or could not deliver looked identical on every screen to one that
 * arrived — forever. The thread showed it, the reports counted it, and nobody
 * had any way to know the difference.
 *
 * That is survivable while nothing is live. It stops being survivable the day
 * the numbers port, because the single most likely failure on a fresh 10DLC
 * campaign is carrier FILTERING — messages accepted by Twilio, billed, and
 * silently dropped before the handset. The only signal is the status callback,
 * and without this the system had no way to receive it.
 *
 * Pure. The route does the writing.
 */

/** What our own column is allowed to hold (migration 180). */
export type DeliveryStatus = "queued" | "sent" | "delivered" | "failed" | "undelivered";

/**
 * Twilio's vocabulary, mapped onto ours.
 *
 * `sending` and `read` are Twilio states our column does not have: sending is
 * a sent that has not landed, and read is a delivered somebody opened, which
 * only happens on RCS/WhatsApp. Collapsing them loses nothing we report on.
 */
export function statusFromTwilio(raw: string | null | undefined): DeliveryStatus | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "queued":
    case "accepted":
    case "scheduled":
      return "queued";
    case "sending":
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "undelivered":
      return "undelivered";
    case "failed":
      return "failed";
    default:
      // An unknown status is not guessed at. Leaving the row alone is better
      // than writing a state the constraint refuses or the reports misread.
      return null;
  }
}

/** How far along each state is. Terminal failures sit outside the ladder. */
const RANK: Record<DeliveryStatus, number> = {
  queued: 0, sent: 1, delivered: 2, failed: 3, undelivered: 3,
};

/** A message that will never arrive. */
export function isFailure(s: DeliveryStatus): boolean {
  return s === "failed" || s === "undelivered";
}

/**
 * Should this status replace the one already stored?
 *
 * STATUS MUST NOT GO BACKWARDS. Twilio does not promise callbacks arrive in
 * order, and it retries them — so a late "sent" can land after "delivered" and
 * would otherwise un-deliver a message that arrived. A failure always wins,
 * because a message that failed is the fact worth keeping whenever the two
 * disagree.
 */
export function shouldApply(current: string | null | undefined, next: DeliveryStatus): boolean {
  if (isFailure(next)) return true;
  const c = current as DeliveryStatus | null | undefined;
  if (!c || !(c in RANK)) return true;
  if (isFailure(c)) return false;
  return RANK[next] > RANK[c];
}

/**
 * Twilio's error codes that mean a carrier refused the message, as opposed to
 * a bad number or an unreachable handset.
 *
 * 30007 is the one to watch after a port: "message filtered", which is a
 * carrier deciding the traffic looks like spam. On a new 10DLC campaign it is
 * the first sign that registration, throughput or content needs attention, and
 * it is invisible without this file.
 */
export const CARRIER_FILTERED = 30007;
export const UNREACHABLE = new Set([30003, 30005, 30006]);

export function failureNote(code: number | null, message: string | null): string {
  const base = message?.trim() || "no reason given";
  if (code === CARRIER_FILTERED) {
    return `${base} (${code}) — a carrier filtered this as spam, which on a new campaign usually means registration or content needs attention`;
  }
  if (code && UNREACHABLE.has(code)) {
    return `${base} (${code}) — the handset is unreachable, off, or not a mobile number`;
  }
  return code ? `${base} (${code})` : base;
}
