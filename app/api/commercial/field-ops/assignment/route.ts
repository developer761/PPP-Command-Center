import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail } from "@/lib/auth/admin";
import { upsertAssignment, deleteAssignmentById } from "@/lib/commercial/field-ops/schedule";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;

/**
 * POST /api/commercial/field-ops/assignment — the interactive Calendar's write
 * endpoint. Admin-gated. Body:
 *   { op: "upsert", job_id, employee_id, work_date, start_time?, end_time?, note? }
 *   { op: "delete", assignment_id }
 * upsert emails the crew member their shift + schedules their clock-in nudge.
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
  const op = String(body.op ?? "upsert");

  if (op === "delete") {
    const assignment_id = String(body.assignment_id ?? "");
    if (!UUID_RE.test(assignment_id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
    const res = await deleteAssignmentById(assignment_id, data.user.id);
    if (!res.ok) return NextResponse.json({ error: "delete_failed", detail: res.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const job_id = String(body.job_id ?? "");
  const employee_id = String(body.employee_id ?? "");
  const work_date = String(body.work_date ?? "");
  const start_time = body.start_time ? String(body.start_time) : "";
  const end_time = body.end_time ? String(body.end_time) : "";
  const note = body.note ? String(body.note) : "";
  if (!UUID_RE.test(job_id) || !UUID_RE.test(employee_id)) {
    return NextResponse.json({ error: "invalid_ids", detail: "Pick a crew member and a work order." }, { status: 400 });
  }
  if (!DATE_RE.test(work_date)) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  if (start_time && !TIME_RE.test(start_time)) return NextResponse.json({ error: "invalid_time" }, { status: 400 });
  if (end_time && !TIME_RE.test(end_time)) return NextResponse.json({ error: "invalid_time" }, { status: 400 });

  const res = await upsertAssignment({
    job_id,
    employee_id,
    work_date,
    start_time,
    end_time,
    note,
    actor_user_id: data.user.id,
  });
  if (!res.ok) return NextResponse.json({ error: "save_failed", detail: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, assignmentId: res.assignmentId });
}
