/**
 * Where a customer's email reply goes, per workspace.
 *
 * REPLY-TO, NOT FROM. The column was always called reply_to_email, but the
 * scheduler used to put it in the From header. Resend only sends from a domain
 * it has verified, so the first person to type an ordinary team inbox into the
 * settings page would have had every email for that workspace refused at the
 * carrier, after it had already been scheduled. Mail goes out from the one
 * verified shared address; the workspace's own inbox is where the reply lands.
 *
 * It is also the only way a reply reaches anybody today: resend-inbound threads
 * supplier and customer-form replies and knows nothing about messaging
 * conversations, so a reply to the shared address sits unmatched in triage.
 *
 * ONE BARE ADDRESS. The value becomes a mail header. A newline in it is header
 * injection ("a@b.com\r\nBcc: everyone@…"), and a comma or angle brackets turn
 * one reply-to into several. Neither has a legitimate use here, so the shape
 * is narrow on purpose — the same rule the database CHECK enforces.
 *
 * Kept pure so it can be tested without a database or a carrier.
 */

/** RFC 5321 path limit. The CHECK constraint uses the same number. */
export const MAX_ADDRESS_LENGTH = 254;

// No whitespace, control characters, or anything that separates or quotes
// addresses. A dotted domain of letters, digits and hyphens.
const ADDRESS = /^[^\s\x00-\x1f\x7f@,;<>"()[\]\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export type ReplyToResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Check what somebody typed. Blank clears it, which is a valid answer: replies
 * then go to the shared address, as they do today.
 */
export function validateReplyTo(raw: string | null | undefined): ReplyToResult {
  // Trim spaces only. A trailing newline is not tidied away: it is refused
  // below with everything else that could end up in a header.
  const v = (raw ?? "").replace(/^ +| +$/g, "");
  if (v === "") return { ok: true, value: null };
  if (/[\x00-\x1f\x7f]/.test(v)) {
    return { ok: false, error: "That address contains a line break or a control character." };
  }
  if (v.length > MAX_ADDRESS_LENGTH) {
    return { ok: false, error: `An address can be at most ${MAX_ADDRESS_LENGTH} characters.` };
  }
  if (/[,;<>]/.test(v)) {
    return { ok: false, error: "One address only, without a name or angle brackets." };
  }
  if (!ADDRESS.test(v)) {
    return { ok: false, error: `"${v}" is not an email address.` };
  }
  const at = v.lastIndexOf("@");
  return { ok: true, value: v.slice(0, at) + "@" + v.slice(at + 1).toLowerCase() };
}

/**
 * The addresses an outgoing email actually carries.
 *
 * Re-checked at SEND time, not only at save: a row edited directly in the
 * database, or imported from Hatch, never passed through the form. A stored
 * value that fails is dropped, and the email still goes out from the shared
 * sender. A reply landing in triage is recoverable; an injected header is not.
 */
export function emailAddressesFor(input: {
  workspaceReplyTo: string | null | undefined;
  sharedFrom: string | null | undefined;
}): { from: string | null; replyTo: string | null } {
  const from = input.sharedFrom?.trim() || null;
  const r = validateReplyTo(input.workspaceReplyTo);
  return { from, replyTo: r.ok ? r.value : null };
}
