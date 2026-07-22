import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import {
  createPasswordUser,
  listManagedUsers,
  type ActorMeta,
} from "@/lib/auth/user-management";

/**
 * Settings → Access: list + provision users.
 *   GET  → all accounts (admin-only)
 *   POST → create an email+password account { email, password, full_name, role }
 *
 * Admin-only. Every write is audited in access_audit by the lib layer.
 */

export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<
  { ok: true; actor: ActorMeta } | { ok: false; status: number }
> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return { ok: false, status: 401 };
  const profile = await getProfileByUserId(data.user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email));
  if (role !== "admin") return { ok: false, status: 403 };
  return {
    ok: true,
    actor: { user_id: data.user.id, email: data.user.email ?? profile?.email ?? "" },
  };
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.status === 401 ? "unauthorized" : "forbidden" },
      { status: gate.status }
    );
  }
  const users = await listManagedUsers();
  return NextResponse.json({ users });
}

export async function POST(request: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.status === 401 ? "unauthorized" : "forbidden" },
      { status: gate.status }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const result = await createPasswordUser({
    email: String(body.email ?? ""),
    password: String(body.password ?? ""),
    full_name: body.full_name ? String(body.full_name) : null,
    role: normalizeRole(String(body.role ?? "rep")),
    actor: gate.actor,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.code === "exists" ? 409 : 400 }
    );
  }
  return NextResponse.json({ ok: true, user_id: result.user_id });
}
