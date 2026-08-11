import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getDaySchedule } from "@/lib/commercial/field-ops/schedule";
import { getEmployeeDay } from "@/lib/commercial/field-ops/clock";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/commercial/field-ops/person-day?employee_id=&date= — powers the
 * Calendar's "click a name" popup: that person's shift(s) for the day (work
 * order + times + note) plus their LIVE clock status. Admin-gated.
 */
export async function GET(request: Request) {
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
  if (!(profile as { is_admin?: boolean } | null)?.is_admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const employeeId = url.searchParams.get("employee_id") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!UUID_RE.test(employeeId) || !DATE_RE.test(date)) {
    return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  }

  const [day, clock] = await Promise.all([getDaySchedule(date), getEmployeeDay(employeeId, date)]);
  const shifts = day
    .filter((a) => a.employee_id === employeeId)
    .map((a) => ({
      assignment_id: a.assignment_id,
      job_name: a.job_name,
      job_code: a.job_code,
      job_status: a.job_status,
      prevailing_wage: a.prevailing_wage,
      site: a.site,
      start_time: a.start_time,
      end_time: a.end_time,
      scheduled_hours: a.scheduled_hours,
      note: a.note,
    }));
  const totalHours = Object.values(clock.hoursByJob).reduce((s, h) => s + h, 0);

  return NextResponse.json({
    ok: true,
    employee_name: shifts.length > 0 ? day.find((a) => a.employee_id === employeeId)?.employee_name ?? null : null,
    shifts,
    clock: {
      open: !!clock.openPunch,
      since: clock.openPunch?.clock_in_at ?? null,
      total_hours: Math.round(totalHours * 100) / 100,
    },
  });
}
