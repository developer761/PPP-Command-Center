import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import {
  resetUserPassword,
  setUserActive,
  updateUserRole,
  type ActorMeta,
} from "@/lib/auth/user-management";

/**
 * Settings → Access: mutate a single account.
 *   PATCH { action: "role", role }            → change role
 *   PATCH { action: "active", is_active }      → activate / deactivate
 *   PATCH { action: "reset_password", password } → admin-set new password
 *
 * Admin-only. Safety rails (last admin, self-lockout) live in the lib layer.
 */

export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<
  { ok: true; actor: ActorMeta } | { ok: false; status: number }
> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return { ok: false, status: 401 };
  const profile = await getProfileByUserId(data.user.id);
  // Deactivation must bite the API too (see access/route.ts). Bootstrap admins
  // exempt (anti-brick), matching the dashboard layout gate.
  if (profile && profile.is_active === false && !isAdminEmail(data.user.email)) {
    return { ok: false, status: 403 };
  }
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email));
  if (role !== "admin") return { ok: false, status: 403 };
  return {
    ok: true,
    actor: { user_id: data.user.id, email: data.user.email ?? profile?.email ?? "" },
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const gate = await requireAdmin();
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.status === 401 ? "unauthorized" : "forbidden" },
      { status: gate.status }
    );
  }

  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ error: "Missing user id." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const action = String(body.action ?? "");

  if (action === "role") {
    const r = await updateUserRole({
      user_id: userId,
      role: normalizeRole(String(body.role ?? "")),
      actor: gate.actor,
    });
    return r.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: r.error }, { status: 400 });
  }

  if (action === "active") {
    const r = await setUserActive({
      user_id: userId,
      is_active: body.is_active === true,
      actor: gate.actor,
    });
    return r.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: r.error }, { status: 400 });
  }

  if (action === "reset_password") {
    const r = await resetUserPassword({
      user_id: userId,
      password: String(body.password ?? ""),
      actor: gate.actor,
    });
    return r.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: r.error }, { status: 400 });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
