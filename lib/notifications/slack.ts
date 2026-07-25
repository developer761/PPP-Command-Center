import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Per-user Slack delivery (Karan 2026-07-25). A user pastes their personal
 * Slack Incoming Webhook; when enabled, every Commercial notification that
 * lands in their bell is ALSO posted to their Slack. Fire-and-forget: a Slack
 * failure never blocks the bell/email path.
 *
 * The webhook URL is validated to be a real Slack incoming-webhook host so a
 * fat-fingered paste can't turn into an SSRF against an internal address.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** True if `url` is a well-formed Slack incoming-webhook URL. */
export function isValidSlackWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && u.hostname === "hooks.slack.com" && u.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");

/** POST a formatted message to a Slack incoming webhook. Returns ok + status
 *  so the settings "Send test" button can report a real result. Never throws. */
export async function postToSlackWebhook(
  webhookUrl: string,
  msg: { title: string; body?: string | null; link?: string | null }
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!isValidSlackWebhookUrl(webhookUrl)) {
    return { ok: false, error: "invalid_webhook_url" };
  }
  const absLink = msg.link ? (msg.link.startsWith("http") ? msg.link : `${APP_URL}${msg.link}`) : null;
  const lines = [`*${msg.title}*`];
  if (msg.body) lines.push(msg.body);
  if (absLink) lines.push(`<${absLink}|Open in Command Center →>`);

  const payload = {
    // Fallback text for notifications/screen readers.
    text: msg.title,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "PPP Commercial Command Center" }],
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Look up a user's enabled Slack webhook and post the notification. Called
 * fire-and-forget from the notification dispatcher AFTER the bell row is
 * written. No-op (silent) when the user hasn't configured Slack or disabled it.
 */
export async function postNotificationToUserSlack(
  userId: string,
  msg: { title: string; body?: string | null; link?: string | null }
): Promise<void> {
  try {
    const sb = adminClient();
    const { data } = await sb
      .from("commercial_user_slack")
      .select("webhook_url, enabled")
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as { webhook_url?: string; enabled?: boolean } | null;
    if (!row || row.enabled === false || !row.webhook_url) return;
    const result = await postToSlackWebhook(row.webhook_url, msg);
    if (!result.ok) {
      console.warn(
        `[slack] post to user ${userId.slice(0, 8)} failed: ${result.error ?? result.status}`
      );
    }
  } catch (err) {
    console.warn(`[slack] unexpected error for user ${userId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
