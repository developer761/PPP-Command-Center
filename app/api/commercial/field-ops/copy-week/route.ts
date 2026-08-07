import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { copyWeekForward } from "@/lib/commercial/field-ops/schedule";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/commercial/field-ops/copy-week — duplicate a week's schedule to the
 * following week. Admin-gated. Body: { source_monday: "YYYY-MM-DD" }.
 * Returns the copied/skipped counts. Does not email (bulk).
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
  const source_monday = String(body.source_monday ?? "");
  if (!DATE_RE.test(source_monday)) return NextResponse.json({ error: "invalid_date" }, { status: 400 });

  const res = await copyWeekForward(source_monday, data.user.id);
  if (!res.ok) return NextResponse.json({ error: "copy_failed", detail: res.error }, { status: 400 });
  return NextResponse.json(res);
}
