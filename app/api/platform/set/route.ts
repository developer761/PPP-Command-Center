import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import {
  PLATFORM_COOKIE,
  PLATFORM_COOKIE_MAX_AGE_SECONDS,
  isPlatform,
} from "@/lib/platform-cookie";

/**
 * POST /api/platform/set
 * Body: { platform: "command_center" | "new_platform" }
 *
 * Sets the user's last-platform cookie and redirects to that platform's
 * dashboard. Guarded by the user's actual access flags — a user can't
 * force a platform they don't have access to (would 403 on the dashboard
 * anyway, but rejecting at the cookie step keeps the cookie honest).
 */

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { platform?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!isPlatform(body.platform)) {
    return NextResponse.json({ error: "bad_platform" }, { status: 400 });
  }

  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (body.platform === "command_center" && !access.hasCommandCenter) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (body.platform === "new_platform" && !access.hasNewPlatform) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const target = body.platform === "command_center" ? "/dashboard" : "/dashboard/commercial";
  const res = NextResponse.json({ ok: true, redirect: target });
  res.cookies.set(PLATFORM_COOKIE, body.platform, {
    path: "/",
    maxAge: PLATFORM_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false, // readable client-side so the sidebar can show the current platform
  });
  return res;
}
