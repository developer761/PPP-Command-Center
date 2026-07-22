import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { invalidateProfileCache } from "@/lib/auth/profile";
import { normalizeEmail } from "@/lib/auth/admin";
import { normalizeRole, type UserRole } from "@/lib/auth/roles";

/**
 * Admin-provisioned user management for the Settings → Access tab.
 *
 * An admin creates an account with an email + a password we set; the person
 * then signs in with those credentials (no Google needed). Roles gate what
 * they see. All writes go through the Supabase service-role client and are
 * append-only audited in `access_audit`.
 *
 * Safety rails: never demote/deactivate/delete the LAST admin, and never let
 * an admin lock THEMSELVES out (deactivate/demote self is blocked at the API).
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type ManagedUser = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  auth_provider: "google" | "password";
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
};

export type ActorMeta = { user_id: string; email: string };

type Result = { ok: true } | { ok: false; error: string; code?: string };
type CreateResult =
  | { ok: true; user_id: string }
  | { ok: false; error: string; code?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

export function validateEmail(raw: string): string | null {
  const e = normalizeEmail(raw);
  return EMAIL_RE.test(e) ? e : null;
}

export function validatePassword(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LEN) {
    return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
  }
  return null;
}

function mapRow(row: Record<string, unknown>): ManagedUser {
  const provider =
    row.auth_provider === "password" ? "password" : "google";
  return {
    user_id: String(row.user_id),
    email: String(row.email ?? ""),
    full_name: (row.full_name as string | null) ?? (row.sf_user_name as string | null) ?? null,
    role: normalizeRole((row.role as string | null) ?? null, row.is_admin === true),
    auth_provider: provider,
    is_active: row.is_active !== false,
    last_login_at: (row.last_login_at as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

/** All accounts, newest first (admins → managers → reps within that). */
export async function listManagedUsers(): Promise<ManagedUser[]> {
  const sb = adminClient();
  const { data, error } = await sb
    .from("profiles")
    .select(
      "user_id,email,full_name,sf_user_name,role,is_admin,auth_provider,is_active,last_login_at,created_at"
    )
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[access] listManagedUsers failed:", error.message);
    return [];
  }
  return (data ?? []).map(mapRow);
}

/** Count active admins — used to protect the last-admin invariant. */
async function activeAdminCount(): Promise<number> {
  const sb = adminClient();
  const { count, error } = await sb
    .from("profiles")
    .select("user_id", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("is_active", true);
  if (error) {
    console.error("[access] activeAdminCount failed:", error.message);
    // Fail safe: report >1 so a transient error can't unblock a last-admin
    // demotion. The caller only uses this to BLOCK, so a high value is safe.
    return 99;
  }
  return count ?? 0;
}

async function getRow(userId: string): Promise<ManagedUser | null> {
  const sb = adminClient();
  const { data, error } = await sb
    .from("profiles")
    .select(
      "user_id,email,full_name,sf_user_name,role,is_admin,auth_provider,is_active,last_login_at,created_at"
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data);
}

async function audit(input: {
  actor: ActorMeta;
  action: string;
  target_user_id: string | null;
  target_email: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const sb = adminClient();
    await sb.from("access_audit").insert({
      actor_user_id: input.actor.user_id,
      actor_email: input.actor.email,
      action: input.action,
      target_user_id: input.target_user_id,
      target_email: input.target_email,
      detail: input.detail ?? null,
    });
  } catch (err) {
    console.error("[access] audit insert threw:", err);
  }
}

/** Provision a new email+password account with a role. */
export async function createPasswordUser(input: {
  email: string;
  password: string;
  full_name: string | null;
  role: UserRole;
  actor: ActorMeta;
}): Promise<CreateResult> {
  const email = validateEmail(input.email);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  const pwErr = validatePassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };
  const role = normalizeRole(input.role);
  const full_name = input.full_name?.trim() || null;

  const sb = adminClient();

  // Guard against a duplicate profile (same person already provisioned).
  const { data: existing } = await sb
    .from("profiles")
    .select("user_id,email")
    .ilike("email", email)
    .maybeSingle();
  if (existing) {
    return {
      ok: false,
      code: "exists",
      error: "An account with that email already exists.",
    };
  }

  // Create the auth user with the admin-set password.
  const { data: created, error: createErr } =
    await sb.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: full_name ? { full_name } : undefined,
      // Stable JWT marker so the proxy/middleware domain guard lets this
      // account in even on a non-PPP-domain email (no per-request DB hit).
      app_metadata: { provisioned: true },
    });

  let authUserId = created?.user?.id ?? null;

  if (createErr || !authUserId) {
    // The email may already exist in auth.users (e.g. they signed in with
    // Google before) even though no profile row exists. Link to that user
    // instead of failing — then just set/reset their password + profile.
    const linked = await findAuthUserByEmail(email);
    if (!linked) {
      return {
        ok: false,
        error: createErr?.message ?? "Could not create the account.",
      };
    }
    authUserId = linked;
    // Set the password on the existing auth user so email+password works,
    // and stamp the provisioned marker for the domain-guard bypass.
    const { error: pwSetErr } = await sb.auth.admin.updateUserById(authUserId, {
      password: input.password,
      app_metadata: { provisioned: true },
    });
    if (pwSetErr) {
      return { ok: false, error: pwSetErr.message };
    }
  }

  // Upsert the profile row with the role. Mirror is_admin for legacy paths.
  const { error: profErr } = await sb.from("profiles").upsert(
    {
      user_id: authUserId,
      email,
      full_name,
      role,
      is_admin: role === "admin",
      auth_provider: "password",
      is_active: true,
    },
    { onConflict: "user_id" }
  );
  if (profErr) {
    return { ok: false, error: profErr.message };
  }

  invalidateProfileCache(authUserId);
  await audit({
    actor: input.actor,
    action: "create_user",
    target_user_id: authUserId,
    target_email: email,
    detail: { role, full_name },
  });

  return { ok: true, user_id: authUserId };
}

/** Find an auth.users id by email (paginates the admin list). */
async function findAuthUserByEmail(email: string): Promise<string | null> {
  const sb = adminClient();
  const target = normalizeEmail(email);
  // The admin list API is paginated; scan a few pages defensively.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) break;
    const hit = data.users.find(
      (u) => normalizeEmail(u.email ?? "") === target
    );
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

/** Change a user's role (also mirrors is_admin). Protects the last admin. */
export async function updateUserRole(input: {
  user_id: string;
  role: UserRole;
  actor: ActorMeta;
}): Promise<Result> {
  const role = normalizeRole(input.role);
  const current = await getRow(input.user_id);
  if (!current) return { ok: false, error: "User not found." };
  if (current.role === role) return { ok: true };

  // Block self-demotion out of admin (avoid locking yourself out).
  if (input.user_id === input.actor.user_id && role !== "admin") {
    return {
      ok: false,
      error: "You can't change your own role. Ask another admin.",
    };
  }
  // Block demoting the last active admin.
  if (current.role === "admin" && role !== "admin") {
    if ((await activeAdminCount()) <= 1) {
      return {
        ok: false,
        error: "Can't demote the last admin. Promote someone else first.",
      };
    }
  }

  const sb = adminClient();
  const { error } = await sb
    .from("profiles")
    .update({ role, is_admin: role === "admin" })
    .eq("user_id", input.user_id);
  if (error) return { ok: false, error: error.message };

  invalidateProfileCache(input.user_id);
  await audit({
    actor: input.actor,
    action: "change_role",
    target_user_id: input.user_id,
    target_email: current.email,
    detail: { from: current.role, to: role },
  });
  return { ok: true };
}

/** Admin-set password reset for a provisioned account. */
export async function resetUserPassword(input: {
  user_id: string;
  password: string;
  actor: ActorMeta;
}): Promise<Result> {
  const pwErr = validatePassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };
  const current = await getRow(input.user_id);
  if (!current) return { ok: false, error: "User not found." };

  const sb = adminClient();
  const { error } = await sb.auth.admin.updateUserById(input.user_id, {
    password: input.password,
  });
  if (error) return { ok: false, error: error.message };

  await audit({
    actor: input.actor,
    action: "reset_password",
    target_user_id: input.user_id,
    target_email: current.email,
  });
  return { ok: true };
}

/** Activate / deactivate an account. Deactivate = lockout on next request. */
export async function setUserActive(input: {
  user_id: string;
  is_active: boolean;
  actor: ActorMeta;
}): Promise<Result> {
  const current = await getRow(input.user_id);
  if (!current) return { ok: false, error: "User not found." };
  if (current.is_active === input.is_active) return { ok: true };

  if (!input.is_active) {
    // Block deactivating self, and the last active admin.
    if (input.user_id === input.actor.user_id) {
      return { ok: false, error: "You can't deactivate your own account." };
    }
    if (current.role === "admin" && (await activeAdminCount()) <= 1) {
      return {
        ok: false,
        error: "Can't deactivate the last admin.",
      };
    }
  }

  const sb = adminClient();
  const { error } = await sb
    .from("profiles")
    .update({ is_active: input.is_active })
    .eq("user_id", input.user_id);
  if (error) return { ok: false, error: error.message };

  // Best-effort: revoke the user's active sessions so a deactivation takes
  // hold immediately rather than after the profile-cache TTL. Ignored if the
  // SDK/plan doesn't support it — the layout's is_active re-check still locks
  // them out within 30s regardless.
  if (!input.is_active) {
    try {
      const adminApi = sb.auth.admin as unknown as {
        signOut?: (userId: string, scope?: string) => Promise<unknown>;
      };
      await adminApi.signOut?.(input.user_id, "global");
    } catch {
      /* non-fatal */
    }
  }

  invalidateProfileCache(input.user_id);
  await audit({
    actor: input.actor,
    action: "set_active",
    target_user_id: input.user_id,
    target_email: current.email,
    detail: { is_active: input.is_active },
  });
  return { ok: true };
}
