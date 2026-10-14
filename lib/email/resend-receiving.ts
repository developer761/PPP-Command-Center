/**
 * Reading a received email back out of Resend.
 *
 * Lives here rather than inside the inbound webhook because two callers need
 * it and they must not drift: the webhook, which fetches a body the moment a
 * reply lands, and the backfill, which repairs messages stored while this was
 * failing. One of those existing and the other guessing is how a repair
 * quietly stores something different from the live path.
 */
import { reportWarn } from "@/lib/observability";

/**
 * Fetch the parts the webhook deliberately leaves out.
 *
 * Resend's docs are explicit: "webhooks do not include the email body,
 * headers, or attachments, only their metadata." So the text we store in the
 * Mail Hub, and the In-Reply-To we thread on, both have to be pulled back.
 *
 *   GET https://api.resend.com/emails/receiving/{id}
 *
 * Soft. If the key is missing or the call fails we keep whatever the payload
 * carried and let the SUBJECT matcher thread it — a reply filed against the
 * right order with an empty body beats no reply at all. Never throws.
 */
export async function fetchReceivedEmail(emailId: string | null | undefined): Promise<{
  text: string | null;
  html: string | null;
  headers: Record<string, string> | null;
  messageId: string | null;
} | null> {
  if (!emailId) return null;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    reportWarn({
      key: "resend_inbound_no_api_key",
      message: "RESEND_API_KEY not set — inbound replies will store without a body",
      platform: "shared",
    });
    return null;
  }
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      reportWarn({
        key: "resend_inbound_fetch_failed",
        message: `Could not fetch inbound email ${emailId}: HTTP ${res.status}`,
        platform: "shared",
      });
      return null;
    }
    const j = (await res.json()) as {
      text?: string; html?: string;
      headers?: Record<string, string>; message_id?: string;
    };
    return {
      text: typeof j.text === "string" ? j.text : null,
      html: typeof j.html === "string" ? j.html : null,
      headers: j.headers ?? null,
      messageId: typeof j.message_id === "string" ? j.message_id : null,
    };
  } catch (err) {
    reportWarn({
      key: "resend_inbound_fetch_threw",
      message: `Fetching inbound email ${emailId} threw: ${err instanceof Error ? err.message : String(err)}`,
      platform: "shared",
    });
    return null;
  }
}
