import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { copyWeekForward } from "@/lib/commercial/field-ops/schedule";

export const runtime = "nodejs";

/**
 * POST /api/commercial/field-ops/copy-week - copy a week's assignments forward
 * 7 days (skips cells next week that already have an assignment). Admin-gated.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active, is_admin")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (rawAccessDenied(profile)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!(profile as { is_admin?: boolean } | null)?.is_admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const week_start = String(body.week_start ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const result = await copyWeekForward(week_start, data.user.id);
  if (!result.ok) return NextResponse.json({ error: "copy_failed", detail: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, copied: result.copied });
}
