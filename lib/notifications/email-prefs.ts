import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Per-user email-notification opt-in (Karan + Katie 2026-07-27). Notifications
 * always land in the bell/inbox; email is an opt-in extra. A user sets an email
 * address + turns it on, and the dispatcher then ALSO emails their commercial
 * notifications there. No pref (or disabled) → no email, bell only.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Basic RFC-ish email shape check — good enough to reject fat-fingered input. */
export function isValidEmail(email: string): boolean {
  const e = email.trim();
  if (e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * The address a user should be emailed at for notifications, or null if they
 * haven't opted in (no row or disabled). Called by the notification dispatcher.
 */
export async function getEnabledNotifyEmail(userId: string): Promise<string | null> {
  try {
    const sb = adminClient();
    const { data } = await sb
      .from("commercial_user_email_prefs")
      .select("email, enabled")
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as { email?: string; enabled?: boolean } | null;
    if (!row || row.enabled === false || !row.email) return null;
    return row.email;
  } catch {
    return null;
  }
}
