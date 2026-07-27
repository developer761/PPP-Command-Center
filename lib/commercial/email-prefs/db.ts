import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { sendEmail } from "@/lib/email/resend";
import { isValidEmail } from "@/lib/notifications/email-prefs";

/**
 * Owner-scoped CRUD for a user's email-notification opt-in (Karan + Katie
 * 2026-07-27). Every function keys on the caller's own user_id — no cross-user
 * read/write path.
 */

export type UserEmailPref = {
  email: string;
  enabled: boolean;
  updated_at: string;
};

/** The current user's email pref, or null if they've never set one. */
export async function getUserEmailPref(userId: string): Promise<UserEmailPref | null> {
  try {
    const sb = commercialDb();
    const { data, error } = await sb
      .from("commercial_user_email_prefs")
      .select("email, enabled, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return data as UserEmailPref;
  } catch {
    return null;
  }
}

/** Save (upsert) the user's notification email. Validates the address. */
export async function saveUserNotifyEmail(input: {
  userId: string;
  email: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = input.email.trim();
  if (!isValidEmail(email)) {
    return { ok: false, error: "That doesn't look like a valid email address." };
  }
  try {
    const sb = commercialDb();
    const { error } = await sb
      .from("commercial_user_email_prefs")
      .upsert(
        { user_id: input.userId, email, enabled: true, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
    if (error) return { ok: false, error: "Couldn't save your email. Please try again." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save your email. Please try again." };
  }
}

/** Enable/disable email delivery without deleting the saved address. */
export async function setUserEmailEnabled(input: {
  userId: string;
  enabled: boolean;
}): Promise<{ ok: boolean }> {
  try {
    const sb = commercialDb();
    const { error } = await sb
      .from("commercial_user_email_prefs")
      .update({ enabled: input.enabled, updated_at: new Date().toISOString() })
      .eq("user_id", input.userId);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

/** Remove the saved email entirely. */
export async function deleteUserEmailPref(userId: string): Promise<{ ok: boolean }> {
  try {
    const sb = commercialDb();
    const { error } = await sb.from("commercial_user_email_prefs").delete().eq("user_id", userId);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

/** Send a test email to the saved address. */
export async function sendUserEmailTest(userId: string): Promise<{ ok: boolean; error?: string }> {
  const pref = await getUserEmailPref(userId);
  if (!pref?.email) return { ok: false, error: "No email saved yet." };
  const result = await sendEmail({
    to: pref.email,
    subject: "Email notifications are on",
    text: "You'll now get your PPP Commercial Command Center notifications at this address.\n\n— PPP Commercial Command Center",
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p><strong>Email notifications are on.</strong></p>
  <p>You'll now get your PPP Commercial Command Center notifications at this address, alongside the in-app bell.</p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center<br/>Manage this in Settings → Notifications.</p>
</div>`,
    channel: "commercial",
    tags: [{ name: "kind", value: "email_pref_test" }],
  });
  if (!result.ok) {
    return { ok: false, error: "Couldn't send the test email. Please try again in a moment." };
  }
  return { ok: true };
}
