import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { isValidSlackWebhookUrl, postToSlackWebhook } from "@/lib/notifications/slack";

/**
 * Owner-scoped CRUD for a user's personal Slack webhook (Block 3B follow-up,
 * Karan 2026-07-25). Every function keys on the caller's own user_id — there
 * is no cross-user read/write path.
 */

export type UserSlackConfig = {
  webhook_url: string;
  enabled: boolean;
  updated_at: string;
};

/** The current user's Slack config, or null if they've never set one. */
export async function getUserSlackConfig(userId: string): Promise<UserSlackConfig | null> {
  try {
    const sb = commercialDb();
    const { data, error } = await sb
      .from("commercial_user_slack")
      .select("webhook_url, enabled, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return data as UserSlackConfig;
  } catch {
    return null;
  }
}

/** Save (upsert) the user's webhook URL. Validates it's a real Slack webhook. */
export async function saveUserSlackWebhook(input: {
  userId: string;
  webhookUrl: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = input.webhookUrl.trim();
  if (!isValidSlackWebhookUrl(url)) {
    return {
      ok: false,
      error: "That doesn't look like a Slack webhook URL. It should start with https://hooks.slack.com/services/",
    };
  }
  try {
    const sb = commercialDb();
    const { error } = await sb
      .from("commercial_user_slack")
      .upsert(
        { user_id: input.userId, webhook_url: url, enabled: true, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
    if (error) return { ok: false, error: "Couldn't save your Slack webhook. Please try again." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save your Slack webhook. Please try again." };
  }
}

/** Enable/disable Slack delivery without deleting the saved webhook. */
export async function setUserSlackEnabled(input: {
  userId: string;
  enabled: boolean;
}): Promise<{ ok: boolean }> {
  try {
    const sb = commercialDb();
    const { error } = await sb
      .from("commercial_user_slack")
      .update({ enabled: input.enabled, updated_at: new Date().toISOString() })
      .eq("user_id", input.userId);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

/** Remove the saved webhook entirely. */
export async function deleteUserSlackWebhook(userId: string): Promise<{ ok: boolean }> {
  try {
    const sb = commercialDb();
    const { error } = await sb.from("commercial_user_slack").delete().eq("user_id", userId);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

/** Post a test message to the user's saved webhook. */
export async function sendUserSlackTest(userId: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getUserSlackConfig(userId);
  if (!cfg?.webhook_url) return { ok: false, error: "No Slack webhook saved yet." };
  const result = await postToSlackWebhook(cfg.webhook_url, {
    title: "✅ Slack is connected",
    body: "You'll now get your PPP Commercial Command Center notifications here.",
    link: "/commercial/notifications",
  });
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "invalid_webhook_url"
          ? "The saved webhook URL is invalid."
          : `Slack rejected the test${result.status ? ` (HTTP ${result.status})` : ""}. Double-check the webhook URL.`,
    };
  }
  return { ok: true };
}
