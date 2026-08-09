import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail } from "@/lib/auth/admin";
import { verifyEmployeePin } from "@/lib/commercial/field-ops/employees";
import { clockIn, clockOut, getEmployeeDay } from "@/lib/commercial/field-ops/clock";
import { todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/commercial/field-ops/kiosk-clock - the Clock Station backup. Runs on
 * a shared, logged-in staff device (commercial session = the device), and the
 * painter proves identity with their 4-digit PIN. Body:
 *   { employee_id, pin, action: "in" | "out" | "day", job_id? }
 * "day" returns the painter's today (after PIN) so the kiosk can show their jobs.
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
  // Kiosk = the office/shop TABLET (an admin session); crew clock via their
  // login-less magic link, not this endpoint. Restrict to admins so a non-admin
  // commercial user can't brute-force a 4-digit PIN to clock other people (payroll
  // fraud) — audit round 2.
  const isAdmin = (profile as { is_admin?: boolean } | null)?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const employeeId = String(body.employee_id ?? "");
  const pin = String(body.pin ?? "");
  const action = String(body.action ?? "");
  if (!UUID_RE.test(employeeId)) return NextResponse.json({ error: "invalid_employee" }, { status: 400 });

  if (!(await verifyEmployeePin(employeeId, pin))) {
    return NextResponse.json({ error: "bad_pin", detail: "Wrong PIN." }, { status: 401 });
  }

  if (action === "day") {
    const day = await getEmployeeDay(employeeId, todayEtIso());
    return NextResponse.json({ ok: true, day });
  }
  if (action === "out") {
    const r = await clockOut({ employee_id: employeeId, source: "kiosk" });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "clock_failed", detail: r.error }, { status: 400 });
  }
  if (action === "in") {
    const job_id = String(body.job_id ?? "");
    const assignment_id = body.assignment_id ? String(body.assignment_id) : null;
    if (!UUID_RE.test(job_id)) return NextResponse.json({ error: "invalid_job" }, { status: 400 });
    const r = await clockIn({
      employee_id: employeeId,
      job_id,
      assignment_id: assignment_id && UUID_RE.test(assignment_id) ? assignment_id : null,
      source: "kiosk",
    });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "clock_failed", detail: r.error }, { status: 400 });
  }
  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
