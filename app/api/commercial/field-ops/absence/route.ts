import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail } from "@/lib/auth/admin";
import { upsertAbsence, deleteAbsence } from "@/lib/commercial/field-ops/absences";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/commercial/field-ops/absence — mark/unmark a crew member off.
 * Admin-gated. Body:
 *   { op: "upsert", employee_id, work_date, type, hours?, note? }
 *   { op: "delete", absence_id }
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
    const absence_id = String(body.absence_id ?? "");
    if (!UUID_RE.test(absence_id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
    const res = await deleteAbsence(absence_id, data.user.id);
    if (!res.ok) return NextResponse.json({ error: "delete_failed", detail: res.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const employee_id = String(body.employee_id ?? "");
  const work_date = String(body.work_date ?? "");
  const type = String(body.type ?? "");
  const hours = body.hours != null && body.hours !== "" ? Number(body.hours) : null;
  const note = body.note ? String(body.note) : "";
  if (!UUID_RE.test(employee_id)) return NextResponse.json({ error: "invalid_id", detail: "Pick a crew member." }, { status: 400 });
  if (!DATE_RE.test(work_date)) return NextResponse.json({ error: "invalid_date" }, { status: 400 });

  const res = await upsertAbsence({ employee_id, work_date, type, hours, note, actor_user_id: data.user.id });
  if (!res.ok) return NextResponse.json({ error: "save_failed", detail: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, id: res.id });
}
