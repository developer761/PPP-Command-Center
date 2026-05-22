import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Profile = Supabase user × Salesforce User × admin flag. The bridge that
 * lets us scope every page's data to "what the viewer is allowed to see."
 *
 * Synced on every sign-in via /auth/callback so admin-list changes and SF
 * deactivations propagate within one login cycle.
 */

export type Profile = {
  user_id: string;
  email: string;
  sf_user_id: string | null;
  sf_user_name: string | null;
  is_admin: boolean;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Service-role client — bypasses RLS for the auth callback's profile sync. */
function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Read a profile by Supabase user id. Returns null if not yet synced. */
export async function getProfileByUserId(userId: string): Promise<Profile | null> {
  const sb = adminClient();
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[auth] getProfile failed:", error.message);
    return null;
  }
  return data as Profile | null;
}

/**
 * Upsert a profile row. Called by /auth/callback on every login to keep the
 * row in sync with current SF state + current admin-list env var.
 */
export async function upsertProfile(input: {
  user_id: string;
  email: string;
  sf_user_id: string | null;
  sf_user_name: string | null;
  is_admin: boolean;
  is_active: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = adminClient();
  const { error } = await sb
    .from("profiles")
    .upsert(
      {
        ...input,
        last_login_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
  if (error) {
    console.error("[auth] upsertProfile failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Log an admin "view as" event for the audit trail. Append-only — never updates
 * existing rows. Best-effort: if the insert fails (e.g., transient DB blip), we
 * log to console but don't block the request.
 */
export async function logViewAs(input: {
  admin_user_id: string;
  admin_email: string;
  target_sf_user_id: string;
  target_label: string | null;
  path: string | null;
  user_agent: string | null;
  ip_address: string | null;
}): Promise<void> {
  try {
    const sb = adminClient();
    const { error } = await sb.from("view_as_audit").insert({
      admin_user_id: input.admin_user_id,
      admin_email: input.admin_email,
      target_sf_user_id: input.target_sf_user_id,
      target_label: input.target_label,
      action: "view",
      path: input.path,
      user_agent: input.user_agent,
      ip_address: input.ip_address,
    });
    if (error) console.error("[auth] logViewAs failed:", error.message);
  } catch (err) {
    console.error("[auth] logViewAs threw:", err);
  }
}
