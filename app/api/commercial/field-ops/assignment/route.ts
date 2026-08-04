import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { setAssignmentHours } from "@/lib/commercial/field-ops/schedule";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

/**
 * POST /api/commercial/field-ops/assignment - set one Week-Grid cell's scheduled
 * hours. Body: { job_id, employee_id, work_date, hours }. hours<=0 clears it.
 * Admin-gated (scheduler role enforcement lands later).
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
  const job_id = String(body.job_id ?? "");
  const employee_id = String(body.employee_id ?? "");
  const work_date = String(body.work_date ?? "");
  const hours = Number(body.hours ?? 0);
  if (!UUID_RE.test(job_id) || !UUID_RE.test(employee_id)) {
    return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(work_date)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    return NextResponse.json({ error: "invalid_hours", detail: "Hours must be 0-24." }, { status: 400 });
  }

  const result = await setAssignmentHours({
    job_id,
    employee_id,
    work_date,
    hours,
    actor_user_id: data.user.id,
  });
  if (!result.ok) return NextResponse.json({ error: "save_failed", detail: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, assignmentId: result.assignmentId });
}
