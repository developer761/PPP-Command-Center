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
 * The address a user should be emailed at for notifications.
 *
 * `email: null` means they have not opted in — no row, disabled, or no address.
 *
 * `lookupFailed: true` means WE DO NOT KNOW. That is a third answer, and
 * collapsing it into "not opted in" is what this used to do: the query's
 * `error` was destructured away and the catch returned null, so a blip on
 * `commercial_user_email_prefs` was indistinguishable from a deliberate
 * opt-out, and nothing logged. Four people are opted in today — Brendan,
 * Stephanie, Katie and developer@ — so that silently downgrades real users to
 * bell-only for the duration, with no trace.
 *
 * WHY THIS DOES NOT FALL BACK TO THE PROFILE EMAIL ON FAILURE. One of the five
 * rows is `enabled = false`, an explicit opt-out. Guessing "email them anyway"
 * on an unreadable table would send unsolicited mail to the one person who
 * asked not to receive it — worse than a missed notification. So the email is
 * skipped and the failure is made VISIBLE instead of guessed at. The bell row
 * is unaffected either way, which is the part that must never be lost.
 */
export async function getEnabledNotifyEmail(
  userId: string
): Promise<{ email: string | null; lookupFailed: boolean; optedOut: boolean }> {
  try {
    const sb = adminClient();
    const { data, error } = await sb
      .from("commercial_user_email_prefs")
      .select("email, enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.warn(`[notify] email-pref lookup failed for ${userId}: ${error.message}`);
      return { email: null, lookupFailed: true, optedOut: false };
    }
    const row = data as { email?: string; enabled?: boolean } | null;
    /*
     * 🔴 AN OPT-OUT IS ITS OWN ANSWER, NOT AN ABSENT PREFERENCE.
     *
     * This returned `{ email: null, lookupFailed: false }` for all three of
     * "no row", "enabled = false" and "no address". The caller then does
     *
     *     pref.email ?? (alwaysEmail && !pref.lookupFailed ? profile.email : null)
     *
     * so for the three `alwaysEmail` kinds — approval_requested,
     * approval_decided, proposal-signed-for-approvers — a deliberate opt-out
     * fell through to the PROFILE address and was mailed anyway. One row in
     * this table is `enabled = false` today, it belongs to an active admin who
     * is also a proposal approver, and she was being emailed on every approval
     * event despite having turned it off on the settings page.
     *
     * The docblock above already argued this case correctly for the
     * lookup-failure path — "worse than a missed notification" — and the
     * implementation just did not distinguish it. So the distinction is now in
     * the return type, where a caller cannot ignore it by accident.
     *
     * "No row" still means no preference expressed, which `alwaysEmail` may
     * legitimately fill from the profile; that is the behaviour approvals rely
     * on for people who have never visited the settings page.
     */
    if (row?.enabled === false) {
      return { email: null, lookupFailed: false, optedOut: true };
    }
    if (!row || !row.email) return { email: null, lookupFailed: false, optedOut: false };
    return { email: row.email, lookupFailed: false, optedOut: false };
  } catch (err) {
    console.warn(
      `[notify] email-pref lookup threw for ${userId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { email: null, lookupFailed: true, optedOut: false };
  }
}
