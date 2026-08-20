import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail } from "@/lib/auth/admin";
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
  if ((await apiAccessDenied(data?.user?.id, profile))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // `is_admin ?? isAdminEmail` — the same resolution the field-ops pages use.
  // Checking the column alone 403s an env-allowlisted admin whose
  // `profiles.is_admin` is still NULL, even though the calendar rendered for
  // them, so every scheduling action failed with no visible reason.
  if (!((profile as { is_admin?: boolean | null } | null)?.is_admin ?? isAdminEmail(data.user.email))) {
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

  // Confirm step (Karan 2026-08): the first call returns needsConfirm + the crew
  // who were off this week; the client re-calls with acknowledge_off_crew=true and
  // an optional exclude_employee_ids for anyone NOT working next week.
  const acknowledge_off_crew = body.acknowledge_off_crew === true;
  const exclude_employee_ids = Array.isArray(body.exclude_employee_ids)
    ? (body.exclude_employee_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  const res = await copyWeekForward(source_monday, data.user.id, {
    acknowledgeOffCrew: acknowledge_off_crew,
    excludeEmployeeIds: exclude_employee_ids,
  });
  if (!res.ok) return NextResponse.json({ error: "copy_failed", detail: res.error }, { status: 400 });
  return NextResponse.json(res);
}
