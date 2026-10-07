import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, logViewAs, invalidateProfileCache } from "@/lib/auth/profile";
import { roleForProfile } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { PROXY_COOKIE, PROXY_COOKIE_OPTIONS, readProxyCookie } from "@/lib/auth/proxy";

/**
 * Start and stop a proxy login (Katie, 2026-09-29 — "log in as them and see
 * their view", the way Salesforce does).
 *
 * POST   { targetUserId }  → become that user for this browser session
 * DELETE                   → go back to being yourself
 *
 * Every check here reads the caller's REAL profile (`ignoreProxy: true`).
 * Without that, one proxy into an admin would be enough to start another, and
 * — worse — a proxy into a rep could never be stopped, because the caller
 * would no longer look like an admin to the route that ends it.
 */

async function requireRealAdmin() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

  const profile = await getProfileByUserId(data.user.id, { ignoreProxy: true });
  const role = roleForProfile(profile, isAdminEmail(data.user.email));
  if (role !== "admin" || profile?.is_active === false) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user: data.user, profile };
}

export async function POST(request: Request) {
  const gate = await requireRealAdmin();
  if ("error" in gate) return gate.error;

  let body: { targetUserId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const targetUserId = String(body.targetUserId ?? "").trim();
  if (!targetUserId) {
    return NextResponse.json({ error: "missing_target" }, { status: 400 });
  }
  if (targetUserId === gate.user.id) {
    // Not an error worth a red banner — you are already yourself.
    return NextResponse.json({ ok: true, alreadyYou: true });
  }

  // The target has to exist. Looked up with the proxy ignored, or starting a
  // second proxy from inside the first would resolve the wrong person.
  const target = await getProfileByUserId(targetUserId, { ignoreProxy: true });
  if (!target) {
    return NextResponse.json({ error: "no_such_user" }, { status: 404 });
  }
  if (target.is_active === false) {
    return NextResponse.json(
      { error: "inactive_user", message: "That account is deactivated. Reactivate it in Access first." },
      { status: 400 }
    );
  }

  const jar = await cookies();
  jar.set(PROXY_COOKIE, targetUserId, PROXY_COOKIE_OPTIONS);
  // The 30-second profile cache would otherwise keep answering as the admin
  // for the first half-minute of the proxy.
  invalidateProfileCache(gate.user.id);

  void logViewAs({
    admin_user_id: gate.user.id,
    admin_email: gate.profile?.email ?? gate.user.email ?? "",
    // The column predates proxy login and is named for Salesforce ids; it is
    // TEXT, and what matters is that the row names WHO was proxied.
    target_sf_user_id: target.sf_user_id || targetUserId,
    target_label: target.full_name || target.email || targetUserId,
    action: "proxy_start",
    path: new URL(request.url).pathname,
    user_agent: request.headers.get("user-agent"),
    ip_address: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return NextResponse.json({
    ok: true,
    target: { id: targetUserId, name: target.full_name || target.email, role: target.role },
  });
}

export async function DELETE(request: Request) {
  // Deliberately NOT admin-gated the same way: whoever holds a proxy cookie
  // must always be able to drop it. The cookie is the only thing being
  // cleared, and clearing it can only ever return somebody to themselves.
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const wasProxying = await readProxyCookie();
  const jar = await cookies();
  jar.delete(PROXY_COOKIE);
  invalidateProfileCache(data.user.id);

  if (wasProxying) {
    const real = await getProfileByUserId(data.user.id, { ignoreProxy: true });
    void logViewAs({
      admin_user_id: data.user.id,
      admin_email: real?.email ?? data.user.email ?? "",
      target_sf_user_id: wasProxying,
      target_label: null,
      action: "proxy_end",
      path: new URL(request.url).pathname,
      user_agent: request.headers.get("user-agent"),
      ip_address: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
  }

  return NextResponse.json({ ok: true });
}
